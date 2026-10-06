```javascript
import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI } from "@google/genai";
import ffmpegPath from "ffmpeg-static";

dotenv.config();

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is missing.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

// ----------------------------------------------------
// CONFIG
// ----------------------------------------------------

const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

const TRANSLATION_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];

// Maximum upload size: 500 MB
const upload = multer({
  dest: path.join(os.tmpdir(), "video-to-srt"),
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});

// ----------------------------------------------------
// BASIC EXPRESS SETUP
// ----------------------------------------------------

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------
// HEALTH CHECK
// ----------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "AI Subtitle Maker",
    status: "live",
    transcriptionModel: TRANSCRIBE_MODEL,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    model: TRANSCRIBE_MODEL,
  });
});

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(text) {
  if (!text) return "";

  return String(text)
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMimeType(file) {
  if (file?.mimetype) {
    return file.mimetype;
  }

  return "application/octet-stream";
}

function getLanguageCode(language) {
  if (!language) return [];

  const value = String(language).toLowerCase();

  if (
    value.includes("auto") ||
    value.includes("detect")
  ) {
    return [];
  }

  if (
    value.includes("chinese") ||
    value.includes("中文")
  ) {
    return ["cmn-Hans-CN"];
  }

  if (
    value.includes("english") ||
    value.includes("အင်္ဂလိပ်")
  ) {
    return ["en-US"];
  }

  if (
    value.includes("thai") ||
    value.includes("ไทย")
  ) {
    return ["th-TH"];
  }

  if (
    value.includes("myanmar") ||
    value.includes("burmese") ||
    value.includes("မြန်မာ")
  ) {
    return ["my-MM"];
  }

  if (
    value.includes("japanese") ||
    value.includes("日本")
  ) {
    return ["ja-JP"];
  }

  if (
    value.includes("korean") ||
    value.includes("한국")
  ) {
    return ["ko-KR"];
  }

  return [];
}

function getTargetLanguageName(language) {
  if (!language) return "Myanmar (Burmese)";

  const value = String(language).toLowerCase();

  if (
    value.includes("myanmar") ||
    value.includes("burmese") ||
    value.includes("မြန်မာ")
  ) {
    return "Myanmar Unicode";
  }

  if (
    value.includes("english") ||
    value.includes("အင်္ဂလိပ်")
  ) {
    return "English";
  }

  if (
    value.includes("chinese") ||
    value.includes("中文")
  ) {
    return "Simplified Chinese";
  }

  if (
    value.includes("thai") ||
    value.includes("ไทย")
  ) {
    return "Thai";
  }

  if (
    value.includes("japanese") ||
    value.includes("日本")
  ) {
    return "Japanese";
  }

  if (
    value.includes("korean") ||
    value.includes("한국")
  ) {
    return "Korean";
  }

  return language;
}

// ----------------------------------------------------
// FILE / DIRECTORY HELPERS
// ----------------------------------------------------

async function ensureDirectory(dir) {
  await fs.promises.mkdir(dir, {
    recursive: true,
  });
}

async function safeDelete(filePath) {
  if (!filePath) return;

  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Ignore cleanup errors.
  }
}

// ----------------------------------------------------
// EXTRACT AUDIO FROM VIDEO
// ----------------------------------------------------

async function extractAudioFromVideo(inputPath) {
  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg is not available on this server."
    );
  }

  const outputPath = path.join(
    os.tmpdir(),
    `subtitle-audio-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.mp3`
  );

  console.log("Extracting audio from uploaded media...");

  await execFileAsync(
    ffmpegPath,
    [
      "-y",
      "-i",
      inputPath,

      // Audio only
      "-vn",

      // MP3
      "-acodec",
      "libmp3lame",

      // Good speech quality without huge files
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      "64k",

      outputPath,
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  console.log("Audio extraction complete:", outputPath);

  return outputPath;
}

// ----------------------------------------------------
// UPLOAD FILE TO GEMINI
// ----------------------------------------------------

async function uploadToGemini(filePath, mimeType) {
  console.log("Uploading audio to Gemini Files API...");

  const uploaded = await ai.files.upload({
    file: filePath,
    config: {
      mimeType,
    },
  });

  if (!uploaded) {
    throw new Error("Gemini Files API returned no file.");
  }

  console.log(
    "Gemini file:",
    uploaded.name || uploaded.uri || "unknown"
  );

  return uploaded;
}

// ----------------------------------------------------
// WAIT FOR GEMINI FILE
// ----------------------------------------------------

async function waitForGeminiFile(fileName) {
  const maxAttempts = 60;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const file = await ai.files.get({
      name: fileName,
    });

    const state =
      file?.state?.toString?.() ||
      file?.state ||
      "UNKNOWN";

    console.log(
      `Gemini processing media: ${state}`
    );

    if (
      state === "ACTIVE" ||
      state === "FileState.ACTIVE"
    ) {
      return file;
    }

    if (
      state === "FAILED" ||
      state === "FileState.FAILED"
    ) {
      throw new Error(
        "Gemini failed while processing the uploaded audio."
      );
    }

    await sleep(2000);
  }

  throw new Error(
    "Gemini media processing timed out."
  );
}

// ----------------------------------------------------
// TRANSCRIPTION
// ----------------------------------------------------

async function transcribeAudio(
  geminiFile,
  sourceLanguage
) {
  const languageCodes =
    getLanguageCode(sourceLanguage);

  console.log(
    "Starting Gemini 3.5 Transcribe..."
  );

  if (languageCodes.length > 0) {
    console.log(
      "Source language:",
      languageCodes.join(", ")
    );
  } else {
    console.log(
      "Source language: automatic detection"
    );
  }

  const config = {
    audioTranscriptionConfig: {
      // VERBATIM is important when timestamps
      // are required.
      mode: "VERBATIM",

      // Word-level timestamps
      wordTimestamp:
```
