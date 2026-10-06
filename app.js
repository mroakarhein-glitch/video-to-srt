const form = document.getElementById('form');

const fileInput = document.getElementById('media');
const fileTitle = document.getElementById('fileTitle');
const fileHint = document.getElementById('fileHint');

const generateBtn = document.getElementById('generateBtn');

const statusBox = document.getElementById('status');

const progressBox = document.getElementById('progressBox');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressTitle = document.getElementById('progressTitle');
const progressMessage = document.getElementById('progressMessage');

const resultBox = document.getElementById('result');
const output = document.getElementById('output');

const downloadBtn = document.getElementById('downloadBtn');
const copyBtn = document.getElementById('copyBtn');

const dropZone = document.getElementById('dropZone');


function showStatus(message, error = false) {
  statusBox.textContent = message;

  statusBox.classList.remove('hidden', 'error');

  if (error) {
    statusBox.classList.add('error');
  }
}


function formatSize(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


function showFile(file) {
  if (!file) return;

  fileTitle.textContent = file.name;

  fileHint.textContent =
    `${formatSize(file.size)} • Ready to generate`;
}


function updateProgress(percent, title, message) {
  const safePercent = Math.max(
    0,
    Math.min(100, Number(percent) || 0)
  );

  progressBar.style.width = `${safePercent}%`;

  progressPercent.textContent = `${safePercent}%`;

  progressTitle.textContent = title || 'Processing...';

  progressMessage.textContent =
    message || 'Please wait...';
}


function showProgress() {
  progressBox.classList.remove('hidden');

  updateProgress(
    0,
    'Preparing...',
    'Starting subtitle generation...'
  );
}


function hideProgress() {
  progressBox.classList.add('hidden');
}


fileInput.addEventListener('change', () => {
  showFile(fileInput.files[0]);
});


['dragenter', 'dragover'].forEach(eventName => {

  dropZone.addEventListener(eventName, event => {

    event.preventDefault();

    dropZone.classList.add('drag');

  });

});


['dragleave', 'drop'].forEach(eventName => {

  dropZone.addEventListener(eventName, event => {

    event.preventDefault();

    dropZone.classList.remove('drag');

  });

});


dropZone.addEventListener('drop', event => {

  const file = event.dataTransfer.files[0];

  if (!file) return;

  const dataTransfer = new DataTransfer();

  dataTransfer.items.add(file);

  fileInput.files = dataTransfer.files;

  showFile(file);

});


form.addEventListener('submit', async event => {

  event.preventDefault();

  const file = fileInput.files[0];

  if (!file) {

    showStatus(
      'Please choose a video or audio file.',
      true
    );

    return;
  }


  generateBtn.disabled = true;

  generateBtn.textContent = 'Generating…';

  resultBox.classList.add('hidden');

  showProgress();

  showStatus(
    'Uploading media and generating subtitles...'
  );


  try {

    const data = new FormData(form);


    /*
     * IMPORTANT
     *
     * The backend must provide progress events.
     *
     * Until the backend is updated, this request
     * will still wait for the final response.
     */

    const res = await fetch(
      '/api/generate-srt',
      {
        method: 'POST',
        body: data
      }
    );


    const json = await res.json();


    if (!res.ok) {

      throw new Error(
        json.error || 'Generation failed'
      );

    }


    updateProgress(
      100,
      'Complete',
      'SRT generation completed successfully.'
    );


    output.value = json.srt;

    resultBox.classList.remove('hidden');


    showStatus(
      'SRT generated successfully. You can edit it before downloading.'
    );


    resultBox.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });


  } catch (error) {

    updateProgress(
      0,
      'Generation failed',
      error.message || 'Something went wrong.'
    );


    showStatus(
      error.message || 'Something went wrong.',
      true
    );


  } finally {

    generateBtn.disabled = false;

    generateBtn.textContent = 'Generate SRT';

  }

});


downloadBtn.addEventListener('click', () => {

  const blob = new Blob(
    ['\ufeff' + output.value],
    {
      type: 'application/x-subrip;charset=utf-8'
    }
  );


  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');

  link.href = url;

  link.download = 'subtitle.srt';

  link.click();


  setTimeout(() => {

    URL.revokeObjectURL(url);

  }, 1000);

});


copyBtn.addEventListener('click', async () => {

  try {

    await navigator.clipboard.writeText(
      output.value
    );

    copyBtn.textContent = 'Copied!';

    setTimeout(() => {

      copyBtn.textContent = 'Copy SRT Text';

    }, 1200);

  } catch (error) {

    showStatus(
      'Unable to copy SRT text.',
      true
    );

  }

});
