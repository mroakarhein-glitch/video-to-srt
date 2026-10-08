import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} from "@google/genai";

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

const MODEL = "gemini-3.8-flash";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const jobs = new Map();

/* =========================
   JOB HELPERS
========================= */

function createJob() {
  const id = randomUUID();

  const job = {
    id,
    progress: 0,
    title: "Starting",
    message: "Preparing your file...",
    status: "running",
    srt: "",
    error: null,
    createdAt: Date.now()
  };

  jobs.set(id, job);

  return job;
}

function updateJob(id, progress, title, message) {
  const job = jobs.get(id);

  if (!job) return;

  job.progress = progress;
  job.title = title;
  job.message = message;
}

function completeJob(id, srt) {
  const job = jobs.get(id);

  if (!job) return;

  job.progress = 100;
  job.title = "Complete";
  job.message = "SRT generation completed successfully.";
  job.status = "complete";
  job.srt = srt;
}

function failJob(id, error) {
  const job = jobs.get(id);

  if (!job) return;

  job.status = "error";
  job.error = String(error);
  job.title = "Error";
  job.message = String(error);
}

setInterval(() => {
  const now = Date.now();

  for (const [id, job] of jobs) {
    if (now - job.createdAt > 30 * 60 * 1000) {
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);


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

      "-b:a",
      "64k",

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
            `FFmpeg audio extraction failed: ${stderr.slice(-1500)}`
          )
        );
      }
    });
  });
}


/* =========================
   SRT CLEANING
========================= */

function cleanSrt(text) {
  if (!text) {
    throw new Error("Gemini returned empty SRT.");
  }

  let srt = text.trim();

  // Remove markdown code fences if Gemini adds them.
  srt = srt
    .replace(/^```srt\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Remove accidental leading text before first subtitle.
  const firstIndex = srt.search(/\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s+-->/);

  if (firstIndex > 0) {
    srt = srt.slice(firstIndex);
  }

  return srt.trim();
}


/* =========================
   GEMINI SRT GENERATION
========================= */

async function generateSrtFromAudio(
  audioPath,
  sourceLanguage,
  targetLanguage,
  onProgress
) {
  onProgress(20, "Uploading", "Uploading audio to Gemini...");

  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: {
      mimeType: "audio/mpeg"
    }
  });

  if (!uploadedFile || !uploadedFile.uri) {
    throw new Error("Gemini file upload failed.");
  }

  onProgress(30, "Preparing AI", "Gemini is preparing the audio...");

  // Wait until Gemini has finished processing the uploaded file.
  let currentFile = uploadedFile;

  while (
    !currentFile.state ||
    String(currentFile.state) !== "ACTIVE"
  ) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    currentFile = await ai.files.get({
      name: currentFile.name
    });
  }

  onProgress(
    38,
    "Transcribing",
    "AI is listening to the speech..."
  );

  const prompt = `
You are an expert subtitle generator.

Create a complete SRT subtitle file from the provided audio.

SOURCE LANGUAGE:
${sourceLanguage}

TARGET LANGUAGE:
${targetLanguage}

IMPORTANT REQUIREMENTS:

1. Listen to the entire audio from beginning to end.
2. Do not skip any spoken content.
3. Detect the actual speech timing from the audio.
4. Create accurate subtitle start and end timestamps.
5. Translate the spoken content into the TARGET LANGUAGE.
6. Preserve the meaning and natural speaking style.
7. For Myanmar/Burmese, use natural Unicode Myanmar text.
8. Keep each subtitle readable.
9. Prefer short subtitle lines.
10. Do not merge unrelated sentences.
11. Do not invent speech that is not present.
12. Do not add explanations.
13. Do not add a title.
14. Do not use Markdown.
15. Do not use code fences.
16. Return ONLY valid SRT.

SRT FORMAT:

1
00:00:00,000 --> 00:00:02,500
Subtitle text

2
00:00:02,500 --> 00:00:05,000
Subtitle text

Continue until the entire audio has been processed.

The final answer MUST be a complete SRT file and nothing else.
`;

  const result = await ai.models.generateContent({
    model: MODEL,

    contents: createUserContent([
      createPartFromUri(
        currentFile.uri,
        currentFile.mimeType || "audio/mpeg"
      ),
      prompt
    ]),

    config: {
      temperature: 0.2,
      maxOutputTokens: 65536
    }
  });

  onProgress(
    88,
    "Building SRT",
    "Formatting subtitle file..."
  );

  const text = result.text;

  if (!text) {
    throw new Error("Gemini returned no subtitle text.");
  }

  const srt = cleanSrt(text);

  if (!/\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s+-->/.test(srt)) {
    throw new Error(
      "Gemini response was not a valid SRT file."
    );
  }

  onProgress(
    96,
    "Finalizing",
    "Preparing SRT download..."
  );

  return srt;
}


/* =========================
   JOB PROCESS
========================= */

async function processJob(
  jobId,
  mediaPath,
  sourceLanguage,
  targetLanguage
) {
  let audioPath = null;

  try {
    updateJob(
      jobId,
      2,
      "Preparing",
      "Checking uploaded video..."
    );

    audioPath = path.join(
      os.tmpdir(),
      `${randomUUID()}.mp3`
    );

    updateJob(
      jobId,
      8,
      "Extracting audio",
      "Preparing audio for transcription..."
    );

    await extractAudio(mediaPath, audioPath);

    updateJob(
      jobId,
      15,
      "Audio ready",
      "Audio extraction completed."
    );

    const srt = await generateSrtFromAudio(
      audioPath,
      sourceLanguage,
      targetLanguage,
      (progress, title, message) => {
        updateJob(
          jobId,
          progress,
          title,
          message
        );
      }
    );

    completeJob(jobId, srt);

  } catch (error) {
    console.error("JOB ERROR:", error);

    failJob(
      jobId,
      error?.message || String(error)
    );

  } finally {
    try {
      if (mediaPath && fs.existsSync(mediaPath)) {
        fs.unlinkSync(mediaPath);
      }
    } catch {}

    try {
      if (audioPath && fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
    } catch {}
  }
}


/* =========================
   START JOB
========================= */

app.post(
  "/api/start-job",
  upload.any(),
  async (req, res) => {
    try {
      const file =
        req.files?.find(f => f.fieldname === "media") ||
        req.files?.[0];

      if (!file) {
        return res.status(400).json({
          ok: false,
          error: "No media file uploaded."
        });
      }

      const sourceLanguage =
        req.body?.sourceLanguage ||
        "Auto detect";

      const targetLanguage =
        req.body?.targetLanguage ||
        "Myanmar (Burmese)";

      const job = createJob();

      // Start processing in background.
      processJob(
        job.id,
        file.path,
        sourceLanguage,
        targetLanguage
      );

      return res.json({
        ok: true,
        jobId: job.id
      });

    } catch (error) {
      console.error(error);

      return res.status(500).json({
        ok: false,
        error: error?.message || String(error)
      });
    }
  }
);


/* =========================
   JOB STATUS
========================= */

app.get(
  "/api/job/:jobId",
  (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job not found."
      });
    }

    return res.json({
      ok: true,
      jobId: job.id,
      progress: job.progress,
      title: job.title,
      message: job.message,
      status: job.status,
      srt: job.status === "complete"
        ? job.srt
        : null,
      error: job.error
    });
  }
);


/* =========================
   HEALTH
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "video-to-srt",
    model: MODEL
  });
});


/* =========================
   STATIC WEBSITE
========================= */

app.use(express.static(process.cwd()));


/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(
    `Video-to-SRT server running on port ${PORT}`
  );
});
