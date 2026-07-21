const els = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  dropText: document.getElementById("dropText"),
  fileMeta: document.getElementById("fileMeta"),
  checks: document.getElementById("providerChecks"),
  ffmpegNote: document.getElementById("ffmpegNote"),
  startBtn: document.getElementById("startBtn"),
  uploadProgress: document.getElementById("uploadProgress"),
  jobSection: document.getElementById("jobSection"),
  steps: document.getElementById("steps"),
  logs: document.getElementById("logs"),
  doneLinks: document.getElementById("doneLinks"),
};

let file = null;
let jobTimer = null;

init();

async function init() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  for (const label of els.checks.querySelectorAll("label")) {
    const p = label.dataset.p;
    const ready = cfg.upload[p];
    const box = label.querySelector("input");
    const badge = label.querySelector("[data-badge]");
    box.disabled = !ready;
    box.checked = ready;
    badge.textContent = ready ? "credentials ok" : "no credentials";
    badge.classList.add(ready ? "ok" : "demo");
  }
  if (!cfg.upload.ffmpeg) els.ffmpegNote.hidden = false;

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => setFile(els.fileInput.files[0]));
  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragging");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragging"));
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragging");
    setFile(e.dataTransfer.files[0]);
  });
  els.startBtn.addEventListener("click", start);
}

function setFile(f) {
  if (!f) return;
  file = f;
  els.dropText.innerHTML = `<b>${f.name}</b>`;
  els.fileMeta.textContent = `${(f.size / 1e6).toFixed(1)} MB — ${f.type || "video"}`;
  els.startBtn.disabled = false;
}

function selectedProviders() {
  return [...els.checks.querySelectorAll("input:checked")].map((b) => b.value);
}

function start() {
  if (!file) return;
  els.startBtn.disabled = true;

  // XHR instead of fetch for upload progress events.
  const form = new FormData();
  form.append("video", file);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      els.uploadProgress.textContent = `Uploading to server: ${((e.loaded / e.total) * 100).toFixed(0)}%`;
    }
  };
  xhr.onerror = () => fail("Upload failed (network error).");
  xhr.onload = async () => {
    if (xhr.status !== 200) return fail(`Upload failed: ${xhr.responseText}`);
    els.uploadProgress.textContent = "Upload complete. Starting pipeline…";
    const { filename } = JSON.parse(xhr.responseText);
    const res = await fetch("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, providers: selectedProviders() }),
    });
    const json = await res.json();
    if (!res.ok) return fail(json.error || "Failed to start pipeline.");
    watchJob(json.jobId);
  };
  xhr.send(form);
}

function fail(msg) {
  els.uploadProgress.textContent = msg;
  els.startBtn.disabled = false;
}

const STATUS_ICONS = { pending: "○", running: "◐", done: "●", error: "✕", skipped: "–" };

function watchJob(jobId) {
  els.jobSection.hidden = false;
  jobTimer = setInterval(async () => {
    const job = await fetch(`/api/job/${jobId}`).then((r) => r.json());
    els.steps.innerHTML = job.steps
      .map(
        (s) =>
          `<li class="step ${s.status}"><span class="icon">${STATUS_ICONS[s.status] || "○"}</span>` +
          `<span class="name">${s.name}</span><span class="detail">${s.detail || ""}</span></li>`
      )
      .join("");
    els.logs.textContent = job.logs.slice(-100).join("\n");
    if (job.done) {
      clearInterval(jobTimer);
      els.uploadProgress.textContent = job.error
        ? `Pipeline failed: ${job.error}`
        : "Pipeline finished.";
      els.doneLinks.hidden = false;
      els.startBtn.disabled = false;
    }
  }, 1000);
}
