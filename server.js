import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { execFile } from "child_process";
import { GoogleGenAI } from "@google/genai";
import ffmpegPath from "ffmpeg-static";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

const execFileAsync = promisify(execFile);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is missing.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});


/* =========================================================
   CONFIG
========================================================= */

const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

const TRANSLATION_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash"
];

const MAX_FILE_SIZE = 500 * 1024 * 1024;

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {

    const allowed = [
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "audio/mpeg",
      "audio/mp4",
      "audio/wav",
      "audio/webm",
      "audio/ogg",
      "audio/flac",
      "audio/x-m4a"
    ];

    if (
      allowed.includes(file.mimetype) ||
      file.originalname.toLowerCase().endsWith(".m4a")
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Unsupported file type. Please upload MP4, MOV, WEBM, MP3, M4A, WAV, OGG or FLAC."
        )
      );
    }
  }
});


/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));


/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function normalizeLanguage(language) {

  if (!language) return null;

  const value = String(language).trim().toLowerCase();

  const map = {
    "auto detect": null,
    "auto": null,

    "chinese": "zh",
    "english": "en",
    "thai": "th",
    "myanmar (burmese)": "my",
    "myanmar": "my",
    "burmese": "my",
    "japanese": "ja",
    "korean": "ko"
  };

  return Object.prototype.hasOwnProperty.call(map, value)
    ? map[value]
    : null;
}


function getLanguageName(language) {

  if (!language) {
    return "the requested language";
  }

  const value = String(language).trim();

  if (value === "Myanmar (Burmese)") return "Myanmar Unicode";
  if (value === "Chinese") return "Chinese";
  if (value === "English") return "English";
  if (value === "Thai") return "Thai";
  if (value === "Japanese") return "Japanese";
  if (value === "Korean") return "Korean";

  return value;
}


function cleanJsonText(text) {

  if (!text) return "";

  let value = String(text).trim();

  if (value.startsWith("```")) {
    value = value
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  return value;
}


/* =========================================================
   EXTRACT GEMINI TEXT
========================================================= */

function extractInteractionText(interaction) {

  const parts = [];

  if (!interaction) {
    return "";
  }

  if (typeof interaction.output_text === "string") {
    parts.push(interaction.output_text);
  }

  if (typeof interaction.text === "string") {
    parts.push(interaction.text);
  }

  if (Array.isArray(interaction.outputs)) {

    for (const output of interaction.outputs) {

      if (typeof output === "string") {
        parts.push(output);
        continue;
      }

      if (typeof output?.text === "string") {
        parts.push(output.text);
      }

      if (Array.isArray(output?.content)) {

        for (const content of output.content) {

          if (typeof content === "string") {
            parts.push(content);
          }

          if (typeof content?.text === "string") {
            parts.push(content.text);
          }
        }
      }
    }
  }

  if (Array.isArray(interaction.steps)) {

    for (const step of interaction.steps) {

      if (!Array.isArray(step?.content)) continue;

      for (const content of step.content) {

        if (typeof content === "string") {
          parts.push(content);
        }

        if (typeof content?.text === "string") {
          parts.push(content.text);
        }
      }
    }
  }

  return parts
    .filter(Boolean)
    .join("\n")
    .trim();
}


/* =========================================================
   WORD TIMESTAMP EXTRACTION
========================================================= */

function extractWordAnnotations(interaction) {

  const words = [];

  if (!interaction) {
    return words;
  }

  const steps = Array.isArray(interaction.steps)
    ? interaction.steps
    : [];

  for (const step of steps) {

    const contents = Array.isArray(step?.content)
      ? step.content
      : [];

    for (const content of contents) {

      const annotations = Array.isArray(content?.annotations)
        ? content.annotations
        : [];

      for (const annotation of annotations) {

        if (annotation?.type !== "word_info") {
          continue;
        }

        const text =
          annotation.text ??
          annotation.word ??
          "";

        const start =
          annotation.start_offset ??
          annotation.startOffset ??
          null;

        const end =
          annotation.end_offset ??
          annotation.endOffset ??
          null;

        if (
          text &&
          start !== null &&
          end !== null
        ) {

          words.push({
            text: String(text),
            start: Number(start),
            end: Number(end),
            speaker: annotation.speaker ?? null
          });
        }
      }
    }
  }

  words.sort((a, b) => a.start - b.start);

  return words;
}


/* =========================================================
   TIME CONVERSION
========================================================= */

function offsetToSeconds(value) {

  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number") {

    // Gemini timestamp offsets are normally microseconds.
    // Small values are treated as seconds.
    if (value > 100000) {
      return value / 1000000;
    }

    return value;
  }

  const text = String(value);

  if (text.endsWith("s")) {
    return parseFloat(text);
  }

  if (text.endsWith("ms")) {
    return parseFloat(text) / 1000;
  }

  if (text.endsWith("us")) {
    return parseFloat(text) / 1000000;
  }

  const number = Number(text);

  if (!Number.isFinite(number)) {
    return 0;
  }

  if (number > 100000) {
    return number / 1000000;
  }

  return number;
}


/* =========================================================
   SOURCE CUE BUILDING
========================================================= */

function buildSourceCues(words) {

  if (!words.length) {
    return [];
  }

  const cues = [];

  let current = null;

  for (const word of words) {

    const wordText = word.text.trim();

    if (!wordText) {
      continue;
    }

    if (!current) {

      current = {
        start: offsetToSeconds(word.start),
        end: offsetToSeconds(word.end),
        words: []
      };
    }

    const currentText = current.words.join(" ");

    const proposedText =
      currentText
        ? `${currentText} ${wordText}`
        : wordText;

    const duration =
      offsetToSeconds(word.end) - current.start;

    const shouldBreak =
      current.words.length >= 16 ||
      proposedText.length >= 48 ||
      duration >= 4.5 ||
      /[.!?。！？]$/.test(wordText);

    if (shouldBreak && current.words.length > 0) {

      cues.push({
        start: current.start,
        end: Math.max(
          current.end,
          current.start + 0.5
        ),
        text: current.words.join(" ")
      });

      current = {
        start: offsetToSeconds(word.start),
        end: offsetToSeconds(word.end),
        words: [wordText]
      };

    } else {

      current.words.push(wordText);
      current.end = offsetToSeconds(word.end);
    }
  }


  if (current && current.words.length) {

    cues.push({
      start: current.start,
      end: Math.max(
        current.end,
        current.start + 0.5
      ),
      text: current.words.join(" ")
    });
  }


  return cues;
}


/* =========================================================
   TRANSLATION
========================================================= */

async function translateBatch(
  cues,
  targetLanguage
) {

  if (!cues.length) {
    return [];
  }

  const languageName =
    getLanguageName(targetLanguage);

  const input = cues.map((cue, index) => ({
    id: index + 1,
    text: cue.text
  }));


  const prompt = `
You are a professional subtitle translator.

Translate the following subtitle segments into ${languageName}.

Rules:

1. Preserve the exact number of subtitle segments.
2. Keep every segment ID unchanged.
3. Translate naturally for subtitles.
4. Do not explain anything.
5. Do not add comments.
6. Do not merge segments.
7. Do not omit segments.
8. For Myanmar, use natural Myanmar Unicode.
9. Preserve names, numbers and important terminology accurately.
10. Return ONLY valid JSON.

Input:
${JSON.stringify(input)}
`;


  let lastError = null;


  for (const model of TRANSLATION_MODELS) {

    try {

      const response =
        await ai.models.generateContent({

          model,

          contents: prompt,

          config: {
            responseMimeType: "application/json",

            responseSchema: {
              type: "array",

              items: {
                type: "object",

                properties: {
                  id: {
                    type: "integer"
                  },

                  text: {
                    type: "string"
                  }
                },

                required: [
                  "id",
                  "text"
                ]
              }
            }
          }
        });


      const raw =
        cleanJsonText(
          response.text || ""
        );


      const parsed =
        JSON.parse(raw);


      if (!Array.isArray(parsed)) {
        throw new Error(
          "Translation response was not an array."
        );
      }


      return parsed
        .sort((a, b) => a.id - b.id)
        .map(item => String(item.text || "").trim());


    } catch (error) {

      lastError = error;

      console.error(
        `Translation model ${model} failed:`,
        error?.message || error
      );
    }
  }


  throw lastError ||
    new Error("Translation failed.");
}


/* =========================================================
   SRT HELPERS
========================================================= */

function formatSrtTime(seconds) {

  seconds = Math.max(
    0,
    Number(seconds) || 0
  );

  const hours =
    Math.floor(seconds / 3600);

  const minutes =
    Math.floor((seconds % 3600) / 60);

  const secs =
    Math.floor(seconds % 60);

  const millis =
    Math.floor(
      (seconds % 1) * 1000
    );


  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(secs).padStart(2, "0")
  ].join(":")
    + ","
    + String(millis).padStart(3, "0");
}


function wrapSubtitle(text, maxChars = 42) {

  const words =
    String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);


  if (!words.length) {
    return "";
  }


  const lines = [];
  let line = "";


  for (const word of words) {

    const proposed =
      line
        ? `${line} ${word}`
        : word;


    if (
      line &&
      proposed.length > maxChars
    ) {

      lines.push(line);
      line = word;

    } else {

      line = proposed;
    }
  }


  if (line) {
    lines.push(line);
  }


  if (lines.length <= 2) {
    return lines.join("\n");
  }


  return [
    lines[0],
    lines.slice(1).join(" ")
  ].join("\n");
}


function buildSrt(cues, translatedTexts) {

  const blocks = [];


  for (
    let i = 0;
    i < cues.length;
    i++
  ) {

    const cue = cues[i];

    const translated =
      translatedTexts[i] ||
      cue.text;


    let start = cue.start;
    let end = cue.end;


    if (end <= start) {
      end = start + 1;
    }


    // Avoid overlapping subtitle timing.
    if (i < cues.length - 1) {

      const nextStart =
        Number(cues[i + 1].start);

      if (
        Number.isFinite(nextStart) &&
        end > nextStart
      ) {
        end = Math.max(
          start + 0.5,
          nextStart - 0.02
        );
      }
    }


    blocks.push(
      `${i + 1}\n` +
      `${formatSrtTime(start)} --> ${formatSrtTime(end)}\n` +
      `${wrapSubtitle(translated)}`
    );
  }


  return blocks.join("\n\n") + "\n";
}


/* =========================================================
   AUDIO EXTRACTION
========================================================= */

async function extractAudio(
  inputPath,
  outputPath
) {

  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg binary was not found."
    );
  }


  await execFileAsync(
    ffmpegPath,
    [
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
    ],
    {
      maxBuffer: 10 * 1024 * 1024
    }
  );
}


/* =========================================================
   WAIT FOR GEMINI FILE
========================================================= */

async function waitForFileActive(
  fileName
) {

  for (let i = 0; i < 60; i++) {

    const file =
      await ai.files.get({
        name: fileName
      });


    const state =
      file?.state?.toString?.() ||
      file?.state ||
      "";


    if (
      state === "ACTIVE" ||
      state === "active"
    ) {
      return file;
    }


    if (
      state === "FAILED" ||
      state === "failed"
    ) {

      throw new Error(
        "Gemini failed while processing the uploaded audio."
      );
    }


    await sleep(2000);
  }


  throw new Error(
    "Timed out while waiting for Gemini to process the audio."
  );
}


/* =========================================================
   TRANSCRIPTION
========================================================= */

async function transcribeAudio(
  audioFile,
  sourceLanguage
) {

  const languageCode =
    normalizeLanguage(sourceLanguage);


  const config = {
    transcription_config: {
      mode: {
        type: "verbatim",

        timestamp_granularities: [
          "word"
        ]
      }
    }
  };


  if (languageCode) {

    config.transcription_config.language_codes = [
      languageCode
    ];
  }


  const interaction =
    await ai.interactions.create({

      model: TRANSCRIBE_MODEL,

      input: [
        {
          type: "audio",

          uri: audioFile.uri,

          mime_type:
            audioFile.mimeType ||
            "audio/mpeg"
        }
      ],

      generation_config: config
    });


  return interaction;
}


/* =========================================================
   MAIN GENERATION
========================================================= */

async function generateSrt({
  mediaPath,
  sourceLanguage,
  targetLanguage
}) {

  const workingDir =
    await fs.promises.mkdtemp(
      path.join(
        os.tmpdir(),
        "video-to-srt-"
      )
    );


  const audioPath =
    path.join(
      workingDir,
      "audio.mp3"
    );


  let uploadedFile = null;


  try {

    /*
     * STEP 1
     * Prepare audio
     */

    await extractAudio(
      mediaPath,
      audioPath
    );


    /*
     * STEP 2
     * Upload audio to Gemini
     */

    uploadedFile =
      await ai.files.upload({

        file: audioPath,

        config: {
          mime_type: "audio/mpeg"
        }
      });


    if (!uploadedFile?.name) {

      throw new Error(
        "Gemini did not return an uploaded file."
      );
    }


    /*
     * STEP 3
     * Wait until Gemini file is ready
     */

    const activeFile =
      await waitForFileActive(
        uploadedFile.name
      );


    /*
     * STEP 4
     * Transcribe
     */

    const interaction =
      await transcribeAudio(
        activeFile,
        sourceLanguage
      );


    /*
     * STEP 5
     * Extract word timestamps
     */

    const words =
      extractWordAnnotations(
        interaction
      );


    if (!words.length) {

      throw new Error(
        "Gemini returned no word timestamps. Please try another file."
      );
    }


    /*
     * STEP 6
     * Build source cues
     */

    const sourceCues =
      buildSourceCues(words);


    if (!sourceCues.length) {

      throw new Error(
        "No subtitle segments could be created."
      );
    }


    /*
     * STEP 7
     * Translate in batches
     */

    const BATCH_SIZE = 40;

    const translatedTexts = [];


    for (
      let i = 0;
      i < sourceCues.length;
      i += BATCH_SIZE
    ) {

      const batch =
        sourceCues.slice(
          i,
          i + BATCH_SIZE
        );


      const translated =
        await translateBatch(
          batch,
          targetLanguage
        );


      translatedTexts.push(
        ...translated
      );
    }


    /*
     * STEP 8
     * Build final SRT
     */

    const srt =
      buildSrt(
        sourceCues,
        translatedTexts
      );


    return {
      srt,
      cueCount: sourceCues.length,
      model: TRANSCRIBE_MODEL
    };


  } finally {

    /*
     * Cleanup
     */

    try {
      await fs.promises.rm(
        workingDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch (error) {
      console.error(
        "Cleanup error:",
        error?.message || error
      );
    }

    try {

      if (uploadedFile?.name) {

        await ai.files.delete({
          name: uploadedFile.name
        });
      }

    } catch (error) {

      console.warn(
        "Gemini file cleanup warning:",
        error?.message || error
      );
    }
  }
}


/* =========================================================
   ROUTES
========================================================= */

app.get("/health", (req, res) => {

  res.json({
    ok: true,
    service: "video-to-srt",
    transcriptionModel: TRANSCRIBE_MODEL
  });
});


app.get("/", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "index.html"
    )
  );
});


app.post(
  "/api/generate-srt",
  upload.single("media"),

  async (req, res) => {

    let mediaPath = null;


    try {

      if (!req.file) {

        return res.status(400).json({
          error:
            "Please upload a video or audio file."
        });
      }


      mediaPath =
        req.file.path;


      const sourceLanguage =
        req.body.sourceLanguage ||
        "Auto detect";


      const targetLanguage =
        req.body.targetLanguage ||
        "Myanmar (Burmese)";


      console.log(
        "Starting SRT generation:",
        {
          file: req.file.originalname,
          size: req.file.size,
          sourceLanguage,
          targetLanguage
        }
      );


      const result =
        await generateSrt({

          mediaPath,

          sourceLanguage,

          targetLanguage
        });


      console.log(
        "SRT generation completed:",
        result.cueCount,
        "cues"
      );


      return res.json({

        ok: true,

        srt: result.srt,

        model: result.model,

        cueCount: result.cueCount
      });


    } catch (error) {

      console.error(
        "Generation error:",
        error
      );


      let message =
        error?.message ||
        "SRT generation failed.";


      if (
        error?.code === "LIMIT_FILE_SIZE"
      ) {

        message =
          "File is too large. Maximum allowed size is 500MB.";
      }


      return res.status(500).json({
        ok: false,
        error: message
      });


    } finally {

      if (mediaPath) {

        try {

          await fs.promises.unlink(
            mediaPath
          );

        } catch {
          // File may already have been removed.
        }
      }
    }
  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      "Unhandled server error:",
      error
    );


    if (res.headersSent) {
      return next(error);
    }


    res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Internal server error."
    });
  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Video-to-SRT server running on port ${PORT}`
    );

    console.log(
      `Transcription model: ${TRANSCRIBE_MODEL}`
    );
  }
);
