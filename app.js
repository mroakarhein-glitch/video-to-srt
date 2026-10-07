const form =
  document.getElementById(
    "form"
  );

const fileInput =
  document.getElementById(
    "media"
  );

const fileTitle =
  document.getElementById(
    "fileTitle"
  );

const fileHint =
  document.getElementById(
    "fileHint"
  );

const generateBtn =
  document.getElementById(
    "generateBtn"
  );

const statusBox =
  document.getElementById(
    "status"
  );

const progressBox =
  document.getElementById(
    "progressBox"
  );

const progressBar =
  document.getElementById(
    "progressBar"
  );

const progressPercent =
  document.getElementById(
    "progressPercent"
  );

const progressTitle =
  document.getElementById(
    "progressTitle"
  );

const progressMessage =
  document.getElementById(
    "progressMessage"
  );

const resultBox =
  document.getElementById(
    "result"
  );

const output =
  document.getElementById(
    "output"
  );

const downloadBtn =
  document.getElementById(
    "downloadBtn"
  );

const copyBtn =
  document.getElementById(
    "copyBtn"
  );

const dropZone =
  document.getElementById(
    "dropZone"
  );


/*
  -------------------------------------------------------
  Helpers
  -------------------------------------------------------
*/

function showFile(
  file
) {
  if (!file) {
    fileTitle.textContent =
      "No file selected";

    fileHint.textContent =
      "MP4, MOV, WEBM, MP3, M4A, WAV • Max 100MB";

    return;
  }

  const sizeMB =
    file.size /
    1024 /
    1024;

  fileTitle.textContent =
    file.name;

  fileHint.textContent =
    `${sizeMB.toFixed(
      1
    )} MB • Ready to generate`;
}

function showStatus(
  message,
  type = "info"
) {
  if (!statusBox) {
    return;
  }

  statusBox.textContent =
    message;

  statusBox.dataset.type =
    type;
}

function showProgress() {
  if (progressBox) {
    progressBox.hidden =
      false;
  }

  updateProgress(
    0,
    "Starting",
    "Preparing your file..."
  );
}

function updateProgress(
  percent,
  title,
  message
) {
  const value =
    Math.max(
      0,
      Math.min(
        100,
        Number(percent) || 0
      )
    );

  if (progressBar) {
    progressBar.style.width =
      `${value}%`;
  }

  if (progressPercent) {
    progressPercent.textContent =
      `${Math.round(
        value
      )}%`;
  }

  if (progressTitle) {
    progressTitle.textContent =
      title || "";
  }

  if (progressMessage) {
    progressMessage.textContent =
      message || "";
  }
}

function sleep(
  ms
) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function setGenerating(
  value
) {
  if (!generateBtn) {
    return;
  }

  generateBtn.disabled =
    value;

  if (value) {
    generateBtn.dataset.originalText =
      generateBtn.textContent;

    generateBtn.textContent =
      "Generating...";
  } else {
    generateBtn.textContent =
      generateBtn.dataset.originalText ||
      "Generate SRT";
  }
}


/*
  -------------------------------------------------------
  File selection
  -------------------------------------------------------
*/

if (fileInput) {
  fileInput.addEventListener(
    "change",
    () => {
      showFile(
        fileInput.files[0]
      );
    }
  );
}


/*
  -------------------------------------------------------
  Drag and drop
  -------------------------------------------------------
*/

if (dropZone) {
  dropZone.addEventListener(
    "dragover",
    event => {
      event.preventDefault();

      dropZone.classList.add(
        "dragging"
      );
    }
  );

  dropZone.addEventListener(
    "dragleave",
    () => {
      dropZone.classList.remove(
        "dragging"
      );
    }
  );

  dropZone.addEventListener(
    "drop",
    event => {
      event.preventDefault();

      dropZone.classList.remove(
        "dragging"
      );

      const files =
        event.dataTransfer?.files;

      if (
        !files ||
        !files.length
      ) {
        return;
      }

      try {
        fileInput.files =
          files;
      } catch (
        error
      ) {
        /*
          Some browsers do not allow
          direct assignment.
          The normal file picker
          remains available.
        */
      }

      showFile(
        files[0]
      );
    }
  );
}


/*
  -------------------------------------------------------
  Watch backend job
  -------------------------------------------------------
*/

async function watchJob(
  jobId
) {
  while (true) {
    let response;

    try {
      response =
        await fetch(
          `/api/job/${encodeURIComponent(
            jobId
          )}`,
          {
            method: "GET",
            cache: "no-store"
          }
        );
    } catch (
      error
    ) {
      showStatus(
        "Connection temporarily lost. Retrying...",
        "warning"
      );

      await sleep(
        1500
      );

      continue;
    }

    let data;

    try {
      data =
        await response.json();
    } catch (
      error
    ) {
      showStatus(
        "Invalid server response. Retrying...",
        "error"
      );

      await sleep(
        1500
      );

      continue;
    }

    if (!response.ok) {
      throw new Error(
        data?.error ||
          "Could not read job status."
      );
    }

    updateProgress(
      data.progress,
      data.title,
      data.message
    );

    if (
      data.status ===
      "done"
    ) {
      updateProgress(
        100,
        "Complete",
        "SRT generation completed successfully."
      );

      output.value =
        data.srt || "";

      resultBox.hidden =
        false;

      showStatus(
        `Done • ${data.cueCount || 0} subtitle segments`,
        "success"
      );

      setGenerating(
        false
      );

      return data;
    }

    if (
      data.status ===
      "error"
    ) {
      throw new Error(
        data.error ||
          data.message ||
          "SRT generation failed."
      );
    }

    await sleep(
      700
    );
  }
}


/*
  -------------------------------------------------------
  Generate
  -------------------------------------------------------
*/

if (form) {
  form.addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const file =
        fileInput?.files?.[0];

      if (!file) {
        showStatus(
          "Please select a video or audio file first.",
          "error"
        );

        return;
      }

      const maxSize =
        100 *
        1024 *
        1024;

      if (
        file.size >
        maxSize
      ) {
        showStatus(
          "File is larger than 100MB.",
          "error"
        );

        return;
      }

      /*
        Reset result
      */

      if (resultBox) {
        resultBox.hidden =
          true;
      }

      if (output) {
        output.value =
          "";
      }

      showProgress();

      showStatus(
        "Uploading and starting AI processing...",
        "info"
      );

      setGenerating(
        true
      );

      try {
        const data =
          new FormData(
            form
          );

        /*
          IMPORTANT:
          The backend now creates a job
          and returns immediately.
        */

        const response =
          await fetch(
            "/api/start-job",
            {
              method: "POST",
              body: data
            }
          );

        let result;

        try {
          result =
            await response.json();
        } catch (
          error
        ) {
          throw new Error(
            "Server returned an invalid response."
          );
        }

        if (
          !response.ok ||
          !result.ok
        ) {
          throw new Error(
            result?.error ||
              "Could not start SRT generation."
          );
        }

        const jobId =
          result.jobId;

        if (!jobId) {
          throw new Error(
            "Server did not return a job ID."
          );
        }

        showStatus(
          "AI processing started.",
          "info"
        );

        /*
          Poll every ~700ms.
          Backend provides real stage progress.
        */

        await watchJob(
          jobId
        );
      } catch (
        error
      ) {
        console.error(
          error
        );

        updateProgress(
          0,
          "Error",
          error?.message ||
            "Something went wrong."
        );

        showStatus(
          error?.message ||
            "SRT generation failed.",
          "error"
        );

        setGenerating(
          false
        );
      }
    }
  );
}


/*
  -------------------------------------------------------
  Download SRT
  -------------------------------------------------------
*/

if (downloadBtn) {
  downloadBtn.addEventListener(
    "click",
    () => {
      const text =
        output?.value || "";

      if (!text.trim()) {
        showStatus(
          "There is no SRT content to download.",
          "error"
        );

        return;
      }

      const blob =
        new Blob(
          [text],
          {
            type:
              "text/plain;charset=utf-8"
          }
        );

      const url =
        URL.createObjectURL(
          blob
        );

      const link =
        document.createElement(
          "a"
        );

      link.href =
        url;

      link.download =
        "myanmar-subtitles.srt";

      document.body.appendChild(
        link
      );

      link.click();

      link.remove();

      URL.revokeObjectURL(
        url
      );
    }
  );
}


/*
  -------------------------------------------------------
  Copy SRT
  -------------------------------------------------------
*/

if (copyBtn) {
  copyBtn.addEventListener(
    "click",
    async () => {
      const text =
        output?.value || "";

      if (!text.trim()) {
        return;
      }

      try {
        await navigator.clipboard.writeText(
          text
        );

        showStatus(
          "SRT copied to clipboard.",
          "success"
        );
      } catch (
        error
      ) {
        /*
          Fallback for older browsers.
        */

        output.focus();

        output.select();

        document.execCommand(
          "copy"
        );

        showStatus(
          "SRT copied to clipboard.",
          "success"
        );
      }
    }
  );
}


/*
  -------------------------------------------------------
  Initial state
  -------------------------------------------------------
*/

if (
  fileInput?.files?.[0]
) {
  showFile(
    fileInput.files[0]
  );
}

if (progressBox) {
  progressBox.hidden =
    true;
}

if (resultBox) {
  resultBox.hidden =
    true;
}
