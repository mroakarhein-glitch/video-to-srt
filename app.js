```js
const form = document.getElementById("form");
const fileInput = document.getElementById("media");
const generateBtn = document.getElementById("generateBtn");

const status = document.getElementById("status");
const result = document.getElementById("result");
const output = document.getElementById("output");

const downloadBtn = document.getElementById("downloadBtn");
const copyBtn = document.getElementById("copyBtn");

const burnBtn = document.getElementById("burnBtn");
const burnStatus = document.getElementById("burnStatus");

const fileTitle = document.getElementById("fileTitle");
const fileHint = document.getElementById("fileHint");

let currentSrt = "";

/* =========================
   FILE SELECT
========================= */

fileInput?.addEventListener("change", () => {
  const file = fileInput.files?.[0];

  if (!file) return;

  if (file.size > 500 * 1024 * 1024) {
    alert("Maximum file size is 500MB.");
    fileInput.value = "";
    return;
  }

  if (fileTitle) {
    fileTitle.textContent = file.name;
  }

  if (fileHint) {
    fileHint.textContent =
      `${(file.size / 1024 / 1024).toFixed(1)} MB • Ready`;
  }

  currentSrt = "";

  if (burnBtn) burnBtn.disabled = true;
  if (burnStatus) {
    burnStatus.textContent = "";
    burnStatus.style.display = "none";
  }
});

/* =========================
   GENERATE SRT
========================= */

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = fileInput?.files?.[0];

  if (!file) {
    alert("Please upload a video or audio file first.");
    return;
  }

  generateBtn.disabled = true;
  if (burnBtn) burnBtn.disabled = true;

  if (status) {
    status.style.display = "block";
    status.textContent = "Generating SRT... Please wait.";
  }

  if (result) result.style.display = "none";
  if (output) output.value = "";

  currentSrt = "";

  try {
    const data = new FormData(form);

    const response = await fetch("/api/generate-srt", {
      method: "POST",
      body: data
    });

    const json = await response.json();

    if (!response.ok || !json.ok) {
      throw new Error(json.error || "SRT generation failed.");
    }

    if (!json.srt) {
      throw new Error("No SRT file was returned.");
    }

    currentSrt = json.srt;

    if (output) output.value = currentSrt;
    if (result) result.style.display = "block";

    if (status) status.textContent = "SRT ready.";

    downloadBtn.onclick = () => {
      const blob = new Blob(
        ["\uFEFF", currentSrt],
        { type: "application/x-subrip;charset=utf-8" }
      );

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");

      a.href = url;
      a.download =
        file.name.replace(/\.[^/.]+$/, "") + ".srt";

      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(
          output?.value || currentSrt
        );

        copyBtn.textContent = "Copied!";

        setTimeout(() => {
          copyBtn.textContent = "Copy SRT Text";
        }, 1500);
      } catch {
        alert("Copy failed. Please select and copy the SRT text.");
      }
    };

    if (burnBtn) {
      burnBtn.disabled = false;
    }

  } catch (error) {
    console.error(error);

    if (status) {
      status.textContent = "Error: " + error.message;
    }

  } finally {
    generateBtn.disabled = false;
  }
});

/* =========================
   BURN SUBTITLES INTO MP4
========================= */

burnBtn?.addEventListener("click", async () => {
  const file = fileInput?.files?.[0];
  const srt = output?.value || currentSrt;

  if (!file) {
    alert("Please select the original video again.");
    return;
  }

  if (!file.type.startsWith("video/")) {
    alert("Please upload a video file. Audio-only files cannot be burned into a video.");
    return;
  }

  if (!srt.trim()) {
    alert("Please generate SRT first.");
    return;
  }

  burnBtn.disabled = true;
  generateBtn.disabled = true;

  if (burnStatus) {
    burnStatus.style.display = "block";
    burnStatus.textContent =
      "Creating MP4 with subtitles... Please wait.";
  }

  try {
    const data = new FormData();

    data.append("media", file);
    data.append("srt", srt);

    const response = await fetch("/api/burn-subtitles", {
      method: "POST",
      body: data
    });

    if (!response.ok) {
      let message = "Could not create the subtitled MP4.";

      try {
        const errorJson = await response.json();
        message = errorJson.error || message;
      } catch {}

      throw new Error(message);
    }

    const blob = await response.blob();

    if (!blob.size) {
      throw new Error("The MP4 file is empty.");
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download =
      file.name.replace(/\.[^/.]+$/, "") + "-myanmar.mp4";

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 60000);

    if (burnStatus) {
      burnStatus.textContent =
        "MP4 created. Your download should start automatically.";
    }

  } catch (error) {
    console.error(error);

    if (burnStatus) {
      burnStatus.textContent = "Error: " + error.message;
    }

  } finally {
    burnBtn.disabled = false;
    generateBtn.disabled = false;
  }
});
```
