import express from "express";
import multer from "multer";
import dotenv from "dotenv";
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

const MODEL = "gemini-3.8-flash";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const jobs = new Map();

function updateJob(jobId, progress, title, message) {
  const job = jobs.get(jobId);

  if (!job) return;

  job.progress = Math.max(
    job.progress || 0,
    Math.min(100, Number(progress))
  );

  job.title = title || "";
  job.message = message || "";
  job.updatedAt = Date.now();
}

function completeJob(jobId, srt) {
  const job = jobs.get(jobId);

  if (!job) return;

  job.status = "completed";
  job.progress = 100;
  job.title = "Complete";
  job.message = "SRT generation completed successfully.";
  job.srt = srt;
  job.updatedAt = Date.now();
}

function failJob(jobId, error) {
  const job = jobs.get(jobId);

  if (!job) return;

  job.status = "failed";
  job.title = "Error";
  job.message = error?.message || String(error);
  job.updatedAt = Date.now();
}

function cleanupJob(jobId) {
  const job = jobs.get(jobId);

  if (!job) return;

  if (job.filePath) {
    try {
      if (fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
    } catch {}
  }

  jobs.delete(jobId);
}

function scheduleCleanup(jobId) {
  setTimeout(() => {
    cleanupJob(jobId);
  }, 30 * 60 * 1000);
}

function formatTime(seconds) {
  let total = Number(seconds);

  if (!Number.isFinite(total) || total < 0) {
    total = 0;
  }

  const hours = Math.floor(total / 3600);

  total -= hours * 3600;

  const minutes = Math.floor(total / 60);

  const secs = Math.floor(total - minutes * 60);

  const milliseconds = Math.round(
    (total - Math.floor(total)) * 1000
  );

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(secs).padStart(2, "0") +
    "," +
    String(milliseconds).padStart(3, "0")
  );
}

function extractJson(text) {
  if (!text) {
    throw new Error("Gemini returned empty output.");
  }

  let cleaned = String(text).trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("[");

  const end = cleaned.lastIndexOf("]");

  if (start !== -1 && end !== -1 && end > start) {
    const possibleJson = cleaned.slice(start, end + 1);

    try {
      return JSON.parse(possibleJson);
    } catch {}
  }

  const objectStart = cleaned.indexOf("{");

  const objectEnd = cleaned.lastIndexOf("}");

  if (
    objectStart !== -1 &&
    objectEnd !== -1 &&
    objectEnd > objectStart
  ) {
    const possibleJson = cleaned.slice(
      objectStart,
      objectEnd + 1
    );

    try {
      return JSON.parse(possibleJson);
    } catch {}
  }

  throw new Error(
    "Gemini returned subtitle data in an unreadable format."
  );
}

function normalizeCues(data) {
  let cues = data;

  if (!Array.isArray(cues)) {
    if (Array.isArray(cues?.subtitles)) {
      cues = cues.subtitles;
    } else if (Array.isArray(cues?.segments)) {
      cues = cues.segments;
    } else if (Array.isArray(cues?.cues)) {
      cues = cues.cues;
    } else {
      throw new Error("No subtitle segments were returned.");
    }
  }

  const result = [];

  for (const item of cues) {
    const start = Number(
      item.start ??
      item.startTime ??
      item.start_seconds
    );

    const end = Number(
      item.end ??
      item.endTime ??
      item.end_seconds
    );

    const text = String(
      item.text ??
      item.translation ??
      item.subtitle ??
      ""
    ).trim();

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !text
    ) {
      continue;
    }

    if (end <= start) {
      continue;
    }

    result.push({
      start,
      end,
      text
    });
  }

  result.sort((a, b) => a.start - b.start);

  if (!result.length) {
    throw new Error("No usable subtitles were returned.");
  }

  return result;
}

function buildSrt(cues) {
  return cues
    .map((cue, index) => {
      return (
        `${index + 1}\n` +
        `${formatTime(cue.start)} --> ${formatTime(cue.end)}\n` +
        `${cue.text}\n`
      );
    })
    .join("\n");
}

async function generateSrt({
  filePath,
  mimeType,
  sourceLanguage,
  targetLanguage,
  jobId
}) {
  updateJob(
    jobId,
    1,
    "Preparing",
    "Preparing your video..."
  );

  const uploadedFile = await ai.files.upload({
    file: filePath,
    config: {
      mimeType
    }
  });

  updateJob(
    jobId,
    8,
    "Uploading",
    "Video uploaded. Waiting for Gemini..."
  );

  let videoFile = uploadedFile;

  while (videoFile.state === "PROCESSING") {
    await new Promise((resolve) =>
      setTimeout(resolve, 2000)
    );

    videoFile = await ai.files.get({
      name: videoFile.name
    });

    updateJob(
      jobId,
      10,
      "Processing video",
      "Gemini is preparing the video..."
    );
  }

  if (videoFile.state === "FAILED") {
    throw new Error("Gemini could not process this video.");
  }

  updateJob(
    jobId,
    18,
    "Video ready",
    "Starting subtitle generation..."
  );

  const sourceText =
    sourceLanguage && sourceLanguage !== "auto"
      ? sourceLanguage
      : "Automatically detect the spoken language.";

  const targetText =
    targetLanguage || "Myanmar (Burmese)";

  const prompt = `
You are generating subtitles for a video.

SOURCE LANGUAGE:
${sourceText}

TARGET SUBTITLE LANGUAGE:
${targetText}

TASK:
Create a complete subtitle transcript for the spoken dialogue in the video.

IMPORTANT:
- Do NOT summarize.
- Do NOT skip dialogue.
- Preserve the actual meaning of the speech.
- Translate the dialogue into the TARGET SUBTITLE LANGUAGE.
- Keep subtitle sentences natural and readable.
- Include timestamps in seconds.
- Start and end times must correspond to the actual spoken dialogue.
- Return ONLY valid JSON.
- Do not use Markdown.
- Do not add explanations.

Return exactly this JSON structure:

[
  {
    "start": 0.0,
    "end": 2.5,
    "text": "translated subtitle"
  }
]

Create all subtitle segments for the entire video.
`;

  updateJob(
    jobId,
    25,
    "Analyzing video",
    "AI is listening to the dialogue..."
  );

  const interaction = await ai.interactions.create({
    model: MODEL,
    input: [
      {
        type: "video",
        uri: videoFile.uri,
        mime_type: videoFile.mimeType,
        processing: "agentic"
      },
      {
        type: "text",
        text: prompt
      }
    ],
    background: true
  });

  updateJob(
    jobId,
    35,
    "Generating subtitles",
    "Gemini is creating the subtitle timestamps..."
  );

  let result = interaction;

  while (
    result.status === "in_progress" ||
    result.status === "processing"
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, 3000)
    );

    result = await ai.interactions.get(
      result.id
    );

    updateJob(
      jobId,
      Math.min(
        85,
        (jobs.get(jobId)?.progress || 35) + 3
      ),
      "Generating subtitles",
      "AI is still processing the video..."
    );
  }

  if (
    result.status === "failed" ||
    result.status === "cancelled"
  ) {
    throw new Error(
      result.error?.message ||
      "Gemini subtitle generation failed."
    );
  }

  updateJob(
    jobId,
    90,
    "Building SRT",
    "Formatting subtitle file..."
  );

  const outputText =
    result.output_text ||
    result.outputText ||
    "";

  const parsed = extractJson(outputText);

  const cues = normalizeCues(parsed);

  const srt = buildSrt(cues);

  updateJob(
    jobId,
    98,
    "Finishing",
    "Preparing your SRT file..."
  );

  return srt;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    model: MODEL
  });
});

app.post(
  "/api/start-job",
  upload.any(),
  async (req, res) => {
    try {
      if (!GEMINI_API_KEY) {
        return res.status(500).json({
          ok: false,
          error: "GEMINI_API_KEY is missing on Render."
        });
      }

      const file =
        req.files?.find(
          (item) =>
            item.fieldname === "media" ||
            item.fieldname === "file" ||
            item.fieldname === "video" ||
            item.fieldname === "audio"
        ) ||
        req.files?.[0];

      if (!file) {
        return res.status(400).json({
          ok: false,
          error: "Please upload a video file."
        });
      }

      const jobId = randomUUID();

      jobs.set(jobId, {
        status: "running",
        progress: 0,
        title: "Starting",
        message: "Starting SRT generation...",
        filePath: file.path,
        updatedAt: Date.now(),
        srt: null
      });

      const sourceLanguage =
        req.body?.sourceLanguage || "auto";

      const targetLanguage =
        req.body?.targetLanguage ||
        "Myanmar (Burmese)";

      res.json({
        ok: true,
        jobId
      });

      generateSrt({
        filePath: file.path,
        mimeType:
          file.mimetype || "video/mp4",
        sourceLanguage,
        targetLanguage,
        jobId
      })
        .then((srt) => {
          completeJob(jobId, srt);

          setTimeout(() => {
            const job = jobs.get(jobId);

            if (job) {
              job.filePath = null;
            }
          }, 1000);
        })
        .catch((error) => {
          console.error(
            "SRT generation error:",
            error
          );

          failJob(jobId, error);

          try {
            if (fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
          } catch {}
        });

      scheduleCleanup(jobId);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Could not start the job."
      });
    }
  }
);

app.get("/api/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "Job not found."
    });
  }

  res.json({
    ok: true,
    status: job.status,
    progress: job.progress,
    title: job.title,
    message: job.message,
    srt:
      job.status === "completed"
        ? job.srt
        : null
  });
});

app.use(express.static(path.join(process.cwd())));

app.listen(PORT, () => {
  console.log(
    `AI Subtitle Maker server running on port ${PORT}`
  );
});
