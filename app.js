const API_BASE =
  "https://video-to-srt-54xt.onrender.com";

const form =
  document.getElementById("form");

const fileInput =
  document.getElementById("media");

const fileTitle =
  document.getElementById("fileTitle");

const fileHint =
  document.getElementById("fileHint");

const generateBtn =
  document.getElementById("generateBtn");

const status =
  document.getElementById("status");

const progressBox =
  document.getElementById("progressBox");

const progressBar =
  document.getElementById("progressBar");

const progressPercent =
  document.getElementById("progressPercent");

const progressTitle =
  document.getElementById("progressTitle");

const progressMessage =
  document.getElementById("progressMessage");

const result =
  document.getElementById("result");

const output =
  document.getElementById("output");

const downloadBtn =
  document.getElementById("downloadBtn");

const copyBtn =
  document.getElementById("copyBtn");

const dropZone =
  document.getElementById("dropZone");

let currentSrt = "";

let pollTimer = null;

let displayedProgress = 0;

function setProgress(
  value,
  title = "",
  message = ""
) {
  const safeValue = Math.max(
    0,
    Math.min(100, Math.round(value))
  );

  displayedProgress = safeValue;

  if (progressBar) {
    progressBar.style.width =
      `${safeValue}%`;
  }

  if (progressPercent) {
    progressPercent.textContent =
      `${safeValue}%`;
  }

  if (progressTitle) {
    progressTitle.textContent =
      title;
  }

  if (progressMessage) {
    progressMessage.textContent =
      message;
  }
}

function showFile(file) {
  if (!file) return;

  const maxSize =
    100 * 1024 * 1024;

  if (file.size > maxSize) {
    alert(
      "File size must be 100MB or less."
    );

    fileInput.value = "";

    return;
  }

  if (fileTitle) {
    fileTitle.textContent =
      file.name;
  }

  if (fileHint) {
    fileHint.textContent =
      `${(
        file.size /
        1024 /
        1024
      ).toFixed(1)} MB • Ready to generate`;
  }
}

if (fileInput) {
  fileInput.addEventListener(
    "change",
    () => {
      showFile(
        fileInput.files?.[0]
      );
    }
  );
}

if (dropZone) {
  dropZone.addEventListener(
    "dragover",
    (event) => {
      event.preventDefault();
    }
  );

  dropZone.addEventListener(
    "drop",
    (event) => {
      event.preventDefault();

      const file =
        event.dataTransfer.files?.[0];

      if (!file) return;

      try {
        const dt =
          new DataTransfer();

        dt.items.add(file);

        fileInput.files =
          dt.files;
      } catch {}

      showFile(file);
    }
  );
}

function getValue(id, fallback) {
  const element =
    document.getElementById(id);

  return element?.value || fallback;
}

function downloadSrt(text) {
  const blob =
    new Blob(
      [text],
      {
        type:
          "application/x-subrip;charset=utf-8"
      }
    );

  const url =
    URL.createObjectURL(blob);

  const a =
    document.createElement("a");

  a.href = url;

  a.download =
    "myanmar-subtitles.srt";

  document.body.appendChild(a);

  a.click();

  a.remove();

  URL.revokeObjectURL(url);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startSmoothProgress() {
  stopPolling();

  pollTimer =
    setInterval(() => {
      if (
        displayedProgress >= 98
      ) {
        return;
      }

      displayedProgress += 1;

      setProgress(
        displayedProgress,
        "Generating SRT",
        "AI is processing your video..."
      );
    }, 1200);
}

async function checkJob(jobId) {
  try {
    const response =
      await fetch(
        `${API_BASE}/api/job/${jobId}`
      );

    const data =
      await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(
        data.error ||
        "Could not read job status."
      );
    }

    const serverProgress =
      Number(data.progress || 0);

    if (
      serverProgress >
      displayedProgress
    ) {
      setProgress(
        serverProgress,
        data.title,
        data.message
      );
    }

    if (
      data.status ===
      "completed"
    ) {
      stopPolling();

      setProgress(
        100,
        "Complete",
        "SRT generation completed successfully."
      );

      currentSrt =
        data.srt || "";

      if (output) {
        output.value =
          currentSrt;
      }

      if (result) {
        result.hidden = false;
      }

      if (status) {
        status.textContent =
          "SRT Ready";
      }

      generateBtn.disabled =
        false;

      return;
    }

    if (
      data.status ===
      "failed"
    ) {
      stopPolling();

      throw new Error(
        data.message ||
        "SRT generation failed."
      );
    }
  } catch (error) {
    stopPolling();

    generateBtn.disabled =
      false;

    if (status) {
      status.textContent =
        "Error";
    }

    setProgress(
      displayedProgress,
      "Error",
      error.message
    );

    console.error(error);
  }
}

if (form) {
  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const file =
        fileInput?.files?.[0];

      if (!file) {
        alert(
          "Please upload a video first."
        );

        return;
      }

      stopPolling();

      currentSrt = "";

      generateBtn.disabled =
        true;

      if (result) {
        result.hidden = true;
      }

      if (output) {
        output.value = "";
      }

      if (status) {
        status.textContent =
          "Generating...";
      }

      setProgress(
        0,
        "Starting",
        "Preparing your video..."
      );

      if (progressBox) {
        progressBox.hidden = false;
      }

      const formData =
        new FormData();

      formData.append(
        "media",
        file
      );

      formData.append(
        "sourceLanguage",
        getValue(
          "sourceLanguage",
          "auto"
        )
      );

      formData.append(
        "targetLanguage",
        getValue(
          "targetLanguage",
          "Myanmar (Burmese)"
        )
      );

      try {
        setProgress(
          1,
          "Uploading",
          "Uploading video..."
        );

        const response =
          await fetch(
            `${API_BASE}/api/start-job`,
            {
              method: "POST",
              body: formData
            }
          );

        const data =
          await response.json();

        if (
          !response.ok ||
          !data.ok
        ) {
          throw new Error(
            data.error ||
            "Could not start SRT generation."
          );
        }

        setProgress(
          2,
          "Started",
          "SRT generation started..."
        );

        startSmoothProgress();

        await checkJob(
          data.jobId
        );

        pollTimer =
          setInterval(
            () => {
              checkJob(
                data.jobId
              );
            },
            1500
          );
      } catch (error) {
        stopPolling();

        generateBtn.disabled =
          false;

        setProgress(
          0,
          "Error",
          error.message
        );

        if (status) {
          status.textContent =
            "Error";
        }

        console.error(error);
      }
    }
  );
}

if (downloadBtn) {
  downloadBtn.addEventListener(
    "click",
    () => {
      if (!currentSrt) return;

      downloadSrt(
        currentSrt
      );
    }
  );
}

if (copyBtn) {
  copyBtn.addEventListener(
    "click",
    async () => {
      if (!currentSrt) return;

      try {
        await navigator.clipboard.writeText(
          currentSrt
        );

        copyBtn.textContent =
          "Copied";

        setTimeout(() => {
          copyBtn.textContent =
            "Copy";
        }, 1500);
      } catch {
        alert(
          "Could not copy SRT."
        );
      }
    }
  );
}
