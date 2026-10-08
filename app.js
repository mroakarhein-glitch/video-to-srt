const form = document.getElementById("form");
const fileInput = document.getElementById("media");
const generateBtn = document.getElementById("generateBtn");

const status = document.getElementById("status");
const result = document.getElementById("result");
const output = document.getElementById("output");

const downloadBtn =
  document.getElementById("downloadBtn");

const copyBtn =
  document.getElementById("copyBtn");

const fileTitle =
  document.getElementById("fileTitle");

const fileHint =
  document.getElementById("fileHint");


/* =========================
   FILE SELECT
========================= */

fileInput?.addEventListener(
  "change",
  () => {

    const file =
      fileInput.files?.[0];

    if (!file) return;

    if (
      file.size >
      100 * 1024 * 1024
    ) {
      alert(
        "Maximum file size is 100MB."
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
);


/* =========================
   GENERATE
========================= */

form?.addEventListener(
  "submit",
  async event => {

    event.preventDefault();

    const file =
      fileInput?.files?.[0];

    if (!file) {
      alert(
        "Please upload a video first."
      );
      return;
    }

    generateBtn.disabled = true;

    if (status) {
      status.style.display = "block";
      status.textContent =
        "Generating SRT... Please wait.";
    }

    if (result) {
      result.style.display = "none";
    }

    if (output) {
      output.value = "";
    }

    try {

      const data =
        new FormData(form);

      const response =
        await fetch(
          "/api/generate-srt",
          {
            method: "POST",
            body: data
          }
        );

      const json =
        await response.json();

      if (!response.ok || !json.ok) {
        throw new Error(
          json.error ||
          "SRT generation failed."
        );
      }

      if (!json.srt) {
        throw new Error(
          "No SRT file was returned."
        );
      }

      if (output) {
        output.value =
          json.srt;
      }

      if (result) {
        result.style.display =
          "block";
      }

      if (status) {
        status.textContent =
          "SRT ready.";
      }

      /*
        Download button
      */

      downloadBtn.onclick = () => {

        const blob =
          new Blob(
            [json.srt],
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
          file.name.replace(
            /\.[^/.]+$/,
            ""
          ) + ".srt";

        document.body.appendChild(a);

        a.click();

        a.remove();

        URL.revokeObjectURL(url);
      };


      /*
        Copy button
      */

      copyBtn.onclick =
        async () => {

          await navigator.clipboard.writeText(
            json.srt
          );

          copyBtn.textContent =
            "Copied!";

          setTimeout(() => {
            copyBtn.textContent =
              "Copy";
          }, 1500);
        };


    } catch (error) {

      console.error(error);

      if (status) {
        status.textContent =
          "Error: " +
          error.message;
      }

    } finally {

      generateBtn.disabled =
        false;
    }
  }
);
