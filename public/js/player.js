import { Metrics } from "./metrics.js";
import { StripChart } from "./chart.js";
import { renderInfo } from "./info.js";

const PROVIDERS = {
  stream: { name: "Cloudflare Stream", official: "Cloudflare Stream player (iframe)" },
  mux: { name: "MUX", official: "MUX player (mux-player)" },
  s3: { name: "S3 + CloudFront", official: null },
  r2: { name: "R2 + self-managed HLS", official: null },
  youtube: { name: "YouTube embed (benchmark)", official: null, youtube: true },
};

const THROTTLE_OPTIONS = [
  [0, "No throttle"],
  [16e6, "Throttle: 16 Mbps (fast wifi)"],
  [8e6, "Throttle: 8 Mbps (4G)"],
  [3e6, "Throttle: 3 Mbps (slow 4G)"],
  [1.5e6, "Throttle: 1.5 Mbps (3G+)"],
  [6e5, "Throttle: 0.6 Mbps (3G)"],
];

const params = new URLSearchParams(location.search);
const providerId = params.get("p") || "stream";
const provider = PROVIDERS[providerId];

const els = {
  title: document.getElementById("title"),
  badge: document.getElementById("badge"),
  wrap: document.getElementById("playerWrap"),
  hud: document.getElementById("hud"),
  srcLine: document.getElementById("srcLine"),
  uaLine: document.getElementById("uaLine"),
  reloadBtn: document.getElementById("reloadBtn"),
  qualitySelect: document.getElementById("qualitySelect"),
  throttleSelect: document.getElementById("throttleSelect"),
  advancedBtn: document.getElementById("advancedBtn"),
  officialBtn: document.getElementById("officialBtn"),
  chartWrap: document.getElementById("chartWrap"),
  chart: document.getElementById("chart"),
  info: document.getElementById("info"),
};

let cfg = null;
let metrics = null;
let hls = null;
let ytPlayer = null;
let ytTimer = null;
let mode = "unified"; // "unified" (our hls.js/native player + HUD) or "official"
let throttleBps = 0;
const chart = new StripChart(els.chart);

init();

async function init() {
  if (!provider) {
    els.title.textContent = "Unknown provider";
    return;
  }
  document.title = `${provider.name} — LMS Player PoC`;
  els.title.textContent = provider.name;
  els.uaLine.textContent = `Device: ${navigator.userAgent}`;
  renderInfo(providerId, els.info);

  const all = await fetch("/api/config").then((r) => r.json());
  cfg = all[providerId];

  els.badge.textContent = cfg.configured ? "configured" : "demo video";
  els.badge.classList.add(cfg.configured ? "ok" : "demo");

  els.throttleSelect.innerHTML = THROTTLE_OPTIONS
    .map(([bps, label]) => `<option value="${bps}">${label}</option>`)
    .join("");
  els.throttleSelect.onchange = () => { throttleBps = Number(els.throttleSelect.value); };

  if (provider.official) {
    els.officialBtn.hidden = false;
    els.officialBtn.addEventListener("click", toggleMode);
  }
  els.reloadBtn.addEventListener("click", () => loadUnified());

  if (provider.youtube) loadYouTube();
  else loadUnified();
}

function teardown() {
  if (hls) { hls.destroy(); hls = null; }
  if (metrics) { metrics.destroy(); metrics = null; }
  if (ytTimer) { clearInterval(ytTimer); ytTimer = null; }
  if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
  els.wrap.innerHTML = "";
  els.qualitySelect.hidden = true;
  els.throttleSelect.hidden = true;
  els.advancedBtn.hidden = true;
  els.chartWrap.hidden = true;
}

// Delays each segment's delivery so hls.js sees (and adapts to) the simulated
// bandwidth: ABR downswitches, the buffer drains, rebuffers happen for real.
function makeThrottledLoader() {
  return class ThrottledLoader extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
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
      super.load(context, config, callbacks);
    }
  };
}

// ---- Unified player: same <video> + hls.js/native pipeline for every provider,
// so the HUD numbers are directly comparable across the options. ----
function loadUnified() {
  teardown();
  mode = "unified";
  els.officialBtn.textContent = "Switch to official player";
  els.hud.style.display = "";
  els.reloadBtn.disabled = false;

  const src = cfg.hlsUrl || cfg.url;
  els.srcLine.textContent = `Source: ${src}`;

  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  // Nothing is fetched until the user presses play, so the HUD's startup time
  // is a real join-time measurement instead of a preload artifact.
  video.preload = "none";
  if (cfg.poster) video.poster = cfg.poster;
  els.wrap.appendChild(video);

  // Big play affordance over the poster; removed on first play (metrics still
  // measure from the play event, so clicking this is measured identically).
  const overlay = document.createElement("button");
  overlay.className = "big-play";
  overlay.setAttribute("aria-label", "Play");
  overlay.innerHTML =
    `<span class="big-play-circle"><svg viewBox="0 0 24 24" width="34" height="34"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></span>`;
  overlay.addEventListener("click", () => video.play());
  els.wrap.appendChild(overlay);
  video.addEventListener("play", () => overlay.remove(), { once: true });

  els.chartWrap.hidden = false;
  metrics = new Metrics(video, els.hud, chart);
  els.advancedBtn.hidden = false;
  els.advancedBtn.classList.remove("active");
  els.advancedBtn.onclick = () => {
    metrics.advanced = !metrics.advanced;
    metrics.render();
    els.advancedBtn.classList.toggle("active", metrics.advanced);
  };

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
    hls.on(Hls.Events.MANIFEST_PARSED, () => buildQualitySelect());
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        els.srcLine.textContent = `Source: ${src} — FATAL: ${data.type}/${data.details}`;
      }
    });
    els.throttleSelect.hidden = false;
    els.throttleSelect.value = String(throttleBps);
  } else {
    // iOS Safari (native HLS) or plain MP4 progressive playback.
    // In-app throttling needs hls.js's loader, so it's unavailable here —
    // use browser DevTools network throttling instead.
    video.src = src;
    if (!isHlsSrc) {
      fetch(src, { method: "HEAD" })
        .then((r) => {
          const len = Number(r.headers.get("content-length"));
          if (len && metrics) metrics.setProgressiveInfo(len);
        })
        .catch(() => {}); // no CORS -> no size info; HUD just omits the row
    }
  }
}

function buildQualitySelect() {
  const sel = els.qualitySelect;
  sel.hidden = false;
  sel.innerHTML =
    `<option value="-1">Auto quality</option>` +
    hls.levels
      .map((l, i) => `<option value="${i}">${l.height}p @ ${Math.round(l.bitrate / 1000)} kbps</option>`)
      .join("");
  sel.onchange = () => { hls.currentLevel = Number(sel.value); };
}

// ---- Official managed players (Stream iframe / mux-player), for comparing
// the vendor player UX. The HUD can't reach inside these, so it's hidden. ----
function toggleMode() {
  if (mode === "unified") loadOfficial();
  else loadUnified();
}

async function loadOfficial() {
  teardown();
  mode = "official";
  els.officialBtn.textContent = "Switch to unified player (with metrics)";
  els.hud.style.display = "none";
  els.reloadBtn.disabled = true;

  if (providerId === "stream") {
    const iframe = document.createElement("iframe");
    iframe.src = cfg.iframeUrl;
    iframe.allow = "accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;";
    iframe.allowFullscreen = true;
    els.wrap.appendChild(iframe);
    els.srcLine.textContent = `Source: ${cfg.iframeUrl}`;
  } else if (providerId === "mux") {
    if (!customElements.get("mux-player")) {
      await import("https://cdn.jsdelivr.net/npm/@mux/mux-player@2/dist/mux-player.mjs");
    }
    const mp = document.createElement("mux-player");
    mp.setAttribute("playback-id", cfg.playbackId);
    mp.setAttribute("stream-type", "on-demand");
    els.wrap.appendChild(mp);
    els.srcLine.textContent = `Source: mux-player playback-id=${cfg.playbackId}`;
  }
}

// ---- YouTube benchmark: iframe API player + the coarse stats it exposes.
// Detailed network metrics are locked inside the iframe — that's part of
// the comparison (you can't observe or control playback in any depth). ----
let ytApiPromise = null;
function loadYtApi() {
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve) => {
      if (window.YT?.Player) return resolve();
      window.onYouTubeIframeAPIReady = () => resolve();
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    });
  }
  return ytApiPromise;
}

const YT_STATES = { "-1": "unstarted", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued" };

async function loadYouTube() {
  teardown();
  els.reloadBtn.disabled = true;
  els.srcLine.textContent = `Source: https://www.youtube.com/watch?v=${cfg.videoId} (iframe embed)`;

  const mount = document.createElement("div");
  els.wrap.appendChild(mount);
  await loadYtApi();

  let bufferingAt = null;
  let startupMs = null;
  let freezes = 0;
  let lastState = null;
  ytPlayer = new YT.Player(mount, {
    videoId: cfg.videoId,
    width: "100%",
    height: "100%",
    playerVars: { rel: 0 },
    events: {
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.BUFFERING && startupMs === null && bufferingAt === null) {
          bufferingAt = performance.now();
        }
        if (e.data === YT.PlayerState.PLAYING && startupMs === null && bufferingAt !== null) {
          startupMs = performance.now() - bufferingAt;
        }
        // Mid-playback drops back into buffering read as freezes (seeks
        // included — the iframe can't tell us the difference).
        if (e.data === YT.PlayerState.BUFFERING && lastState === YT.PlayerState.PLAYING) {
          freezes += 1;
        }
        lastState = e.data;
      },
    },
  });

  ytTimer = setInterval(() => {
    if (!ytPlayer?.getPlayerState) return;
    let score = null;
    if (startupMs !== null) {
      score = Math.max(0, Math.round(100 - Math.min(25, (startupMs / 1000) * 8) - freezes * 8));
    }
    const rows = [
      {
        label: "Overall score",
        value: score !== null ? `${score} · ${score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 60 ? "Fair" : "Poor"}` : "press play",
        cls: score !== null ? (score >= 75 ? "score-good" : score >= 55 ? "score-mid" : "score-low") : "",
        score: true,
      },
      { label: "Start delay", value: startupMs !== null ? `${Math.round(startupMs)} ms` : "—" },
      { label: "Freezes", value: String(freezes) },
      { label: "State", value: YT_STATES[ytPlayer.getPlayerState()] ?? "—" },
      { label: "Time", value: `${(ytPlayer.getCurrentTime?.() || 0).toFixed(0)} / ${(ytPlayer.getDuration?.() || 0).toFixed(0)} s` },
      { label: "Buffered", value: `${Math.round((ytPlayer.getVideoLoadedFraction?.() || 0) * 100)} %` },
      { label: "Data / bandwidth", value: "hidden by iframe" },
    ];
    els.hud.innerHTML = rows
      .map((r) =>
        `<div class="stat${r.score ? " score" : ""}"><div class="label">${r.label}</div>` +
        `<div class="value${r.cls ? ` ${r.cls}` : ""}">${r.value}</div></div>`)
      .join("");
  }, 500);
}
