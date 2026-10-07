document.addEventListener("DOMContentLoaded", () => {
  const API_BASE = "https://video-to-srt-54xt.onrender.com";

  // =========================
  // ELEMENTS
  // =========================

  const form = document.getElementById("form");
  const fileInput = document.getElementById("media");
  const fileTitle = document.getElementById("fileTitle");
  const fileHint = document.getElementById("fileHint");

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

  const sourceLanguage =
    document.getElementById("sourceLanguage");

  const targetLanguage =
    document.getElementById("targetLanguage");


  // =========================
  // STATE
  // =========================

  let currentSrt = "";

  let currentJobId = null;

  let pollingTimer = null;

  let progressTimer = null;

  let currentProgress = 0;

  let generating = false;


  // =========================
  // INITIAL STATE
  // =========================

  // IMPORTANT:
  // If the HTML button has disabled="disabled",
  // enable it here so the user can click Generate.
  if (generateBtn) {
    generateBtn.disabled = false;
    generateBtn.removeAttribute("disabled");
  }

  if (progressBox) {
    progressBox.hidden = true;
  }

  if (result) {
    result.hidden = true;
  }


  // =========================
  // PROGRESS
  // =========================

  function setProgress(
    value,
    title = "",
    message = ""
  ) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return;
    }

    currentProgress = Math.max(
      0,
      Math.min(100, Math.round(number))
    );

    if (progressBar) {
      progressBar.style.width =
        `${currentProgress}%`;
    }

    if (progressPercent) {
      progressPercent.textContent =
        `${currentProgress}%`;
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


  // =========================
  // PROGRESS ANIMATION
  // =========================

  function stopProgressAnimation() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }


  function startProgressAnimation() {
    stopProgressAnimation();

    progressTimer = setInterval(() => {

      if (!generating) {
        return;
      }

      /*
       * UI progress only.
       *
       * Backend progress will override this
       * whenever the server reports a higher value.
       *
       * Never automatically reach 100 here.
       */
      if (currentProgress < 95) {

        currentProgress += 1;

        setProgress(
          currentProgress,
          "Generating SRT",
          "AI is processing your video..."
        );
      }

    }, 1000);
  }


  // =========================
  // FILE INFORMATION
  // =========================

  function showFile(file) {

    if (!file) {
      return;
    }

    const maxSize =
      100 * 1024 * 1024;

    if (file.size > maxSize) {

      alert(
        "File size must be 100MB or less."
      );

      if (fileInput) {
        fileInput.value = "";
      }

      if (fileTitle) {
        fileTitle.textContent =
          "Choose a video file";
      }

      if (fileHint) {
        fileHint.textContent =
          "MP4, MOV, WEBM, MP3, M4A, WAV • Max 100MB";
      }

      if (generateBtn) {
        generateBtn.disabled = true;
      }

      return;
    }

    // Enable Generate immediately.
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.removeAttribute("disabled");
    }

    if (fileTitle) {
      fileTitle.textContent =
        file.name;
    }

    if (fileHint) {

      const sizeMB =
        (
          file.size /
          1024 /
          1024
        ).toFixed(1);

      fileHint.textContent =
        `${sizeMB} MB • Ready to generate`;
    }

    console.log(
      "Selected file:",
      file.name,
      file.size
    );
  }


  // =========================
  // FILE INPUT
  // =========================

  if (fileInput) {

    fileInput.addEventListener(
      "change",
      () => {

        const file =
          fileInput.files?.[0];

        showFile(file);
      }
    );
  }


  // =========================
  // DRAG & DROP
  // =========================

  if (dropZone) {

    dropZone.addEventListener(
      "dragover",
      (event) => {
        event.preventDefault();
        dropZone.classList.add(
          "drag-over"
        );
      }
    );


    dropZone.addEventListener(
      "dragleave",
      () => {
        dropZone.classList.remove(
          "drag-over"
        );
      }
    );


    dropZone.addEventListener(
      "drop",
      (event) => {

        event.preventDefault();

        dropZone.classList.remove(
          "drag-over"
        );

        const file =
          event.dataTransfer?.files?.[0];

        if (!file) {
          return;
        }

        try {

          const dataTransfer =
            new DataTransfer();

          dataTransfer.items.add(file);

          fileInput.files =
            dataTransfer.files;

        } catch (error) {

          console.warn(
            "Could not assign dropped file:",
            error
          );
        }

        showFile(file);
      }
    );
  }


  // =========================
  // SELECT VALUES
  // =========================

  function getSourceLanguage() {

    if (!sourceLanguage) {
      return "auto";
    }

    return (
      sourceLanguage.value ||
      "auto"
    );
  }


  function getTargetLanguage() {

    if (!targetLanguage) {
      return "Myanmar (Burmese)";
    }

    return (
      targetLanguage.value ||
      "Myanmar (Burmese)"
    );
  }


  // =========================
  // STOP POLLING
  // =========================

  function stopPolling() {

    if (pollingTimer) {

      clearInterval(
        pollingTimer
      );

      pollingTimer = null;
    }
  }


  // =========================
  // RESET
  // =========================

  function resetForNewJob() {

    stopPolling();

    stopProgressAnimation();

    currentJobId = null;

    currentSrt = "";

    currentProgress = 0;

    if (output) {
      output.value = "";
    }

    if (result) {
      result.hidden = true;
    }

    if (progressBox) {
      progressBox.hidden = false;
    }

    setProgress(
      0,
      "Starting",
      "Preparing your video..."
    );
  }


  // =========================
  // DOWNLOAD SRT
  // =========================

  function downloadSrt() {

    if (!currentSrt) {

      alert(
        "SRT is not ready yet."
      );

      return;
    }

    const blob =
      new Blob(
        [currentSrt],
        {
          type:
            "application/x-subrip;charset=utf-8"
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


  // =========================
  // COPY SRT
  // =========================

  async function copySrt() {

    if (!currentSrt) {
      return;
    }

    try {

      await navigator.clipboard.writeText(
        currentSrt
      );

      if (copyBtn) {

        const oldText =
          copyBtn.textContent;

        copyBtn.textContent =
          "Copied";

        setTimeout(() => {

          copyBtn.textContent =
            oldText || "Copy";

        }, 1500);
      }

    } catch (error) {

      console.error(
        "Copy failed:",
        error
      );

      alert(
        "Could not copy SRT."
      );
    }
  }


  // =========================
  // CHECK JOB
  // =========================

  async function checkJob() {

    if (!currentJobId) {
      return false;
    }

    try {

      const response =
        await fetch(
          `${API_BASE}/api/job/${currentJobId}`,
          {
            method: "GET",
            cache: "no-store"
          }
        );

      const data =
        await response.json();

      if (!response.ok || !data.ok) {

        throw new Error(
          data.error ||
          data.message ||
          "Could not read job status."
        );
      }


      // Server progress.
      const serverProgress =
        Number(
          data.progress || 0
        );


      // Never move backwards.
      if (
        serverProgress >
        currentProgress
      ) {

        setProgress(
          serverProgress,
          data.title ||
            "Generating SRT",
          data.message ||
            "AI is processing your video..."
        );
      }


      // =========================
      // COMPLETED
      // =========================

      if (
        data.status ===
        "completed"
      ) {

        generating = false;

        stopPolling();

        stopProgressAnimation();

        currentSrt =
          data.srt || "";

        setProgress(
          100,
          "Complete",
          "SRT generation completed successfully."
        );

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

        if (generateBtn) {
          generateBtn.disabled = false;
          generateBtn.removeAttribute(
            "disabled"
          );
          generateBtn.textContent =
            "Generate SRT";
        }

        return true;
      }


      // =========================
      // FAILED
      // =========================

      if (
        data.status ===
        "failed"
      ) {

        throw new Error(
          data.message ||
          "SRT generation failed."
        );
      }


      return false;

    } catch (error) {

      generating = false;

      stopPolling();

      stopProgressAnimation();

      console.error(
        "Job error:",
        error
      );

      if (status) {
        status.textContent =
          "Error";
      }

      setProgress(
        currentProgress,
        "Error",
        error.message ||
          "Something went wrong."
      );

      if (generateBtn) {
        generateBtn.disabled = false;
        generateBtn.removeAttribute(
          "disabled"
        );
        generateBtn.textContent =
          "Generate SRT";
      }

      return true;
    }
  }


  // =========================
  // START POLLING
  // =========================

  function startPolling() {

    stopPolling();

    /*
     * Check immediately.
     */
    checkJob();


    /*
     * Then check every 1.5 seconds.
     */
    pollingTimer =
      setInterval(
        async () => {

          const finished =
            await checkJob();

          if (finished) {
            stopPolling();
          }

        },
        1500
      );
  }


  // =========================
  // GENERATE SRT
  // =========================

  if (form) {

    form.addEventListener(
      "submit",
      async (event) => {

        event.preventDefault();

        console.log(
          "Generate SRT clicked"
        );


        // Prevent double click.
        if (generating) {
          return;
        }


        // Get file.
        const file =
          fileInput?.files?.[0];


        if (!file) {

          alert(
            "Please upload a video first."
          );

          return;
        }


        // File size check.
        const maxSize =
          100 * 1024 * 1024;

        if (file.size > maxSize) {

          alert(
            "File size must be 100MB or less."
          );

          return;
        }


        // =========================
        // START
        // =========================

        generating = true;

        resetForNewJob();


        if (generateBtn) {

          generateBtn.disabled =
            true;

          generateBtn.textContent =
            "Generating...";
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


        // =========================
        // FORM DATA
        // =========================

        const formData =
          new FormData();

        formData.append(
          "media",
          file
        );

        formData.append(
          "sourceLanguage",
          getSourceLanguage()
        );

        formData.append(
          "targetLanguage",
          getTargetLanguage()
        );


        console.log(
          "Uploading:",
          file.name
        );

        console.log(
          "Source:",
          getSourceLanguage()
        );

        console.log(
          "Target:",
          getTargetLanguage()
        );


        try {

          // =========================
          // 1%
          // =========================

          setProgress(
            1,
            "Uploading",
            "Uploading video..."
          );


          // =========================
          // SEND TO RENDER
          // =========================

          const response =
            await fetch(
              `${API_BASE}/api/start-job`,
              {
                method: "POST",
                body: formData
              }
            );


          // Try JSON.
          let data;

          try {

            data =
              await response.json();

          } catch {

            throw new Error(
              `Server returned HTTP ${response.status}`
            );
          }


          if (
            !response.ok ||
            !data.ok
          ) {

            throw new Error(
              data.error ||
              data.message ||
              `Server error ${response.status}`
            );
          }


          // =========================
          // JOB CREATED
          // =========================

          currentJobId =
            data.jobId;


          if (!currentJobId) {

            throw new Error(
              "Server did not return a job ID."
            );
          }


          console.log(
            "Job ID:",
            currentJobId
          );


          setProgress(
            2,
            "Started",
            "SRT generation started..."
          );


          // =========================
          // START UI PROGRESS
          // =========================

          startProgressAnimation();


          // =========================
          // START SERVER POLLING
          // =========================

          startPolling();


        } catch (error) {

          generating = false;

          stopPolling();

          stopProgressAnimation();

          console.error(
            "Generate SRT error:",
            error
          );

          if (status) {
            status.textContent =
              "Error";
          }

          setProgress(
            currentProgress,
            "Error",
            error.message ||
              "Could not start SRT generation."
          );

          if (generateBtn) {

            generateBtn.disabled =
              false;

            generateBtn.removeAttribute(
              "disabled"
            );

            generateBtn.textContent =
              "Generate SRT";
          }
        }
      }
    );
  }


  // =========================
  // DOWNLOAD BUTTON
  // =========================

  if (downloadBtn) {

    downloadBtn.addEventListener(
      "click",
      downloadSrt
    );
  }


  // =========================
  // COPY BUTTON
  // =========================

  if (copyBtn) {

    copyBtn.addEventListener(
      "click",
      copySrt
    );
  }


  // =========================
  // DEBUG
  // =========================

  console.log(
    "AI Subtitle Maker app.js loaded."
  );

  console.log(
    "API:",
    API_BASE
  );

  console.log(
    "Generate button:",
    generateBtn
  );

  console.log(
    "File input:",
    fileInput
  );

});
