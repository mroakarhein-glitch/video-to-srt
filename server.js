import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  dest: path.join(os.tmpdir(), 'video-srt-uploads'),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'video/mp4','video/quicktime','video/webm',
      'audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav','audio/webm'
    ];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

function cleanSrt(text) {
  let out = String(text || '').trim();
  out = out.replace(/^```(?:srt|text)?\s*/i, '').replace(/```$/i, '').trim();
  return out;
}

app.post('/api/generate-srt', upload.single('media'), async (req, res) => {
  const file = req.file;
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
    }
    if (!file) return res.status(400).json({ error: 'Please upload a supported video or audio file.' });

    const targetLanguage = (req.body.targetLanguage || 'Myanmar (Burmese)').slice(0, 60);
    const sourceLanguage = (req.body.sourceLanguage || 'Auto detect').slice(0, 60);
    const buffer = fs.readFileSync(file.path);
    const base64 = buffer.toString('base64');

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are a professional subtitle generator.\n\nTask:\n1. Transcribe the spoken audio from the attached media.\n2. Source language: ${sourceLanguage}. If Auto detect, detect it yourself.\n3. Translate the subtitle text into ${targetLanguage}. If source and target are the same, keep natural transcription without unnecessary translation.\n4. Return ONLY valid SRT text. No markdown, no notes.\n5. Use sequential numeric indexes.\n6. Use timestamps exactly in SRT format HH:MM:SS,mmm --> HH:MM:SS,mmm.\n7. Keep subtitle chunks natural and readable, normally 1-2 short lines per cue.\n8. Do not invent speech that is not audible.\n9. Preserve names and important English terms when appropriate.\n10. For Myanmar output, use natural Unicode Myanmar language, not Zawgyi.`;

    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType: file.mimetype, data: base64 } }
    ]);

    const srt = cleanSrt(result.response.text());
    if (!srt || !/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(srt)) {
      return res.status(502).json({ error: 'AI did not return valid SRT. Try a shorter or clearer media file.' });
    }

    res.json({ srt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || 'Failed to generate subtitles.' });
  } finally {
    if (file?.path) fs.promises.unlink(file.path).catch(() => {});
  }
});

app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large. Maximum size is 100MB.' });
  res.status(400).json({ error: err?.message || 'Upload failed.' });
});

app.listen(PORT, () => console.log(`Video to SRT running on http://localhost:${PORT}`));
