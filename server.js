import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing.");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});
const MODEL = "gemini-3.5-flash-lite";
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


/* =========================
   FFMPEG
========================= */

function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-i",
      inputPath,

      "-vn",

      "-ac",
      "1",

      "-ar",
      "16000",

      // Small speech-optimized MP3
      "-b:a",
      "24k",

      outputPath
    ]);

    let stderr = "";

    ffmpeg.stderr.on("data", data => {
      stderr += data.toString();
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            "FFmpeg failed: " + stderr.slice(-1200)
          )
        );
      }
    });
  });
}


/* =========================
   CLEAN SRT
========================= */

function cleanSrt(text) {
  if (!text) {
    throw new Error("AI returned empty result.");
  }

  let srt = String(text).trim();

  // Remove markdown fences
  srt = srt
    .replace(/^```srt\s*/i, "")
    .replace(/^```text\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Find first subtitle number
  const first = srt.search(
    /\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/
  );

  if (first > 0) {
    srt = srt.slice(first);
  }

  return srt.trim();
}


/* =========================
   GENERATE SRT
========================= */

async function generateSrt(
  audioPath,
  sourceLanguage,
  targetLanguage
) {
  const audioSize = fs.statSync(audioPath).size;

  const prompt = `
You are a professional subtitle generator.

Listen to the ENTIRE audio.

SOURCE LANGUAGE:
${sourceLanguage}

TARGET LANGUAGE:
${targetLanguage}

TASK:
Create a complete SRT subtitle file.

IMPORTANT:

- Process the whole audio from beginning to end.
- Do not skip spoken sentences.
- Detect the actual timing of speech from the audio.
- Use accurate start and end timestamps.
- Translate naturally into the target language.
- If target language is Myanmar (Burmese), use natural Myanmar Unicode.
- Keep subtitles short and easy to read.
- Do not invent dialogue.
- Do not summarize.
- Do not explain anything.
- Do not add a title.
- Do not use Markdown.
- Do not use code fences.

Return ONLY valid SRT.

Required format:

1
00:00:00,000 --> 00:00:02,500
Translated subtitle

2
00:00:02,500 --> 00:00:05,000
Translated subtitle

Continue until the END of the audio.
`;

  /*
    For small audio files we send the audio directly.
    This avoids an additional Files API upload.
  */

  if (audioSize <= 18 * 1024 * 1024) {

    const audioBase64 = fs.readFileSync(
      audioPath
    ).toString("base64");

    const response = await ai.models.generateContent({
      model: MODEL,

      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt
            },
            {
              inlineData: {
                mimeType: "audio/mpeg",
                data: audioBase64
              }
            }
          ]
        }
      ],

      config: {
        thinkingConfig: {
          thinkingLevel: "low"
        },

        temperature: 0.1,

        maxOutputTokens: 65536
      }
    });

    return cleanSrt(response.text);
  }


  /*
    If the extracted audio is larger,
    use Google's File API.
  */

  console.log(
    "Audio is larger than 18MB. Using Gemini Files API."
  );

  const uploaded = await ai.files.upload({
    file: audioPath,
    config: {
      mimeType: "audio/mpeg"
    }
  });

  if (!uploaded?.uri) {
    throw new Error(
      "Gemini audio upload failed."
    );
  }

  const response = await ai.models.generateContent({
    model: MODEL,

    contents: [
      prompt,
      uploaded
    ],

    config: {
      thinkingConfig: {
        thinkingLevel: "low"
      },

      temperature: 0.1,

      maxOutputTokens: 65536
    }
  });

  return cleanSrt(response.text);
}


/* =========================
   MAIN API
========================= */

app.post(
  "/api/generate-srt",
  upload.single("media"),
  async (req, res) => {

    let audioPath = null;
    let videoPath = null;

    try {

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "Please upload a video file."
        });
      }

      videoPath = req.file.path;

      const sourceLanguage =
        req.body?.sourceLanguage ||
        "Auto detect";

      const targetLanguage =
        req.body?.targetLanguage ||
        "Myanmar (Burmese)";

      console.log(
        "Received:",
        req.file.originalname
      );

      console.log(
        "Source:",
        sourceLanguage
      );

      console.log(
        "Target:",
        targetLanguage
      );

      /*
        Create temporary audio file.
      */

      audioPath = path.join(
        os.tmpdir(),
        `${randomUUID()}.mp3`
      );

      console.log(
        "Extracting audio..."
      );

      await extractAudio(
        videoPath,
        audioPath
      );

      console.log(
        "Audio ready:",
        fs.statSync(audioPath).size,
        "bytes"
      );

      console.log(
        "Sending audio to Gemini..."
      );

      const srt = await generateSrt(
        audioPath,
        sourceLanguage,
        targetLanguage
      );

      console.log(
        "SRT generated."
      );

      return res.json({
        ok: true,
        srt
      });

    } catch (error) {

      console.error(
        "SRT ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          String(error)
      });

    } finally {

      try {
        if (
          videoPath &&
          fs.existsSync(videoPath)
        ) {
          fs.unlinkSync(videoPath);
        }
      } catch {}

      try {
        if (
          audioPath &&
          fs.existsSync(audioPath)
        ) {
          fs.unlinkSync(audioPath);
        }
      } catch {}
    }
  }
);


/* =========================
   HEALTH
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    model: MODEL
  });
});


/* =========================
   WEBSITE
========================= */

app.use(
  express.static(process.cwd())
);


/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(
    `Video-to-SRT running on port ${PORT}`
  );
});
