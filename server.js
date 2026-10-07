import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

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

const TRANSCRIBE_MODEL = "gemini-3.5-transcribe-preview";
const TRANSLATION_MODEL = "gemini-3.5-flash-lite";
const TRANSLATION_FALLBACK_MODEL = "gemini-3.5-flash";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

/*
  -------------------------------------------------------
  Job system
  -------------------------------------------------------
*/

const jobs = new Map();

function createJob() {
  const id = randomUUID();

  jobs.set(id, {
    id,
    status: "queued",
    progress: 0,
    title: "Preparing",
    message: "Preparing your file...",
    srt: null,
    model: null,
    cueCount: 0,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  return id;
}

function updateJob(
  jobId,
  progress,
  title,
  message
) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  job.progress = Math.max(
    0,
    Math.min(100, Math.round(progress))
  );

  job.title = title || job.title;
  job.message = message || job.message;
  job.updatedAt = Date.now();
}

function completeJob(
  jobId,
  result
) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  job.status = "done";
  job.progress = 100;
  job.title = "Complete";
  job.message =
    "SRT generation completed successfully.";
  job.srt = result.srt;
  job.model = result.model;
  job.cueCount = result.cueCount;
  job.updatedAt = Date.now();
}

function failJob(
  jobId,
  error
) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  job.status = "error";
  job.title = "Generation failed";
  job.message = error;
  job.error = error;
  job.updatedAt = Date.now();
}

/*
  Automatically remove finished jobs after 30 minutes.
*/

function scheduleJobCleanup(jobId) {
  setTimeout(
    () => {
      jobs.delete(jobId);
    },
    30 * 60 * 1000
  );
}

/*
  -------------------------------------------------------
  Upload configuration
  -------------------------------------------------------
*/

const uploadDir = path.join(
  os.tmpdir(),
  "video-to-srt-uploads"
);

fs.mkdirSync(
  uploadDir,
  {
    recursive: true
  }
);

const storage = multer.diskStorage({
  destination: (
    req,
    file,
    cb
  ) => {
    cb(null, uploadDir);
  },

  filename: (
    req,
    file,
    cb
  ) => {
    const ext =
      path.extname(file.originalname) ||
      ".bin";

    cb(
      null,
      `${Date.now()}-${randomUUID()}${ext}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  },

  fileFilter: (
    req,
    file,
    cb
  ) => {
    const allowed = [
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/x-m4a",
      "audio/wav",
      "audio/x-wav",
      "audio/wave"
    ];

    if (
      allowed.includes(
        file.mimetype
      )
    ) {
      cb(null, true);
      return;
    }

    /*
      Some phones send unusual MIME types.
      Extension check keeps the upload friendly.
    */

    const ext =
      path
        .extname(file.originalname)
        .toLowerCase();

    const allowedExtensions = [
      ".mp4",
      ".mov",
      ".webm",
      ".mp3",
      ".m4a",
      ".wav"
    ];

    if (
      allowedExtensions.includes(ext)
    ) {
      cb(null, true);
      return;
    }

    cb(
      new Error(
        "Unsupported media format."
      )
    );
  }
});

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.static(
    path.join(process.cwd())
  )
);

/*
  -------------------------------------------------------
  Utility
  -------------------------------------------------------
*/

function normalizeLanguage(
  value
) {
  if (
    !value ||
    value === "auto"
  ) {
    return null;
  }

  return String(value)
    .trim()
    .toLowerCase();
}

function getLanguageName(
  code
) {
  const map = {
    my: "Myanmar (Burmese)",
    en: "English",
    zh: "Chinese",
    th: "Thai",
    ja: "Japanese",
    ko: "Korean"
  };

  return (
    map[code] ||
    code ||
    "the target language"
  );
}

function offsetToSeconds(
  value
) {
  if (
    typeof value === "number"
  ) {
    /*
      Gemini timestamps may arrive in
      seconds or microseconds.
    */

    if (value > 100000) {
      return value / 1000000;
    }

    return value;
  }

  if (
    typeof value === "string"
  ) {
    const parsed =
      Number(value);

    if (
      Number.isFinite(parsed)
    ) {
      return offsetToSeconds(
        parsed
      );
    }
  }

  if (
    value &&
    typeof value === "object"
  ) {
    if (
      typeof value.seconds ===
      "number"
    ) {
      const nanos =
        Number(
          value.nanos || 0
        );

      return (
        value.seconds +
        nanos / 1e9
      );
    }

    if (
      typeof value.microseconds ===
      "number"
    ) {
      return (
        value.microseconds /
        1000000
      );
    }
  }

  return 0;
}

function cleanText(
  text
) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatSrtTime(
  seconds
) {
  const safe =
    Math.max(
      0,
      Number(seconds) || 0
    );

  const hours =
    Math.floor(
      safe / 3600
    );

  const minutes =
    Math.floor(
      (safe % 3600) / 60
    );

  const secs =
    Math.floor(
      safe % 60
    );

  const milliseconds =
    Math.floor(
      (safe - Math.floor(safe)) *
        1000
    );

  const pad = (
    value,
    length = 2
  ) =>
    String(value).padStart(
      length,
      "0"
    );

  return (
    `${pad(hours)}:` +
    `${pad(minutes)}:` +
    `${pad(secs)},` +
    `${pad(milliseconds, 3)}`
  );
}

/*
  -------------------------------------------------------
  FFmpeg audio extraction
  -------------------------------------------------------
*/

function extractAudio(
  inputPath,
  outputPath
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const args = [
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
      ];

      const child =
        spawn(
          ffmpegPath,
          args,
          {
            stdio: [
              "ignore",
              "ignore",
              "pipe"
            ]
          }
        );

      let stderr = "";

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();
        }
      );

      child.on(
        "error",
        error => {
          reject(error);
        }
      );

      child.on(
        "close",
        code => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(
            new Error(
              `FFmpeg failed: ${stderr.slice(-2000)}`
            )
          );
        }
      );
    }
  );
}

/*
  -------------------------------------------------------
  Gemini file handling
  -------------------------------------------------------
*/

async function waitForFileActive(
  fileName
) {
  const maxAttempts = 60;

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {
    const file =
      await ai.files.get({
        name: fileName
      });

    const state =
      String(
        file.state || ""
      ).toUpperCase();

    if (
      state === "ACTIVE"
    ) {
      return file;
    }

    if (
      state === "FAILED"
    ) {
      throw new Error(
        "Gemini file processing failed."
      );
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          2000
        )
    );
  }

  throw new Error(
    "Gemini file processing timed out."
  );
}

/*
  -------------------------------------------------------
  Transcription
  -------------------------------------------------------
*/

function extractWordAnnotations(
  interaction
) {
  const annotations = [];

  const contents =
    interaction?.outputs ||
    interaction?.output ||
    [];

  const list = Array.isArray(contents)
    ? contents
    : [contents];

  for (
    const item of list
  ) {
    const itemAnnotations =
      item?.content
        ?.annotations ||
      item?.annotations ||
      [];

    if (
      !Array.isArray(
        itemAnnotations
      )
    ) {
      continue;
    }

    for (
      const annotation of
      itemAnnotations
    ) {
      if (
        annotation?.type !==
        "word_info"
      ) {
        continue;
      }

      const text =
        cleanText(
          annotation.text
        );

      if (!text) {
        continue;
      }

      const start =
        offsetToSeconds(
          annotation.start
        );

      const end =
        offsetToSeconds(
          annotation.end
        );

      if (
        end <= start
      ) {
        continue;
      }

      annotations.push({
        text,
        start,
        end
      });
    }
  }

  return annotations;
}

async function transcribeAudio(
  audioFile,
  sourceLanguage
) {
  const language =
    normalizeLanguage(
      sourceLanguage
    );

  const prompt =
    language
      ? `Transcribe this audio accurately in ${getLanguageName(
          language
        )}.

Return the spoken words verbatim.
Do not translate.
Preserve the original spoken language.
`
      : `Transcribe this audio accurately.

Automatically detect the spoken language.
Return the spoken words verbatim.
Do not translate.
`;

  const input = [
    {
      type: "text",
      text: prompt
    },
    {
      type: "audio",
      uri: audioFile.uri,
      mime_type:
        audioFile.mimeType ||
        "audio/mpeg"
    }
  ];

  const interaction =
    await ai.interactions.create({
      model:
        TRANSCRIBE_MODEL,

      input,

      generation_config: {
        transcription_config: {
          mode: {
            type: "verbatim",
            timestamp_granularities: [
              "word"
            ]
          }
        }
      }
    });

  return interaction;
}
/*
  -------------------------------------------------------
  Translation
  -------------------------------------------------------
*/

async function translateBatch(
  cues,
  targetLanguage
) {
  const languageName =
    getLanguageName(
      targetLanguage
    );

  const cueData =
    cues.map(
      cue => ({
        id: cue.id,
        text: cue.text
      })
    );

  const prompt =
    `Translate the following subtitle segments into ${languageName}.

Rules:
- Translate naturally and accurately.
- Preserve the meaning.
- Do not add explanations.
- Do not remove information.
- Keep the subtitle IDs exactly.
- Return one translation for every ID.

SUBTITLES:
${JSON.stringify(
  cueData
)}`;

  const responseSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: {
          type: "integer"
        },
        translation: {
          type: "string"
        }
      },
      required: [
        "id",
        "translation"
      ]
    }
  };

  let response;

  try {
    response =
      await ai.models.generateContent(
        {
          model:
            TRANSLATION_MODEL,

          contents: prompt,

          config: {
            responseMimeType:
              "application/json",

            responseSchema
          }
        }
      );
  } catch (
    firstError
  ) {
    console.warn(
      "Primary translation model failed. Trying fallback.",
      firstError?.message
    );

    response =
      await ai.models.generateContent(
        {
          model:
            TRANSLATION_FALLBACK_MODEL,

          contents: prompt,

          config: {
            responseMimeType:
              "application/json",

            responseSchema
          }
        }
      );
  }

  const raw =
    response?.text ||
    "";

  let parsed;

  try {
    parsed =
      JSON.parse(raw);
  } catch (
    error
  ) {
    throw new Error(
      "Gemini translation returned invalid JSON."
    );
  }

  if (
    !Array.isArray(parsed)
  ) {
    throw new Error(
      "Gemini translation returned an invalid result."
    );
  }

  const byId =
    new Map();

  for (
    const item of parsed
  ) {
    if (
      Number.isInteger(
        item?.id
      )
    ) {
      byId.set(
        item.id,
        cleanText(
          item.translation
        )
      );
    }
  }

  return cues.map(
    cue => {
      const translated =
        byId.get(
          cue.id
        );

      if (!translated) {
        /*
          If Gemini accidentally misses
          one item, preserve the source
          rather than breaking the SRT.
        */
        return cue.text;
      }

      return translated;
    }
  );
}

/*
  Faster translation:
  - 60 cues per batch
  - 3 batches at the same time
*/

async function translateAllCues(
  cues,
  targetLanguage,
  onProgress
) {
  const BATCH_SIZE = 60;
  const CONCURRENCY = 3;

  if (
    cues.length === 0
  ) {
    return [];
  }

  const batches = [];

  for (
    let i = 0;
    i < cues.length;
    i += BATCH_SIZE
  ) {
    batches.push(
      cues.slice(
        i,
        i + BATCH_SIZE
      )
    );
  }

  const results =
    new Array(
      batches.length
    );

  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index =
        nextIndex++;

      if (
        index >=
        batches.length
      ) {
        return;
      }

      const batch =
        batches[index];

      const translated =
        await translateBatch(
          batch,
          targetLanguage
        );

      results[index] =
        translated;

      completed++;

      const percent =
        65 +
        Math.round(
          (completed /
            batches.length) *
            25
        );

      onProgress(
        percent,
        "Translating",
        `Translating batch ${completed} of ${batches.length}...`
      );
    }
  }

  const workerCount =
    Math.min(
      CONCURRENCY,
      batches.length
    );

  await Promise.all(
    Array.from(
      {
        length:
          workerCount
      },
      () => worker()
    )
  );

  return results.flat();
}

/*
  -------------------------------------------------------
  SRT
  -------------------------------------------------------
*/

function wrapSubtitle(
  text,
  maxChars = 42
) {
  const clean =
    cleanText(text);

  if (
    clean.length <=
    maxChars
  ) {
    return clean;
  }

  const words =
    clean.split(" ");

  const lines = [];
  let line = "";

  for (
    const word of words
  ) {
    const next =
      line
        ? `${line} ${word}`
        : word;

    if (
      next.length >
      maxChars &&
      line
    ) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }

  if (line) {
    lines.push(line);
  }

  if (
    lines.length <= 2
  ) {
    return lines.join("\n");
  }

  return (
    lines
      .slice(0, 2)
      .join("\n")
  );
}

function buildSrt(
  cues,
  translatedTexts
) {
  return cues
    .map(
      (
        cue,
        index
      ) => {
        const text =
          translatedTexts[
            index
          ] ||
          cue.text;

        return (
          `${index + 1}\n` +
          `${formatSrtTime(
            cue.start
          )} --> ${formatSrtTime(
            cue.end
          )}\n` +
          `${wrapSubtitle(
            text
          )}\n`
        );
      }
    )
    .join("\n");
}

/*
  -------------------------------------------------------
  Full SRT generation
  -------------------------------------------------------
*/

async function generateSrt({
  mediaPath,
  sourceLanguage,
  targetLanguage,
  onProgress
}) {
  const progress =
    typeof onProgress ===
    "function"
      ? onProgress
      : () => {};

  const workDir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "video-srt-"
      )
    );

  const audioPath =
    path.join(
      workDir,
      "audio.mp3"
    );

  let uploadedFile =
    null;

  try {
    /*
      1. Extract audio
    */

    progress(
      2,
      "Preparing",
      "Extracting audio from your media..."
    );

    await extractAudio(
      mediaPath,
      audioPath
    );

    progress(
      10,
      "Audio ready",
      "Audio extraction completed."
    );

    /*
      2. Upload to Gemini
    */

    progress(
      12,
      "Uploading",
      "Uploading audio to Gemini..."
    );

    uploadedFile =
      await ai.files.upload({
        file: audioPath,
        config: {
          mimeType:
            "audio/mpeg"
        }
      });

    progress(
      20,
      "Gemini upload",
      "Audio uploaded. Waiting for Gemini..."
    );

    /*
      3. Wait until Gemini file is active
    */

    const activeFile =
      await waitForFileActive(
        uploadedFile.name
      );

    progress(
      28,
      "Ready for transcription",
      "Gemini is ready to transcribe the audio."
    );

    /*
      4. Transcription
    */

    progress(
      30,
      "Transcribing",
      "Gemini is converting speech to text..."
    );

    const interaction =
      await transcribeAudio(
        activeFile,
        sourceLanguage
      );

    progress(
      55,
      "Transcription complete",
      "Speech transcription completed."
    );

    /*
      5. Word timestamps
    */

    const words =
      extractWordAnnotations(
        interaction
      );

    if (
      words.length === 0
    ) {
      throw new Error(
        "Gemini returned no word timing information."
      );
    }

    /*
      6. Build source cues
    */

    const sourceCues =
      buildSourceCues(
        words
      );

    if (
      sourceCues.length === 0
    ) {
      throw new Error(
        "No subtitle cues could be created."
      );
    }

    progress(
      62,
      "Creating subtitles",
      `Created ${sourceCues.length} subtitle segments.`
    );

    /*
      7. Translation
    */

    const normalizedSource =
      normalizeLanguage(
        sourceLanguage
      );

    const normalizedTarget =
      normalizeLanguage(
        targetLanguage
      );

    let translatedTexts;

    if (
      normalizedSource &&
      normalizedTarget &&
      normalizedSource ===
        normalizedTarget
    ) {
      translatedTexts =
        sourceCues.map(
          cue => cue.text
        );

      progress(
        90,
        "Translation skipped",
        "Source and target languages are the same."
      );
    } else {
      progress(
        65,
        "Translating",
        "Translating subtitles in parallel batches..."
      );

      translatedTexts =
        await translateAllCues(
          sourceCues,
          normalizedTarget ||
            "my",
          progress
        );
    }

    /*
      8. Build final SRT
    */

    progress(
      96,
      "Building SRT",
      "Formatting the final subtitle file..."
    );

    const srt =
      buildSrt(
        sourceCues,
        translatedTexts
      );

    progress(
      100,
      "Complete",
      "SRT generation completed successfully."
    );

    return {
      srt,
      model:
        TRANSCRIBE_MODEL,
      cueCount:
        sourceCues.length
    };
  } finally {
    /*
      Delete Gemini uploaded file.
    */

    if (
      uploadedFile?.name
    ) {
      try {
        await ai.files.delete({
          name:
            uploadedFile.name
        });
      } catch (
        error
      ) {
        console.warn(
          "Could not delete Gemini file:",
          error?.message
        );
      }
    }

    /*
      Remove temporary files.
    */

    try {
      fs.rmSync(
        workDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch (
      error
    ) {
      console.warn(
        "Could not clean work directory:",
        error?.message
      );
    }
  }
}

/*
  -------------------------------------------------------
  Start Job
  -------------------------------------------------------
*/

app.post(
  "/api/start-job",
  upload.any(),
  async (
    req,
    res
  ) => {
    let mediaFile =
      null;

    try {
      const files =
        Array.isArray(
          req.files
        )
          ? req.files
          : [];

      mediaFile =
        files.find(
          file =>
            [
              "media",
              "file",
              "video",
              "audio"
            ].includes(
              file.fieldname
            )
        ) ||
        files[0];

      if (!mediaFile) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "No media file was uploaded."
          });
      }

      const jobId =
        createJob();

      const sourceLanguage =
        req.body?.sourceLanguage ||
        "auto";

      const targetLanguage =
        req.body?.targetLanguage ||
        "my";

      updateJob(
        jobId,
        1,
        "Preparing",
        "Upload received. Starting subtitle generation..."
      );

      /*
        Return immediately.
        The heavy work continues in background.
      */

      res.status(202).json({
        ok: true,
        jobId
      });

      /*
        Start background processing.
      */

      generateSrt({
        mediaPath:
          mediaFile.path,

        sourceLanguage,

        targetLanguage,

        onProgress: (
          progress,
          title,
          message
        ) => {
          updateJob(
            jobId,
            progress,
            title,
            message
          );
        }
      })
        .then(
          result => {
            completeJob(
              jobId,
              result
            );

            scheduleJobCleanup(
              jobId
            );
          }
        )
        .catch(
          error => {
            console.error(
              `Job ${jobId} failed:`,
              error
            );

            failJob(
              jobId,
              error?.message ||
                "SRT generation failed."
            );

            scheduleJobCleanup(
              jobId
            );
          }
        )
        .finally(
          () => {
            try {
              fs.unlinkSync(
                mediaFile.path
              );
            } catch (
              error
            ) {
              /*
                File may already have been removed.
              */
            }
          }
        );
    } catch (
      error
    ) {
      console.error(
        error
      );

      if (
        mediaFile?.path
      ) {
        try {
          fs.unlinkSync(
            mediaFile.path
          );
        } catch (
          cleanupError
        ) {}
      }

      if (
        !res.headersSent
      ) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              error?.message ||
              "Could not start job."
          });
      }
    }
  }
);

/*
  -------------------------------------------------------
  Job Status
  -------------------------------------------------------
*/

app.get(
  "/api/job/:jobId",
  (
    req,
    res
  ) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Job not found or expired."
        });
    }

    return res.json({
      ok: true,

      jobId:
        job.id,

      status:
        job.status,

      progress:
        job.progress,

      title:
        job.title,

      message:
        job.message,

      srt:
        job.status === "done"
          ? job.srt
          : null,

      model:
        job.status === "done"
          ? job.model
          : null,

      cueCount:
        job.status === "done"
          ? job.cueCount
          : 0,

      error:
        job.status === "error"
          ? job.error
          : null
    });
  }
);

/*
  -------------------------------------------------------
  Health
  -------------------------------------------------------
*/

app.get(
  "/health",
  (
    req,
    res
  ) => {
    res.json({
      ok: true,
      service:
        "video-to-srt",
      transcriptionModel:
        TRANSCRIBE_MODEL,
      translationModel:
        TRANSLATION_MODEL
    });
  }
);

/*
  -------------------------------------------------------
  Error handler
  -------------------------------------------------------
*/

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Server error:",
      error
    );

    if (
      error?.code ===
      "LIMIT_FILE_SIZE"
    ) {
      return res
        .status(413)
        .json({
          ok: false,
          error:
            "File is too large. Maximum size is 100MB."
        });
    }

    return res
      .status(500)
      .json({
        ok: false,
        error:
          error?.message ||
          "Internal server error."
      });
  }
);

/*
  -------------------------------------------------------
  Start server
  -------------------------------------------------------
*/

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

    console.log(
      `Translation model: ${TRANSLATION_MODEL}`
    );
  }
);
