const form = document.getElementById('form');
const fileInput = document.getElementById('media');
const fileTitle = document.getElementById('fileTitle');
const fileHint = document.getElementById('fileHint');
const generateBtn = document.getElementById('generateBtn');
const statusBox = document.getElementById('status');
const resultBox = document.getElementById('result');
const output = document.getElementById('output');
const downloadBtn = document.getElementById('downloadBtn');
const copyBtn = document.getElementById('copyBtn');
const dropZone = document.getElementById('dropZone');

function showStatus(message, error=false){
  statusBox.textContent = message;
  statusBox.classList.remove('hidden','error');
  if(error) statusBox.classList.add('error');
}
function formatSize(bytes){
  if(bytes < 1024*1024) return `${(bytes/1024).toFixed(0)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}
function showFile(file){
  if(!file) return;
  fileTitle.textContent = file.name;
  fileHint.textContent = `${formatSize(file.size)} • Ready to generate`;
}
fileInput.addEventListener('change',()=>showFile(fileInput.files[0]));
['dragenter','dragover'].forEach(evt=>dropZone.addEventListener(evt,e=>{e.preventDefault();dropZone.classList.add('drag')}));
['dragleave','drop'].forEach(evt=>dropZone.addEventListener(evt,e=>{e.preventDefault();dropZone.classList.remove('drag')}));
dropZone.addEventListener('drop',e=>{
  const file=e.dataTransfer.files[0];
  if(!file) return;
  const dt=new DataTransfer(); dt.items.add(file); fileInput.files=dt.files; showFile(file);
});

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(!fileInput.files[0]) return showStatus('Please choose a video or audio file.', true);
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating…';
  resultBox.classList.add('hidden');
  showStatus('Uploading media and generating subtitles…');
  try{
    const data = new FormData(form);
    const res = await fetch('/api/generate-srt',{method:'POST',body:data});
    const json = await res.json();
    if(!res.ok) throw new Error(json.error || 'Generation failed');
    output.value = json.srt;
    resultBox.classList.remove('hidden');
    showStatus('SRT generated successfully. You can edit it before downloading.');
    resultBox.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(err){
    showStatus(err.message || 'Something went wrong.', true);
  }finally{
    generateBtn.disabled=false;
    generateBtn.textContent='Generate SRT';
  }
});

downloadBtn.addEventListener('click',()=>{
  const blob = new Blob(['\ufeff'+output.value],{type:'application/x-subrip;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='subtitle.srt'; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
copyBtn.addEventListener('click',async()=>{
  await navigator.clipboard.writeText(output.value);
  copyBtn.textContent='Copied!'; setTimeout(()=>copyBtn.textContent='Copy SRT Text',1200);
});
