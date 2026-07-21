import { Metrics } from "./metrics.js";
import { StripChart } from "./chart.js";

const PROVIDERS = [
  { id: "mux", name: "MUX" },
  { id: "s3", name: "S3 + CloudFront" },
  { id: "r2", name: "R2 (own encoding)" },
];

const THROTTLE_OPTIONS = [
  [0, "No throttle"],
  [16e6, "Throttle: 16 Mbps (fast wifi)"],
  [8e6, "Throttle: 8 Mbps (4G)"],
  [3e6, "Throttle: 3 Mbps (slow 4G)"],
  [1.5e6, "Throttle: 1.5 Mbps (3G+)"],
  [6e5, "Throttle: 0.6 Mbps (3G)"],
];
let throttleBps = 3e6; // same slow-4G default as the single-player pages

const grid = document.getElementById("grid");
const throttleSelect = document.getElementById("throttleSelect");
let config = null;
const cells = []; // { video, metrics, hls }

init();

async function init() {
  throttleSelect.innerHTML = THROTTLE_OPTIONS
    .map(([bps, label]) => `<option value="${bps}">${label}</option>`)
    .join("");
  throttleSelect.value = String(throttleBps);
  throttleSelect.onchange = () => { throttleBps = Number(throttleSelect.value); };

  document.getElementById("playAllBtn").onclick = () => {
    for (const c of cells) {
      c.video.muted = true;
      c.video.play();
    }
  };
  document.getElementById("reloadAllBtn").onclick = buildAll;

  config = await fetch("/api/config").then((r) => r.json());
  buildAll();
}

// Same segment-delivery pacing as the single-player page, shared across cells.
function makeThrottledLoader() {
  return class ThrottledLoader extends Hls.DefaultConfig.loader {
    load(context, cfg, callbacks) {
      const orig = callbacks.onSuccess;
      callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
        if (!throttleBps) return orig(response, stats, ctx, networkDetails);
        const bytes = stats.loaded || response.data?.byteLength || 0;
        const idealMs = (bytes * 8 * 1000) / throttleBps;
        const actualMs = Math.max(1, stats.loading.end - stats.loading.start);
        const delay = Math.max(0, idealMs - actualMs);
        setTimeout(() => {
          stats.loading.end += delay;
          orig(response, stats, ctx, networkDetails);
        }, delay);
      };
      super.load(context, cfg, callbacks);
    }
  };
}

function buildAll() {
  for (const c of cells) {
    c.metrics.destroy();
    if (c.hls) c.hls.destroy();
  }
  cells.length = 0;
  grid.innerHTML = "";
  for (const p of PROVIDERS) buildCell(p, config[p.id]);
}

function buildCell(provider, cfg) {
  const cell = document.createElement("div");
  cell.className = "cmp-cell";
  cell.innerHTML =
    `<div class="cmp-head"><h3>${provider.name}</h3>` +
    `<span class="badge ${cfg.configured ? "ok" : "demo"}">${cfg.configured ? "configured" : "demo"}</span></div>` +
    `<div class="cmp-player"></div>` +
    `<div class="hud"></div>` +
    `<canvas class="cmp-chart" height="60"></canvas>`;
  grid.appendChild(cell);

  const mount = cell.querySelector(".cmp-player");
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "none";
  const src = cfg.hlsUrl || cfg.url;
  if (cfg.poster) video.poster = cfg.poster;
  mount.appendChild(video);

  const overlay = document.createElement("button");
  overlay.className = "big-play";
  overlay.setAttribute("aria-label", `Play ${provider.name}`);
  overlay.innerHTML =
    `<span class="big-play-circle"><svg viewBox="0 0 24 24" width="26" height="26"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></span>`;
  overlay.addEventListener("click", () => video.play());
  mount.appendChild(overlay);
  video.addEventListener("play", () => overlay.remove(), { once: true });

  const chart = new StripChart(cell.querySelector(".cmp-chart"));
  const metrics = new Metrics(video, cell.querySelector(".hud"), chart);

  let hls = null;
  const isHlsSrc = /\.m3u8($|\?)/.test(src);
  if (isHlsSrc && window.Hls && Hls.isSupported()) {
    hls = new Hls({
      capLevelToPlayerSize: true,
      autoStartLoad: false,
      loader: makeThrottledLoader(),
    });
    metrics.attachHls(hls);
    hls.loadSource(src);
    hls.attachMedia(video);
    video.addEventListener("play", () => hls.startLoad(), { once: true });
  } else {
    video.src = src;
  }

  cells.push({ video, metrics, hls });
}
