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

/* Serve website */
app.use(express.static(__dirname));

/* Clean Gemini response */
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

/* Home page */
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* Generate SRT */
app.post('/api/generate-srt', upload.single('media'), async (req, res) => {
  const file = req.file;

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'Server is missing GEMINI_API_KEY.'
      });
    }

    if (!file) {
      return res.status(400).json({
        error: 'Please upload a supported video or audio file.'
      });
    }

    const targetLanguage = (
      req.body.targetLanguage || 'Myanmar (Burmese)'
    ).slice(0, 60);

    const sourceLanguage = (
      req.body.sourceLanguage || 'Auto detect'
    ).slice(0, 60);

    console.log('Uploaded file:', file.originalname);
    console.log('File size:', file.size);
    console.log('MIME:', file.mimetype);
    console.log('Source language:', sourceLanguage);
    console.log('Target language:', targetLanguage);

    /* Gemini client */
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    /*
      Upload the video/audio to Gemini Files API.
      This is better for larger media files than sending
      the whole file as inline base64.
    */
    console.log('Uploading media to Gemini Files API...');

    let uploadedFile = await ai.files.upload({
      file: file.path,
      config: {
        mimeType: file.mimetype,
        displayName: file.originalname
      }
    });

    console.log('Gemini file:', uploadedFile.name);
    console.log('Initial state:', uploadedFile.state);

    /*
      Wait until Gemini finishes processing the media.
    */
    while (
      uploadedFile.state &&
      uploadedFile.state.toString() !== 'ACTIVE'
    ) {
      if (uploadedFile.state.toString() === 'FAILED') {
        throw new Error('Gemini failed to process the uploaded media.');
      }

      console.log(
        'Gemini is processing media...',
        uploadedFile.state.toString()
      );

      await new Promise(resolve => setTimeout(resolve, 5000));

      uploadedFile = await ai.files.get({
        name: uploadedFile.name
      });
    }

    console.log('Gemini media is ACTIVE.');

    const prompt = `
You are a professional subtitle transcription and translation system.

TASK:

1. Listen carefully to ALL spoken dialogue in the uploaded media.
2. Transcribe the actual spoken words.
3. Source language: ${sourceLanguage}.
4. Target subtitle language: ${targetLanguage}.
5. If source language is "Auto detect", identify the spoken language yourself.
6. Translate naturally and accurately into the target language.
7. Preserve the original meaning, names, places and important terminology.
8. Do NOT invent dialogue that is not actually spoken.
9. Do NOT summarize the dialogue.
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

19. Subtitle timing must follow the actual speech in the video as accurately as possible.
20. Return ONLY the SRT content.
21. Do NOT return Markdown.
22. Do NOT put the SRT inside a code block.
23. Do NOT add explanations before or after the SRT.

Example format:

1
00:00:01,000 --> 00:00:03,500
Myanmar subtitle here.

2
00:00:03,600 --> 00:00:06,800
Next subtitle here.
`;

    console.log('Generating SRT with Gemini 3.8 Flash...');

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
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
                mimeType: uploadedFile.mimeType || file.mimetype
              }
            }
          ]
        }
      ]
    });

    const srt = cleanSrt(response.text);

    if (!srt) {
      throw new Error(
        'Gemini returned an empty response.'
      );
    }

    /*
      Basic SRT validation
    */
    const hasTimestamp =
      /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(
        srt
      );

    if (!hasTimestamp) {
      console.error('Invalid SRT returned by Gemini:', srt);

      return res.status(502).json({
        error:
          'AI did not return valid SRT timestamps. Please try again.'
      });
    }

    console.log('SRT generated successfully.');

    res.json({
      success: true,
      srt
    });

  } catch (err) {
    console.error('SRT ERROR:', err);

    const message = String(err?.message || err);

    if (
      message.includes('503') ||
      message.includes('UNAVAILABLE') ||
      message.includes('high demand')
    ) {
      return res.status(503).json({
        error:
          'Gemini is temporarily busy. Please wait a little and try Generate SRT again.'
      });
    }

    if (
      message.includes('429') ||
      message.includes('RESOURCE_EXHAUSTED')
    ) {
      return res.status(429).json({
        error:
          'Gemini API limit has been reached. Please wait and try again later.'
      });
    }

    if (
      message.includes('401') ||
      message.includes('403') ||
      message.toLowerCase().includes('api key')
    ) {
      return res.status(500).json({
        error:
          'Gemini API authentication failed. Please check the server API key.'
      });
    }

    return res.status(500).json({
      error:
        message || 'Failed to generate subtitles.'
    });

  } finally {
    /*
      Delete temporary uploaded file from Render server.
    */
    if (file?.path) {
      fs.promises.unlink(file.path).catch(() => {});
    }
  }
});

/* Upload / Multer errors */
app.use((err, _req, res, _next) => {
  console.error('UPLOAD ERROR:', err);

  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'File is too large. Maximum size is 100MB.'
    });
  }

  return res.status(400).json({
    error: err?.message || 'Upload failed.'
  });
});

/* Start server */
app.listen(PORT, () => {
  console.log(
    `Video to SRT running on port ${PORT}`
  );
});
