import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI } from "@google/genai";
import ffmpegPath from "ffmpeg-static";

dotenv.config();

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
// MODELS
// ----------------------------------------------------

const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

const TRANSLATION_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
];

// ----------------------------------------------------
// UPLOAD
// ----------------------------------------------------

const uploadDir = path.join(os.tmpdir(), "video-to-srt");

const upload = multer({
  dest: uploadDir,

  limits: {
    fileSize: 500 * 1024 * 1024,
  },

  fileFilter: (_req, file, cb) => {
    const allowed = [
      "video/mp4",
      "video/quicktime",
      "video/webm",

      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/x-m4a",
      "audio/m4a",
      "audio/wav",
      "audio/x-wav",
      "audio/webm",
      "audio/ogg",
      "audio/flac",
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Unsupported file type. Please upload MP4, MOV, WEBM, MP3, M4A, WAV, OGG or FLAC."
        )
      );
    }
  },
});

// ----------------------------------------------------
// EXPRESS
// ----------------------------------------------------

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Your repo keeps index.html/app.js/style.css in root.
app.use(express.static(__dirname));

// ----------------------------------------------------
// HEALTH
// ----------------------------------------------------

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "AI Subtitle Maker",
    status: "healthy",
    transcriptionModel: TRANSCRIBE_MODEL,
  });
});

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeDelete(filePath) {
  if (!filePath) return;

  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Ignore cleanup errors.
  }
}

function cleanText(text) {
  if (!text) return "";

  return String(text)
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (!language) return "Myanmar Unicode";

  const value = String(language).toLowerCase();

  if (
    value.includes("myanmar") ||
    value.includes("burmese") ||
    value.includes("မြန်မာ")
  ) {
    return "Myanmar Unicode (Burmese)";
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

function isVideoMime(mimeType) {
  return String(mimeType || "").startsWith("video/");
}

// ----------------------------------------------------
// FFMPEG
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

  console.log("Extracting audio from video...");

  await execFileAsync(
    ffmpegPath,
    [
      "-y",
      "-i",
      inputPath,

      "-vn",

      "-acodec",
      "libmp3lame",

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

  console.log(
    "Audio extraction complete:",
    outputPath
  );

  return outputPath;
}

// ----------------------------------------------------
// GEMINI FILE UPLOAD
// ----------------------------------------------------

async function uploadToGemini(
  filePath,
  mimeType
) {
  console.log(
    "Uploading audio to Gemini Files API..."
  );

  const uploaded = await ai.files.upload({
    file: filePath,

    config: {
      mimeType,
    },
  });

  if (!uploaded) {
    throw new Error(
      "Gemini Files API returned no file."
    );
  }

  console.log(
    "Gemini file:",
    uploaded.name || uploaded.uri || "unknown"
  );

  return uploaded;
}

// ----------------------------------------------------
// WAIT FOR FILE
// ----------------------------------------------------

async function waitForGeminiFile(
  fileName
) {
  const maxAttempts = 60;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
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

  const transcriptionConfig = {
    mode: {
      type: "verbatim",

      // IMPORTANT:
      // This is the current API setting.
      timestamp_granularities: ["word"],
    },
  };

  if (languageCodes.length > 0) {
    transcriptionConfig.language_codes =
      languageCodes;
  }

  const interaction =
    await ai.interactions.create({
      model: TRANSCRIBE_MODEL,

      input: [
        {
          type: "audio",
          uri: geminiFile.uri,
          mime_type:
            geminiFile.mimeType ||
            "audio/mp3",
        },
      ],

      generation_config: {
        transcription_config:
          transcriptionConfig,
      },
    });

  if (!interaction) {
    throw new Error(
      "Gemini Transcribe returned no response."
    );
  }

  const transcript =
    interaction.output_text || "";

  const words =
    extractWordAnnotations(interaction);

  console.log(
    "Transcript characters:",
    transcript.length
  );

  console.log(
    "Word annotations:",
    words.length
  );

  if (!words.length) {
    throw new Error(
      "Gemini returned transcription text but no word timestamps. Please try again."
    );
  }

  return {
    transcript,
    words,
  };
}

// ----------------------------------------------------
// EXTRACT WORD TIMESTAMPS
// ----------------------------------------------------

function extractWordAnnotations(
  interaction
) {
  const words = [];

  for (
    const step of interaction?.steps || []
  ) {
    for (
      const content of step?.content || []
    ) {
      for (
        const annotation of
          content?.annotations || []
      ) {
        if (
          annotation?.type === "word_info"
        ) {
          words.push({
            text: annotation.text || "",

            speaker:
              annotation.speaker || null,

            start_offset:
              annotation.start_offset || "0s",

            end_offset:
              annotation.end_offset || "0s",
          });
        }
      }
    }
  }

  return words;
}

// ----------------------------------------------------
// TIME HELPERS
// ----------------------------------------------------

function parseSeconds(value) {
  if (typeof value === "number") {
    return value;
  }

  const text = String(value || "0")
    .trim()
    .toLowerCase();

  if (text.endsWith("ms")) {
    return (
      Number.parseFloat(
        text.replace("ms", "")
      ) / 1000
    );
  }

  if (text.endsWith("s")) {
    return Number.parseFloat(
      text.replace("s", "")
    );
  }

  return Number.parseFloat(text) || 0;
}

function formatSrtTime(seconds) {
  seconds = Math.max(
    0,
    Number(seconds) || 0
  );

  const hours = Math.floor(
    seconds / 3600
  );

  const minutes = Math.floor(
    (seconds % 3600) / 60
  );

  const secs = Math.floor(
    seconds % 60
  );

  const milliseconds = Math.round(
    (seconds - Math.floor(seconds)) *
      1000
  );

  let ms = milliseconds;

  let finalSecs = secs;

  if (ms >= 1000) {
    ms = 0;
    finalSecs += 1;
  }

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(finalSecs).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

// ----------------------------------------------------
// WORD JOINING
// ----------------------------------------------------

function containsCjk(text) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(
    text
  );
}

function joinWords(words) {
  if (!words.length) return "";

  const sample = words
    .map((w) => w.text)
    .join("");

  // Chinese / Japanese / Korean style text
  if (containsCjk(sample)) {
    return words
      .map((w) => w.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }

  return words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.!?;:%])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

// ----------------------------------------------------
// CREATE SOURCE CUES
// ----------------------------------------------------

function createSourceCues(
  words
) {
  const cues = [];

  let current = [];

  const MAX_DURATION = 4.5;
  const MAX_WORDS = 16;
  const MAX_CHARS = 48;

  function flush() {
    if (!current.length) return;

    const first = current[0];
    const last =
      current[current.length - 1];

    const text = cleanText(
      joinWords(current)
    );

    if (text) {
      cues.push({
        start: parseSeconds(
          first.start_offset
        ),

        end: Math.max(
          parseSeconds(
            last.end_offset
          ),
          parseSeconds(
            first.start_offset
          ) + 0.8
        ),

        sourceText: text,
      });
    }

    current = [];
  }

  for (const word of words) {
    if (!word?.text) continue;

    const candidate = [
      ...current,
      word,
    ];

    const first =
      candidate[0];

    const last =
      candidate[candidate.length - 1];

    const duration =
      parseSeconds(
        last.end_offset
      ) -
      parseSeconds(
        first.start_offset
      );

    const candidateText =
      joinWords(candidate);

    const tooLong =
      duration > MAX_DURATION ||
      candidate.length > MAX_WORDS ||
      candidateText.length > MAX_CHARS;

    if (
      current.length > 0 &&
      tooLong
    ) {
      flush();
    }

    current.push(word);

    const text =
      joinWords(current);

    const endWord =
      String(word.text).trim();

    const punctuationBreak =
      /[.!?。！？]$/u.test(
        endWord
      );

    const currentDuration =
      parseSeconds(
        word.end_offset
      ) -
      parseSeconds(
        current[0].start_offset
      );

    if (
      punctuationBreak &&
      currentDuration >= 1.0
    ) {
      flush();
    }
  }

  flush();

  return cues;
}

// ----------------------------------------------------
// TRANSLATION
// ----------------------------------------------------

async function translateCues(
  cues,
  targetLanguage
) {
  const target =
    getTargetLanguageName(
      targetLanguage
    );

  if (
    !cues.length
  ) {
    return [];
  }

  const translated = [];

  // Process in batches so very long videos
  // don't create one huge translation request.
  const BATCH_SIZE = 40;

  for (
    let start = 0;
    start < cues.length;
    start += BATCH_SIZE
  ) {
    const batch =
      cues.slice(
        start,
        start + BATCH_SIZE
      );

    console.log(
      `Translating cues ${start + 1}-${start + batch.length} / ${cues.length}`
    );

    const numberedText =
      batch
        .map(
          (cue, index) =>
            `${index + 1}. ${cue.sourceText}`
        )
        .join("\n");

    const prompt = `
You are a professional subtitle translator.

Translate the following numbered subtitle lines into ${target}.

IMPORTANT RULES:
- Return exactly one translated string for every numbered line.
- Keep the same order.
- Do NOT merge lines.
- Do NOT split lines.
- Do NOT add explanations.
- Do NOT add numbering inside the translated strings.
- Preserve names, numbers, brands and important English words when appropriate.
- If the target is Myanmar, use natural Myanmar Unicode only, never Zawgyi.
- For Myanmar, translate naturally as a human subtitle translator would.
- Do not translate things that should remain as names.
- Do not invent speech.

SOURCE SUBTITLE LINES:

${numberedText}
`;

    let batchTranslations =
      await translateBatchWithRetry(
        prompt,
        batch.length
      );

    if (
      !Array.isArray(
        batchTranslations
      ) ||
      batchTranslations.length !==
        batch.length
    ) {
      throw new Error(
        `Translation returned ${batchTranslations?.length || 0} lines for ${batch.length} subtitle lines.`
      );
    }

    for (
      let i = 0;
      i < batch.length;
      i++
    ) {
      translated.push({
        ...batch[i],

        text: cleanText(
          batchTranslations[i]
        ),
      });
    }
  }

  return translated;
}

// ----------------------------------------------------
// TRANSLATION RETRY
// ----------------------------------------------------

async function translateBatchWithRetry(
  prompt,
  expectedCount
) {
  let lastError = null;

  for (
    const model of TRANSLATION_MODELS
  ) {
    for (
      let attempt = 1;
      attempt <= 2;
      attempt++
    ) {
      try {
        console.log(
          `Translation model ${model} - attempt ${attempt}`
        );

        const response =
          await ai.models.generateContent(
            {
              model,

              contents: prompt,

              config: {
                responseMimeType:
                  "application/json",

                responseSchema: {
                  type: "array",

                  items: {
                    type: "string",
                  },
                },
              },
            }
          );

        const raw =
          response?.text || "";

        const parsed =
          JSON.parse(raw);

        if (
          Array.isArray(parsed) &&
          parsed.length ===
            expectedCount
        ) {
          return parsed;
        }

        throw new Error(
          `Invalid translation JSON. Expected ${expectedCount} strings.`
        );
      } catch (error) {
        lastError = error;

        console.error(
          `Translation failed with ${model}:`,
          error?.message ||
            error
        );

        if (attempt < 2) {
          await sleep(
            attempt * 3000
          );
        }
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Translation failed."
    )
  );
}

// ----------------------------------------------------
// SRT LINE WRAPPING
// ----------------------------------------------------

function wrapSubtitleText(
  text,
  maxLength = 42
) {
  text = cleanText(text);

  if (!text) return "";

  if (
    text.length <= maxLength
  ) {
    return text;
  }

  // Languages with spaces
  if (/\s/u.test(text)) {
    const words =
      text.split(/\s+/);

    const lines = [];
    let current = "";

    for (const word of words) {
      const candidate =
        current
          ? `${current} ${word}`
          : word;

      if (
        candidate.length <=
        maxLength
      ) {
        current = candidate;
      } else {
        if (current) {
          lines.push(current);
        }

        current = word;
      }
    }

    if (current) {
      lines.push(current);
    }

    if (lines.length <= 2) {
      return lines.join("\n");
    }

    // Keep SRT cue to max 2 lines.
    return (
      lines[0] +
      "\n" +
      lines.slice(1).join(" ")
    );
  }

  // CJK / text without spaces
  let bestBreak =
    maxLength;

  if (
    text.length >
    maxLength * 2
  ) {
    bestBreak =
      Math.min(
        maxLength,
        Math.ceil(
          text.length / 2
        )
      );
  }

  return (
    text.slice(0, bestBreak) +
    "\n" +
    text.slice(bestBreak)
  );
}

// ----------------------------------------------------
// BUILD SRT
// ----------------------------------------------------

function buildSrt(cues) {
  return cues
    .map(
      (cue, index) => {
        let start = cue.start;
        let end = cue.end;

        if (
          end <= start
        ) {
          end =
            start + 1;
        }

        // Prevent overlapping / zero-length cues.
        if (
          end - start <
          0.5
        ) {
          end =
            start + 0.8;
        }

        const text =
          wrapSubtitleText(
            cue.text
          );

        return [
          String(index + 1),

          `${formatSrtTime(
            start
          )} --> ${formatSrtTime(
            end
          )}`,

          text,

          "",
        ].join("\n");
      }
    )
    .join("\n");
}

// ----------------------------------------------------
// SAME LANGUAGE CHECK
// ----------------------------------------------------

function languagesAppearSame(
  sourceLanguage,
  targetLanguage
) {
  const source =
    String(
      sourceLanguage || ""
    ).toLowerCase();

  const target =
    String(
      targetLanguage || ""
    ).toLowerCase();

  if (
    source.includes("auto") ||
    source.includes("detect")
  ) {
    return false;
  }

  if (
    source.includes("chinese") &&
    target.includes("chinese")
  ) {
    return true;
  }

  if (
    source.includes("english") &&
    target.includes("english")
  ) {
    return true;
  }

  if (
    source.includes("thai") &&
    target.includes("thai")
  ) {
    return true;
  }

  if (
    (
      source.includes("myanmar") ||
      source.includes("burmese") ||
      source.includes("မြန်မာ")
    ) &&
    (
      target.includes("myanmar") ||
      target.includes("burmese") ||
      target.includes("မြန်မာ")
    )
  ) {
    return true;
  }

  if (
    source.includes("japanese") &&
    target.includes("japanese")
  ) {
    return true;
  }

  if (
    source.includes("korean") &&
    target.includes("korean")
  ) {
    return true;
  }

  return false;
}

// ----------------------------------------------------
// MAIN GENERATE SRT API
// ----------------------------------------------------

app.post(
  "/api/generate-srt",
  upload.single("media"),
  async (req, res) => {
    const file = req.file;

    let audioPath = null;

    try {
      if (!GEMINI_API_KEY) {
        return res.status(500).json({
          error:
            "Server is missing GEMINI_API_KEY.",
        });
      }

      if (!file) {
        return res.status(400).json({
          error:
            "Please upload a supported video or audio file.",
        });
      }

      const sourceLanguage = (
        req.body.sourceLanguage ||
        "Auto detect"
      ).slice(0, 60);

      const targetLanguage = (
        req.body.targetLanguage ||
        "Myanmar (Burmese)"
      ).slice(0, 60);

      console.log(
        "----------------------------------------"
      );

      console.log(
        "Uploaded file:",
        file.originalname
      );

      console.log(
        "File size:",
        file.size
      );

      console.log(
        "MIME:",
        file.mimetype
      );

      console.log(
        "Source:",
        sourceLanguage
      );

      console.log(
        "Target:",
        targetLanguage
      );

      // ------------------------------------------------
      // 1. VIDEO -> AUDIO
      // ------------------------------------------------

      if (
        isVideoMime(
          file.mimetype
        )
      ) {
        audioPath =
          await extractAudioFromVideo(
            file.path
          );
      } else {
        audioPath = file.path;
      }

      // ------------------------------------------------
      // 2. UPLOAD AUDIO TO GEMINI
      // ------------------------------------------------

      const geminiFile =
        await uploadToGemini(
          audioPath,
          "audio/mp3"
        );

      // ------------------------------------------------
      // 3. WAIT UNTIL ACTIVE
      // ------------------------------------------------

      const activeFile =
        await waitForGeminiFile(
          geminiFile.name
        );

      // ------------------------------------------------
      // 4. TRANSCRIBE + WORD TIMESTAMPS
      // ------------------------------------------------

      const transcription =
        await transcribeAudio(
          activeFile,
          sourceLanguage
        );

      // ------------------------------------------------
      // 5. CREATE TIMESTAMPED SOURCE CUES
      // ------------------------------------------------

      const sourceCues =
        createSourceCues(
          transcription.words
        );

      if (
        !sourceCues.length
      ) {
        throw new Error(
          "No subtitle segments could be created from the transcription."
        );
      }

      console.log(
        "Created source cues:",
        sourceCues.length
      );

      // ------------------------------------------------
      // 6. TRANSLATE
      // ------------------------------------------------

      let finalCues;

      if (
        languagesAppearSame(
          sourceLanguage,
          targetLanguage
        )
      ) {
        finalCues =
          sourceCues.map(
            (cue) => ({
              ...cue,
              text: cue.sourceText,
            })
          );
      } else {
        finalCues =
          await translateCues(
            sourceCues,
            targetLanguage
          );
      }

      // ------------------------------------------------
      // 7. BUILD SRT
      // ------------------------------------------------

      const srt =
        buildSrt(finalCues);

      if (
        !srt ||
        !/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(
          srt
        )
      ) {
        throw new Error(
          "Generated subtitle data is not valid SRT."
        );
      }

      console.log(
        "SRT generated successfully."
      );

      console.log(
        "SRT characters:",
        srt.length
      );

      return res.json({
        srt,
        model: TRANSCRIBE_MODEL,
        cueCount: finalCues.length,
      });
    } catch (error) {
      console.error(
        "FINAL SRT ERROR:",
        error
      );

      const message =
        error?.message ||
        "Failed to generate subtitles.";

      if (
        /503|UNAVAILABLE|high demand|overloaded/i.test(
          message
        )
      ) {
        return res.status(503).json({
          error:
            "Gemini is currently busy. Please try again shortly.",
        });
      }

      if (
        /429|quota|rate limit/i.test(
          message
        )
      ) {
        return res.status(429).json({
          error:
            "Gemini API limit was reached. Please try again later.",
        });
      }

      return res.status(500).json({
        error: message,
      });
    } finally {
      // Delete uploaded temporary file.
      if (
        file?.path
      ) {
        await safeDelete(
          file.path
        );
      }

      // Delete extracted MP3 if it is separate.
      if (
        audioPath &&
        audioPath !== file?.path
      ) {
        await safeDelete(
          audioPath
        );
      }
    }
  }
);

// ----------------------------------------------------
// MULTER / SERVER ERRORS
// ----------------------------------------------------

app.use(
  (
    err,
    _req,
    res,
    _next
  ) => {
    console.error(
      "Express error:",
      err
    );

    if (
      err?.code ===
      "LIMIT_FILE_SIZE"
    ) {
      return res.status(413).json({
        error:
          "File is too large. Maximum size is 500MB.",
      });
    }

    return res.status(400).json({
      error:
        err?.message ||
        "Upload failed.",
    });
  }
);

// ----------------------------------------------------
// START
// ----------------------------------------------------

app.listen(
  PORT,
  () => {
    console.log(
      `AI Subtitle Maker running on port ${PORT}`
    );

    console.log(
      `Transcription model: ${TRANSCRIBE_MODEL}`
    );
  }
);
