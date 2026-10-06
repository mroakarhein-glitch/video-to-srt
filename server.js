import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  dest: path.join(os.tmpdir(), 'video-srt-uploads'),
  limits: {
    fileSize: 100 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'audio/mpeg',
      'audio/mp4',
      'audio/x-m4a',
      'audio/wav',
      'audio/x-wav',
      'audio/webm'
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported video or audio format.'));
    }
  }
});

app.use(express.static(__dirname));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanSrt(text) {
  let out = String(text || '').trim();

  out = out
    .replace(/^```srt\s*/i, '')
    .replace(/^```text\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  return out;
}

function isRetryableError(err) {
  const message = String(err?.message || err).toLowerCase();

  return (
    message.includes('503') ||
    message.includes('unavailable') ||
    message.includes('high demand') ||
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('temporarily')
  );
}

async function generateWithRetry(
  ai,
  uploadedFile,
  prompt,
  model,
  attempts = 3
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(
        `Trying Gemini model ${model} - attempt ${attempt}/${attempts}`
      );

      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: prompt
              },
              {
                fileData: {
                  fileUri: uploadedFile.uri,
                  mimeType:
                    uploadedFile.mimeType || 'video/mp4'
                }
              }
            ]
          }
        ]
      });

      console.log(
        `Gemini ${model} succeeded on attempt ${attempt}.`
      );

      return response;

    } catch (err) {
      lastError = err;

      console.error(
        `Gemini ${model} attempt ${attempt} failed:`,
        err?.message || err
      );

      if (!isRetryableError(err)) {
        throw err;
      }

      if (attempt < attempts) {
        const waitTime = 5000 * Math.pow(2, attempt - 1);

        console.log(
          `Waiting ${waitTime / 1000}s before retry...`
        );

        await sleep(waitTime);
      }
    }
  }

  throw lastError;
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post(
  '/api/generate-srt',
  upload.single('media'),
  async (req, res) => {

    const file = req.file;

    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({
          error: 'Server is missing GEMINI_API_KEY.'
        });
      }

      if (!file) {
        return res.status(400).json({
          error:
            'Please upload a supported video or audio file.'
        });
      }

      const targetLanguage = (
        req.body.targetLanguage ||
        'Myanmar (Burmese)'
      ).slice(0, 60);

      const sourceLanguage = (
        req.body.sourceLanguage ||
        'Auto detect'
      ).slice(0, 60);

      console.log('--------------------------------');
      console.log('Uploaded file:', file.originalname);
      console.log('File size:', file.size);
      console.log('MIME:', file.mimetype);
      console.log('Source:', sourceLanguage);
      console.log('Target:', targetLanguage);
      console.log('--------------------------------');

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY
      });

      console.log(
        'Uploading media to Gemini Files API...'
      );

      let uploadedFile = await ai.files.upload({
        file: file.path,
        config: {
          mimeType: file.mimetype,
          displayName: file.originalname
        }
      });

      console.log(
        'Gemini file:',
        uploadedFile.name
      );

      console.log(
        'Initial state:',
        String(uploadedFile.state || '')
      );

      while (
        uploadedFile.state &&
        String(uploadedFile.state).toUpperCase() !==
          'ACTIVE'
      ) {

        const state = String(
          uploadedFile.state || ''
        ).toUpperCase();

        if (state === 'FAILED') {
          throw new Error(
            'Gemini failed to process the uploaded media.'
          );
        }

        console.log(
          'Gemini processing media:',
          state
        );

        await sleep(5000);

        uploadedFile = await ai.files.get({
          name: uploadedFile.name
        });
      }

      console.log(
        'Gemini media is ACTIVE.'
      );

      const prompt = `
You are a professional subtitle transcription and translation system.

TASK:

1. Listen carefully to ALL spoken dialogue in the uploaded media.
2. Transcribe the actual spoken words.
3. Source language: ${sourceLanguage}.
4. Target subtitle language: ${targetLanguage}.
5. If source language is "Auto detect", identify the spoken language yourself.
6. Translate naturally and accurately into the target language.
7. Preserve original meaning, names, places and important terminology.
8. Do NOT invent dialogue.
9. Do NOT summarize.
10. Do NOT omit important spoken sentences.
11. For Myanmar subtitles, use natural Myanmar Unicode.
12. Do NOT use Zawgyi.
13. Keep subtitle sentences natural and easy to read.
14. Normally use 1-2 short lines per subtitle.
15. Split long dialogue into reasonable subtitle cues.
16. Use sequential subtitle numbers.
17. Every subtitle cue MUST have a valid timestamp.
18. Timestamp format MUST be exactly:

HH:MM:SS,mmm --> HH:MM:SS,mmm

19. Timing should follow the actual speech as accurately as possible.
20. Return ONLY the SRT content.
21. Do NOT return Markdown.
22. Do NOT use a code block.
23. Do NOT add explanations before or after the SRT.

Example:

1
00:00:01,000 --> 00:00:03,500
မြန်မာစာတန်းထိုး

2
00:00:03,600 --> 00:00:06,800
နောက်စာကြောင်း
`;

      let response;

      /*
       * PRIMARY MODEL
       * Gemini 3.8 Flash
       */
      try {

        response = await generateWithRetry(
          ai,
          uploadedFile,
          prompt,
          'gemini-3.8-flash',
          3
        );

      } catch (primaryError) {

        console.error(
          'Primary model failed:',
          primaryError?.message || primaryError
        );

        /*
         * FALLBACK MODEL
         * Gemini 3.7 Flash
         */
        console.log(
          'Switching to fallback model: gemini-3.7-flash'
        );

        response = await generateWithRetry(
          ai,
          uploadedFile,
          prompt,
          'gemini-3.7-flash',
          2
        );
      }

      const srt = cleanSrt(response.text);

      if (!srt) {
        throw new Error(
          'Gemini returned an empty response.'
        );
      }

      const hasTimestamp =
        /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/
          .test(srt);

      if (!hasTimestamp) {

        console.error(
          'Invalid SRT returned by Gemini:',
          srt
        );

        return res.status(502).json({
          error:
            'AI did not return valid SRT timestamps. Please try again.'
        });
      }

      console.log(
        'SRT generated successfully.'
      );

      return res.json({
        success: true,
        srt
      });

    } catch (err) {

      console.error(
        'FINAL SRT ERROR:',
        err
      );

      const message =
        String(err?.message || err);

      const lower =
        message.toLowerCase();

      if (
        lower.includes('503') ||
        lower.includes('unavailable') ||
        lower.includes('high demand')
      ) {
        return res.status(503).json({
          error:
            'Gemini is currently busy. The system already retried and switched models. Please try again shortly.'
        });
      }

      if (
        lower.includes('429') ||
        lower.includes('resource_exhausted')
      ) {
        return res.status(429).json({
          error:
            'Gemini API limit has been reached. Please wait and try again later.'
        });
      }

      if (
        lower.includes('401') ||
        lower.includes('403') ||
        lower.includes('api key')
      ) {
        return res.status(500).json({
          error:
            'Gemini API authentication failed. Please check the server API key.'
        });
      }

      return res.status(500).json({
        error:
          message ||
          'Failed to generate subtitles.'
      });

    } finally {

      if (file?.path) {
        fs.promises
          .unlink(file.path)
          .catch(() => {});
      }
    }
  }
);

app.use(
  (err, _req, res, _next) => {

    console.error(
      'UPLOAD ERROR:',
      err
    );

    if (
      err?.code === 'LIMIT_FILE_SIZE'
    ) {
      return res.status(413).json({
        error:
          'File is too large. Maximum size is 100MB.'
      });
    }

    return res.status(400).json({
      error:
        err?.message ||
        'Upload failed.'
    });
  }
);

app.listen(PORT, () => {

  console.log(
    `Video to SRT running on port ${PORT}`
  );

});
