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

/*
  3.7 Flash:
  - Audio input supported
  - Structured output supported
  - 65k output tokens
*/
const MODEL = "gemini-3.5-flash-lite";

const MAX_FILE_SIZE = 500 * 1024 * 1024;

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
            `FFmpeg audio extraction failed: ${stderr.slice(-2000)}`
          )
        );
      }
    });
  });
}

/* =========================
   TIME HELPERS
========================= */

function parseTime(value) {
  if (typeof value === "number") {
    return value;
  }

  if (!value) return null;

  const text = String(value).trim();

  // HH:MM:SS.mmm
  let match = text.match(
    /^(\d+):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/
  );

  if (match) {
    const h = Number(match[1]);
    const m = Number(match[2]);
    const s = Number(match[3]);
    const ms = Number((match[4] || "0").padEnd(3, "0"));

    return h * 3600 + m * 60 + s + ms / 1000;
  }

  // MM:SS
  match = text.match(
    /^(\d+):(\d{2})(?:[.,](\d{1,3}))?$/
  );

  if (match) {
    const m = Number(match[1]);
    const s = Number(match[2]);
    const ms = Number((match[3] || "0").padEnd(3, "0"));

    return m * 60 + s + ms / 1000;
  }

  const n = Number(text);

  return Number.isFinite(n) ? n : null;
}

function formatSrtTime(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);

  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;

  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  const secs = Math.floor(seconds);
  const millis = Math.round(
    (seconds - secs) * 1000
  );

  let finalMillis = millis;
  let finalSecs = secs;
  let finalMinutes = minutes;
  let finalHours = hours;

  if (finalMillis >= 1000) {
    finalMillis -= 1000;
    finalSecs += 1;
  }

  if (finalSecs >= 60) {
    finalSecs -= 60;
    finalMinutes += 1;
  }

  if (finalMinutes >= 60) {
    finalMinutes -= 60;
    finalHours += 1;
  }

  return (
    String(finalHours).padStart(2, "0") +
    ":" +
    String(finalMinutes).padStart(2, "0") +
    ":" +
    String(finalSecs).padStart(2, "0") +
    "," +
    String(finalMillis).padStart(3, "0")
  );
}

/* =========================
   CLEAN GEMINI JSON
========================= */

function cleanJson(text) {
  if (!text) {
    throw new Error("Gemini returned empty response.");
  }

  let value = String(text).trim();

  value = value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first >= 0 && last > first) {
    value = value.slice(first, last + 1);
  }

  return value;
}

/* =========================
   TRANSCRIPTION
========================= */

async function transcribeAudio(
  audioPath,
  sourceLanguage
) {
  console.log("Uploading audio to Gemini...");

  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: {
      mimeType: "audio/mpeg"
    }
  });

  if (!uploadedFile?.uri) {
    throw new Error("Gemini audio upload failed.");
  }

  console.log("Waiting for Gemini file...");

  let currentFile = uploadedFile;

  while (
    currentFile.state &&
    String(currentFile.state) !== "ACTIVE"
  ) {
    if (String(currentFile.state) === "FAILED") {
      throw new Error("Gemini failed to process the audio.");
    }

    await new Promise(resolve =>
      setTimeout(resolve, 1500)
    );

    currentFile = await ai.files.get({
      name: currentFile.name
    });
  }

  console.log("Gemini file ready.");

  const languageInstruction =
    sourceLanguage &&
    sourceLanguage !== "Auto detect"
      ? `The spoken source language is ${sourceLanguage}.`
      : "Automatically detect the spoken language.";

  const prompt = `
You are a professional subtitle transcription engine.

${languageInstruction}

Listen to the ENTIRE uploaded audio from beginning to end.

Return a JSON object containing ALL spoken subtitle segments.

IMPORTANT:
- Do NOT stop after the first few sentences.
- Process the ENTIRE audio.
- Do not skip speech near the beginning, middle, or end.
- Do not summarize.
- Do not explain.
- Do not invent speech.
- Every spoken part should appear in a segment.
- Keep timestamps in chronological order.
- Start and end timestamps must match the actual speech.
- Keep subtitle segments short and readable.
- Prefer approximately 1 to 6 seconds per subtitle.
- Do not create empty segments.

Return ONLY valid JSON.

Schema:

{
  "segments": [
    {
      "start": 0.0,
      "end": 2.5,
      "text": "spoken text"
    }
  ]
}

The "start" and "end" values MUST be seconds from the beginning of the audio.

The final segment should continue until the end of the last spoken sentence.

Do not use Markdown.
Do not use code fences.
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
      maxOutputTokens: 65536,

      responseMimeType: "application/json",

      responseSchema: {
        type: "OBJECT",
        properties: {
          segments: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                start: {
                  type: "NUMBER"
                },
                end: {
                  type: "NUMBER"
                },
                text: {
                  type: "STRING"
                }
              },
              required: [
                "start",
                "end",
                "text"
              ]
            }
          }
        },
        required: ["segments"]
      }
    }
  });

  const jsonText = cleanJson(result.text);

  let data;

  try {
    data = JSON.parse(jsonText);
  } catch (error) {
    console.error("BAD JSON:", jsonText.slice(0, 3000));
    throw new Error(
      "Gemini returned invalid transcription JSON."
    );
  }

  if (
    !data ||
    !Array.isArray(data.segments)
  ) {
    throw new Error(
      "Gemini returned no subtitle segments."
    );
  }

  const segments = data.segments
    .map(item => ({
      start: parseTime(item.start),
      end: parseTime(item.end),
      text: String(item.text || "").trim()
    }))
    .filter(item =>
      item.start !== null &&
      item.end !== null &&
      item.end > item.start &&
      item.text.length > 0
    )
    .sort((a, b) => a.start - b.start);

  if (segments.length === 0) {
    throw new Error(
      "No speech segments were detected."
    );
  }

  console.log(
    `Transcription segments: ${segments.length}`
  );

  return {
    segments,
    uploadedFile
  };
}

/* =========================
   TRANSLATION
========================= */

async function translateSegments(
  segments,
  sourceLanguage,
  targetLanguage
) {
  if (
    !targetLanguage ||
    targetLanguage === sourceLanguage
  ) {
    return segments.map(item => ({
      ...item,
      translated: item.text
    }));
  }

  /*
    Send numbered segments so timestamps
    never need to be regenerated.
  */

  const input = segments.map((item, index) => ({
    id: index + 1,
    text: item.text
  }));

  const prompt = `
You are a professional subtitle translator.

SOURCE LANGUAGE:
${sourceLanguage || "Auto detect"}

TARGET LANGUAGE:
${targetLanguage}

Translate EVERY subtitle segment below.

IMPORTANT:
- Translate all items.
- Never omit an item.
- Keep exactly the same IDs.
- Do not change IDs.
- Do not merge items.
- Do not split items.
- Preserve the original meaning.
- For Myanmar (Burmese), use natural Unicode Myanmar.
- Do not add explanations.
- Return ONLY valid JSON.

INPUT:
${JSON.stringify(input)}

OUTPUT FORMAT:
{
  "translations": [
    {
      "id": 1,
      "text": "translated subtitle"
    }
  ]
}
`;

  const result = await ai.models.generateContent({
    model: MODEL,

    contents: prompt,

    config: {
      maxOutputTokens: 65536,

      responseMimeType: "application/json",

      responseSchema: {
        type: "OBJECT",
        properties: {
          translations: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                id: {
                  type: "INTEGER"
                },
                text: {
                  type: "STRING"
                }
              },
              required: [
                "id",
                "text"
              ]
            }
          }
        },
        required: ["translations"]
      }
    }
  });

  const jsonText = cleanJson(result.text);

  let data;

  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error(
      "Gemini returned invalid translation JSON."
    );
  }

  if (
    !data ||
    !Array.isArray(data.translations)
  ) {
    throw new Error(
      "Gemini returned no translations."
    );
  }

  const translationMap = new Map();

  for (const item of data.translations) {
    const id = Number(item.id);
    const text = String(item.text || "").trim();

    if (
      Number.isInteger(id) &&
      text
    ) {
      translationMap.set(id, text);
    }
  }

  /*
    If Gemini accidentally misses a translation,
    keep the original text instead of losing
    that subtitle.
  */

  return segments.map((segment, index) => ({
    ...segment,

    translated:
      translationMap.get(index + 1) ||
      segment.text
  }));
}

/* =========================
   BUILD SRT
========================= */

function buildSrt(segments) {
  const blocks = [];

  let number = 1;

  for (const segment of segments) {
    if (!segment.text || !segment.translated) {
      continue;
    }

    let start = Number(segment.start);
    let end = Number(segment.end);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      continue;
    }

    /*
      Make very short subtitles readable.
    */
    if (end - start < 0.8) {
      end = start + 0.8;
    }

    blocks.push(
      `${number}\n` +
      `${formatSrtTime(start)} --> ${formatSrtTime(end)}\n` +
      `${segment.translated}\n`
    );

    number++;
  }

  if (blocks.length === 0) {
    throw new Error(
      "Could not build SRT subtitles."
    );
  }

  return blocks.join("\n").trim() + "\n";
}

/* =========================
   MAIN GENERATOR
========================= */

async function generateSrt(
  mediaPath,
  sourceLanguage,
  targetLanguage
) {
  const audioPath = path.join(
    os.tmpdir(),
    `${randomUUID()}.mp3`
  );

  try {
    console.log("Extracting audio...");

    await extractAudio(
      mediaPath,
      audioPath
    );

    console.log("Transcribing...");

    const transcription =
      await transcribeAudio(
        audioPath,
        sourceLanguage
      );

    console.log(
      `Got ${transcription.segments.length} segments.`
    );

    console.log("Translating...");

    const translated =
      await translateSegments(
        transcription.segments,
        sourceLanguage,
        targetLanguage
      );

    console.log("Building SRT...");

    return buildSrt(translated);

  } finally {
    try {
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
    } catch {}

    /*
      Delete uploaded Gemini file.
    */
  }
}

/* =========================
   GENERATE SRT API
========================= */

app.post(
  "/api/generate-srt",
  upload.single("media"),
  async (req, res) => {
    let mediaPath = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "No media file uploaded."
        });
      }

      mediaPath = req.file.path;

      const sourceLanguage =
        req.body?.sourceLanguage ||
        "Auto detect";

      const targetLanguage =
        req.body?.targetLanguage ||
        "Myanmar (Burmese)";

      console.log(
        "=============================="
      );

      console.log(
        "Generate SRT request"
      );

      console.log(
        "File:",
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

      console.log(
        "Model:",
        MODEL
      );

      const srt = await generateSrt(
        mediaPath,
        sourceLanguage,
        targetLanguage
      );

      console.log(
        "SRT generated successfully."
      );

      return res.json({
        ok: true,
        srt
      });

    } catch (error) {
      console.error(
        "GENERATE SRT ERROR:",
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
          mediaPath &&
          fs.existsSync(mediaPath)
        ) {
          fs.unlinkSync(mediaPath);
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
    service: "video-to-srt",
    model: MODEL
  });
});

/* =========================
   STATIC WEBSITE
========================= */

app.use(
  express.static(process.cwd())
);

/* =========================
   START
========================= */

// Burn Myanmar subtitles into an MP4 video
app.post("/api/burn-subtitles", upload.single("media"), async (req, res) => {
  let srtPath;
  let outputPath;

  const cleanup = async () => {
    for (const filePath of [req.file?.path, srtPath, outputPath]) {
      if (filePath) {
        try {
          await fs.promises.unlink(filePath);
        } catch {}
      }
    }
  };

  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload a video file." });
    }

    const srt = req.body?.srt;

    if (typeof srt !== "string" || !srt.trim()) {
      await cleanup();
      return res.status(400).json({ error: "Please generate subtitles first." });
    }

    const id = randomUUID();
    srtPath = path.join(os.tmpdir(), `${id}.srt`);
    outputPath = path.join(os.tmpdir(), `${id}-myanmar.mp4`);

    await fs.promises.writeFile(srtPath, "\uFEFF" + srt, "utf8");

    // Escape the subtitle file path for FFmpeg.
    const escapedSrtPath = srtPath
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'");

    const subtitleFilter =
      `subtitles='${escapedSrtPath}':` +
      "force_style='FontSize=22,Outline=2,Shadow=1," +
      "Alignment=2,MarginV=28'";

    await new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-i", req.file.path,
        "-vf", subtitleFilter,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputPath
      ];

      const ffmpeg = spawn(ffmpegPath, args);
      let errorOutput = "";

      ffmpeg.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      ffmpeg.on("error", reject);

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(errorOutput.slice(-2000) || "FFmpeg failed.")
          );
        }
      });
    });

    res.download(outputPath, "myanmar-subtitled.mp4", async (err) => {
      await cleanup();

      if (err && !res.headersSent) {
        res.status(500).json({ error: "MP4 download failed." });
      }
    });
  } catch (error) {
    console.error("Burn subtitles error:", error);
    await cleanup();

    if (!res.headersSent) {
      res.status(500).json({
        error: "Could not create the subtitled video. Please try a smaller video."
      });
    }
  }
});
app.listen(PORT, () => {
  console.log(
    `Video-to-SRT server running on port ${PORT}`
  );
});
