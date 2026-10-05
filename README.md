# Video → SRT Website

Mobile-first website that uploads a video/audio file and generates an editable/downloadable SRT using Gemini.

## Setup

1. Install Node.js 18+.
2. Open this project folder.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Put your Gemini API key in `.env`:
   `GEMINI_API_KEY=...`
6. Run `npm start`.
7. Open `http://localhost:3000`.

## Deploy

Use a Node.js host such as Replit, Render, Railway, or another service that supports environment variables. Add `GEMINI_API_KEY` as a secret/environment variable.

GitHub Pages alone cannot run this backend endpoint because it is static hosting.

## Supported files

MP4, MOV, WEBM, MP3, M4A, WAV (maximum 100MB in this starter).

## Security

Never put the Gemini API key in `public/app.js` or `index.html`. Keep it in the server environment only.
