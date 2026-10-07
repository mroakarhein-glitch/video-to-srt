const form = document.getElementById("form");
const fileInput = document.getElementById("media");
const fileTitle = document.getElementById("fileTitle");
const fileHint = document.getElementById("fileHint");
const generateBtn = document.getElementById("generateBtn");
const statusBox = document.getElementById("status");
const resultBox = document.getElementById("result");
const output = document.getElementById("output");
const downloadBtn = document.getElementById("downloadBtn");
const copyBtn = document.getElementById("copyBtn");
const dropZone = document.getElementById("dropZone");


/* =========================
   CREATE PROGRESS UI
========================= */

let progressBox =
  document.getElementById("progressBox");

if (!progressBox) {
  progressBox = document.createElement("div");

  progressBox.id = "progressBox";

  progressBox.innerHTML = `
    <div style="
      margin-top:20px;
      padding:18px;
      border-radius:16px;
      background:rgba(255,255,255,.08);
      border:1px solid rgba(255,255,255,.12);
    ">

      <div style="
        display:flex;
        justify-content:space-between;
        align-items:center;
        margin-bottom:10px;
      ">
        <strong id="progressTitle">
          Starting
        </strong>

        <strong id="progressPercent">
          0%
        </strong>
      </div>

      <div style="
        width:100%;
        height:10px;
        background:rgba(255,255,255,.12);
        border-radius:20px;
        overflow:hidden;
      ">
        <div id="progressBar" style="
          width:0%;
          height:100%;
          border-radius:20px;
          background:linear-gradient(
            90deg,
            #00c6ff,
            #8b5cf6
          );
          transition:width .4s ease;
        "></div>
      </div>

      <div id="progressMessage" style="
        margin-top:10px;
        font-size:13px;
        opacity:.8;
      ">
        Preparing your file...
      </div>

    </div>
  `;

  if (form) {
    form.appendChild(progressBox);
  } else {
    document.body.appendChild(progressBox);
  }
}


const progressBar =
  document.getElementById("progressBar");

const progressPercent =
  document.getElementById("progressPercent");

const progressTitle =
  document.getElementById("progressTitle");

const progressMessage =
  document.getElementById("progressMessage");


/* =========================
   HELPERS
========================= */

function showFile(file) {
  if (!file) {
    if (fileTitle) {
      fileTitle.textContent = "No file selected";
    }

    return;
  }

  const sizeMB =
    file.size / 1024 / 1024;

  if (fileTitle) {
    fileTitle.textContent = file.name;
  }

  if (fileHint) {
    fileHint.textContent =
      `${sizeMB.toFixed(1)} MB • Ready to generate`;
  }
}


function updateProgress(
  percent,
  title,
  message
) {
  const value = Math.max(
    0,
    Math.min(100, Number(percent) || 0)
  );

  if (progressBar) {
    progressBar.style.width = `${value}%`;
  }

  if (progressPercent) {
    progressPercent.textContent =
      `${Math.round(value)}%`;
  }

  if (progressTitle) {
    progressTitle.textContent =
      title || "";
  }

  if (progressMessage) {
    progressMessage.textContent =
      message || "";
  }

  progressBox.style.display = "block";
}


function showStatus(
  message,
  type = "info"
) {
  if (!statusBox) return;

  statusBox.textContent = message;
  statusBox.dataset.type = type;
}


function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


function setGenerating(value) {
  if (!generateBtn) return;

  generateBtn.disabled = value;

  if (value) {
    generateBtn.dataset.oldText =
      generateBtn.textContent;

    generateBtn.textContent =
      "Generating...";
  } else {
    generateBtn.textContent =
      generateBtn.dataset.oldText ||
      "Generate SRT";
  }
}


/* =========================
   FILE SELECT
========================= */

if (fileInput) {
  fileInput.addEventListener(
    "change",
    () => {
      showFile(fileInput.files[0]);
    }
  );
}


/* =========================
   DRAG DROP
========================= */

if (dropZone) {
  dropZone.addEventListener(
    "dragover",
    event => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    }
  );

  dropZone.addEventListener(
    "dragleave",
    () => {
      dropZone.classList.remove("dragging");
    }
  );

  dropZone.addEventListener(
    "drop",
    event => {
      event.preventDefault();

      dropZone.classList.remove("dragging");

      const files =
        event.dataTransfer?.files;

      if (!files || !files.length) {
        return;
      }

      try {
        fileInput.files = files;
      } catch (error) {}

      showFile(files[0]);
    }
  );
}


/* =========================
   WATCH JOB
========================= */

async function watchJob(jobId) {

  console.log(
    "Watching job:",
    jobId
  );

  while (true) {

    try {

      const response =
        await fetch(
          `/api/job/${encodeURIComponent(jobId)}`,
          {
            cache: "no-store"
          }
        );

      console.log(
        "Job response:",
        response.status
      );

      const data =
        await response.json();

      console.log(
        "Job data:",
        data
      );


      if (!response.ok) {
        throw new Error(
          data.error ||
          "Could not read job status."
        );
      }


      updateProgress(
        data.progress,
        data.title,
        data.message
      );


      if (data.status === "done") {

        updateProgress(
          100,
          "Complete",
          "SRT generation completed successfully."
        );

        if (output) {
          output.value =
            data.srt || "";
        }

        if (resultBox) {
          resultBox.hidden = false;
          resultBox.style.display = "block";
        }

        showStatus(
          `Done • ${data.cueCount || 0} subtitle segments`,
          "success"
        );

        setGenerating(false);

        return;
      }


      if (data.status === "error") {
        throw new Error(
          data.error ||
          data.message ||
          "SRT generation failed."
        );
      }


      await sleep(700);

    } catch (error) {

      console.error(
        "Job polling error:",
        error
      );

      /*
        Retry connection problems.
        But if the server explicitly says
        the job failed, stop.
      */

      if (
        error.message &&
        !error.message.includes("Failed to fetch")
      ) {
        throw error;
      }

      updateProgress(
        1,
        "Connecting",
        "Waiting for server response..."
      );

      await sleep(1500);
    }
  }
}


/* =========================
   GENERATE SRT
========================= */

if (form) {

  form.addEventListener(
    "submit",
    async event => {

      event.preventDefault();

      console.log(
        "Generate button clicked"
      );


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
        100 * 1024 * 1024;


      if (file.size > maxSize) {

        showStatus(
          "File is larger than 100MB.",
          "error"
        );

        return;
      }


      /*
        RESET
      */

      if (resultBox) {
        resultBox.hidden = true;
        resultBox.style.display = "none";
      }

      if (output) {
        output.value = "";
      }


      /*
        SHOW 0% IMMEDIATELY
      */

      updateProgress(
        0,
        "Starting",
        "Preparing your file..."
      );


      showStatus(
        "Starting AI subtitle generation...",
        "info"
      );


      setGenerating(true);


      try {

        const formData =
          new FormData(form);


        console.log(
          "Uploading:",
          file.name,
          file.size
        );


        /*
          IMPORTANT:
          New backend endpoint.
        */

        const response =
          await fetch(
            "/api/start-job",
            {
              method: "POST",
              body: formData
            }
          );


        console.log(
          "Start-job response:",
          response.status
        );


        const data =
          await response.json();


        console.log(
          "Start-job data:",
          data
        );


        if (!response.ok) {

          throw new Error(
            data.error ||
            `Server error ${response.status}`
          );
        }


        if (!data.ok) {

          throw new Error(
            data.error ||
            "Could not start the job."
          );
        }


        if (!data.jobId) {

          throw new Error(
            "Server did not return a job ID."
          );
        }


        /*
          SHOW 1% / JOB STARTED
        */

        updateProgress(
          1,
          "Job started",
          "AI processing has started..."
        );


        showStatus(
          "AI processing started.",
          "info"
        );


        /*
          WATCH REAL BACKEND PROGRESS
        */

        await watchJob(
          data.jobId
        );

      } catch (error) {

        console.error(
          "Generate error:",
          error
        );


        updateProgress(
          0,
          "Error",
          error.message ||
          "Something went wrong."
        );


        showStatus(
          error.message ||
          "SRT generation failed.",
          "error"
        );


        setGenerating(false);
      }

    }
  );
}


/* =========================
   DOWNLOAD
========================= */

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
        URL.createObjectURL(blob);


      const link =
        document.createElement("a");


      link.href = url;

      link.download =
        "myanmar-subtitles.srt";


      document.body.appendChild(link);

      link.click();

      link.remove();

      URL.revokeObjectURL(url);
    }
  );
}


/* =========================
   COPY
========================= */

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

      } catch (error) {

        output.focus();
        output.select();

        document.execCommand("copy");

        showStatus(
          "SRT copied to clipboard.",
          "success"
        );
      }
    }
  );
}


/* =========================
   INITIAL
========================= */

progressBox.style.display =
  "none";


if (fileInput?.files?.[0]) {
  showFile(
    fileInput.files[0]
  );
}
