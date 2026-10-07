document.addEventListener("DOMContentLoaded", () => {

  // ==========================================
  // RENDER BACKEND
  // ==========================================

  const API_BASE =
    "https://video-to-srt-54xt.onrender.com";


  // ==========================================
  // ELEMENTS
  // ==========================================

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

  const statusBox =
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

  const resultBox =
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


  // ==========================================
  // STATE
  // ==========================================

  let currentJobId = null;

  let pollingTimer = null;

  let fakeProgressTimer = null;

  let progress = 0;

  let generating = false;


  // ==========================================
  // BUTTON INITIAL STATE
  // ==========================================

  if (generateBtn) {
    generateBtn.disabled = false;
    generateBtn.removeAttribute("disabled");
  }


  // ==========================================
  // PROGRESS
  // ==========================================

  function setProgress(
    value,
    title,
    message
  ) {

    progress = Math.max(
      0,
      Math.min(
        100,
        Math.round(Number(value) || 0)
      )
    );


    if (progressBar) {
      progressBar.style.width =
        `${progress}%`;
    }


    if (progressPercent) {
      progressPercent.textContent =
        `${progress}%`;
    }


    if (progressTitle) {
      progressTitle.textContent =
        title || "";
    }


    if (progressMessage) {
      progressMessage.textContent =
        message || "";
    }


    if (progressBox) {
      progressBox.classList.remove(
        "hidden"
      );

      progressBox.style.display =
        "block";
    }
  }


  // ==========================================
  // STATUS
  // ==========================================

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

    statusBox.classList.remove(
      "hidden"
    );
  }


  // ==========================================
  // FILE
  // ==========================================

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

      fileInput.value = "";

      return;
    }


    if (fileTitle) {
      fileTitle.textContent =
        file.name;
    }


    if (fileHint) {

      const size =
        (
          file.size /
          1024 /
          1024
        ).toFixed(1);

      fileHint.textContent =
        `${size} MB • Ready to generate`;
    }


    // Enable Generate button.
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.removeAttribute(
        "disabled"
      );
    }
  }


  // ==========================================
  // FILE SELECT
  // ==========================================

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


  // ==========================================
  // DRAG & DROP
  // ==========================================

  if (dropZone) {

    dropZone.addEventListener(
      "dragover",
      (event) => {

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
      (event) => {

        event.preventDefault();

        dropZone.classList.remove(
          "dragging"
        );

        const file =
          event.dataTransfer?.files?.[0];

        if (!file) {
          return;
        }


        try {

          const dataTransfer =
            new DataTransfer();

          dataTransfer.items.add(
            file
          );

          fileInput.files =
            dataTransfer.files;

        } catch (error) {

          console.warn(
            error
          );
        }


        showFile(file);
      }
    );
  }


  // ==========================================
  // LANGUAGE
  // ==========================================

  function getSourceLanguage() {

    const value =
      sourceLanguage?.value ||
      "Auto detect";


    if (
      value.toLowerCase() ===
      "auto detect"
    ) {
      return "auto";
    }


    return value;
  }


  function getTargetLanguage() {

    return (
      targetLanguage?.value ||
      "Myanmar (Burmese)"
    );
  }


  // ==========================================
  // STOP POLLING
  // ==========================================

  function stopPolling() {

    if (pollingTimer) {

      clearInterval(
        pollingTimer
      );

      pollingTimer = null;
    }
  }


  function stopFakeProgress() {

    if (fakeProgressTimer) {

      clearInterval(
        fakeProgressTimer
      );

      fakeProgressTimer = null;
    }
  }


  // ==========================================
  // 0 → 1 → 2 → 3 → ...
  // ==========================================

  function startProgressAnimation() {

    stopFakeProgress();


    fakeProgressTimer =
      setInterval(() => {

        if (!generating) {
          return;
        }


        /*
          UI progress only.

          Backend progress will override
          this when it reports a higher value.

          Never automatically reach 100%.
        */

        if (progress < 95) {

          setProgress(
            progress + 1,
            "Generating SRT",
            "AI is processing your video..."
          );
        }

      }, 1000);
  }


  // ==========================================
  // JOB STATUS
  // ==========================================

  async function checkJob(
    jobId
  ) {

    const response =
      await fetch(
        `${API_BASE}/api/job/${encodeURIComponent(jobId)}`,
        {
          method: "GET",
          cache: "no-store"
        }
      );


    const data =
      await response.json();


    console.log(
      "JOB:",
      data
    );


    if (!response.ok || !data.ok) {

      throw new Error(
        data.error ||
        data.message ||
        `Job request failed (${response.status})`
      );
    }


    // ========================================
    // SERVER PROGRESS
    // ========================================

    const serverProgress =
      Number(
        data.progress || 0
      );


    if (
      serverProgress >
      progress
    ) {

      setProgress(
        serverProgress,
        data.title,
        data.message
      );
    }


    // ========================================
    // COMPLETED
    // ========================================

    if (
      data.status ===
      "completed"
    ) {

      generating = false;

      stopPolling();

      stopFakeProgress();


      setProgress(
        100,
        "Complete",
        "SRT generation completed successfully."
      );


      if (output) {

        output.value =
          data.srt || "";
      }


      if (resultBox) {

        resultBox.classList.remove(
          "hidden"
        );

        resultBox.style.display =
          "block";

        resultBox.hidden =
          false;
      }


      showStatus(
        "SRT Ready",
        "success"
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


      return true;
    }


    // ========================================
    // FAILED
    // ========================================

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
  }


  // ==========================================
  // POLLING
  // ==========================================

  function startPolling(
    jobId
  ) {

    stopPolling();


    checkJob(jobId)
      .catch(handleError);


    pollingTimer =
      setInterval(
        async () => {

          try {

            const finished =
              await checkJob(
                jobId
              );


            if (finished) {
              stopPolling();
            }

          } catch (error) {

            handleError(error);
          }

        },
        1500
      );
  }


  // ==========================================
  // ERROR
  // ==========================================

  function handleError(
    error
  ) {

    console.error(
      "SRT ERROR:",
      error
    );


    generating = false;

    stopPolling();

    stopFakeProgress();


    showStatus(
      error.message ||
      "Something went wrong.",
      "error"
    );


    setProgress(
      progress,
      "Error",
      error.message ||
      "SRT generation failed."
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


  // ==========================================
  // GENERATE
  // ==========================================

  if (form) {

    form.addEventListener(
      "submit",
      async (event) => {

        event.preventDefault();


        console.log(
          "================================"
        );

        console.log(
          "GENERATE SRT CLICKED"
        );

        console.log(
          "================================"
        );


        if (generating) {
          return;
        }


        const file =
          fileInput?.files?.[0];


        if (!file) {

          alert(
            "Please select a video first."
          );

          return;
        }


        const maxSize =
          100 * 1024 * 1024;


        if (file.size > maxSize) {

          alert(
            "File size must be 100MB or less."
          );

          return;
        }


        generating = true;

        currentJobId = null;

        progress = 0;


        stopPolling();

        stopFakeProgress();


        if (resultBox) {

          resultBox.hidden =
            true;

          resultBox.classList.add(
            "hidden"
          );

          resultBox.style.display =
            "none";
        }


        if (output) {
          output.value = "";
        }


        if (generateBtn) {

          generateBtn.disabled =
            true;

          generateBtn.textContent =
            "Generating...";
        }


        setProgress(
          0,
          "Starting",
          "Preparing your video..."
        );


        showStatus(
          "Starting AI subtitle generation...",
          "info"
        );


        // ======================================
        // FORM DATA
        // ======================================

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
          "File:",
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

          // ====================================
          // SEND TO RENDER
          // ====================================

          setProgress(
            1,
            "Uploading",
            "Uploading video to server..."
          );


          const response =
            await fetch(
              `${API_BASE}/api/start-job`,
              {
                method: "POST",
                body: formData
              }
            );


          console.log(
            "START JOB HTTP:",
            response.status
          );


          let data;


          try {

            data =
              await response.json();

          } catch {

            throw new Error(
              `Render server returned HTTP ${response.status}`
            );
          }


          console.log(
            "START JOB DATA:",
            data
          );


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


          if (!data.jobId) {

            throw new Error(
              "Render server did not return a job ID."
            );
          }


          currentJobId =
            data.jobId;


          // ====================================
          // JOB STARTED
          // ====================================

          setProgress(
            2,
            "Started",
            "AI subtitle generation started..."
          );


          startProgressAnimation();


          startPolling(
            currentJobId
          );

        } catch (error) {

          handleError(error);
        }

      }
    );
  }


  // ==========================================
  // DOWNLOAD
  // ==========================================

  if (downloadBtn) {

    downloadBtn.addEventListener(
      "click",
      () => {

        const text =
          output?.value || "";


        if (!text.trim()) {

          alert(
            "SRT is not ready."
          );

          return;
        }


        const blob =
          new Blob(
            [text],
            {
              type:
                "application/x-subrip;charset=utf-8"
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


  // ==========================================
  // COPY
  // ==========================================

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


          const oldText =
            copyBtn.textContent;


          copyBtn.textContent =
            "Copied";


          setTimeout(() => {

            copyBtn.textContent =
              oldText ||
              "Copy SRT Text";

          }, 1500);


        } catch {

          output.focus();

          output.select();

          document.execCommand(
            "copy"
          );
        }
      }
    );
  }


  // ==========================================
  // INITIAL
  // ==========================================

  if (progressBox) {

    progressBox.classList.add(
      "hidden"
    );

    progressBox.style.display =
      "none";
  }


  console.log(
    "AI Subtitle Maker app.js loaded."
  );

  console.log(
    "Backend:",
    API_BASE
  );

});
