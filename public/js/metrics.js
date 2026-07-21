// Playback metrics HUD attached to a <video> element.
// Measures: startup ("join") time, rebuffer count/duration, resolution,
// dropped frames, buffer ahead — plus network transfer detail:
// bytes downloaded, segments loaded, last/average segment download speed,
// current bitrate, quality switches, and hls.js's bandwidth estimate.
// Optionally feeds a StripChart with buffer/throughput samples.
export class Metrics {
  constructor(video, hudEl, chart = null) {
    this.video = video;
    this.hud = hudEl;
    this.chart = chart;
    this.hls = null; // set via attachHls()
    this.advanced = false; // show technical stats too
    this.reset();

    video.addEventListener("play", () => this._onPlay());
    // A pause before the first frame aborts the measurement; the next play
    // re-arms the clock instead of accumulating idle time.
    video.addEventListener("pause", () => {
      if (!this.started) this.playRequestedAt = null;
    });
    video.addEventListener("playing", () => this._onPlaying());
    video.addEventListener("waiting", () => this._onWaiting());
    video.addEventListener("seeking", () => { this.seeking = true; });
    video.addEventListener("seeked", () => { this.seeking = false; });
    video.addEventListener("error", () => this.render());

    this.timer = setInterval(() => this._tick(), 500);
  }

  reset() {
    // Startup ("join time") is measured from the first play() request to the
    // first rendered frame — not from page load, which would penalize nothing
    // and reward preloading.
    this.playRequestedAt = null;
    this.startupMs = null;
    this.started = false;
    this.seeking = false;
    this.stallCount = 0;
    this.stallMs = 0;
    this.stallStartedAt = null;
    this.levelSwitches = 0;
    // Transfer counters (hls.js path).
    this.bytesDownloaded = 0;
    this.segmentsLoaded = 0;
    this.downloadMs = 0;
    this.lastSegMbps = null;
    // Progressive (MP4) estimation, set via setProgressiveInfo().
    this.fileBytes = null;
    this.chart?.reset();
    this.render();
  }

  attachHls(hls) {
    this.hls = hls;
    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
      this.levelSwitches += 1;
    });
    hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
      const stats = data.frag?.stats || data.stats;
      if (!stats) return;
      const bytes = stats.loaded || 0;
      const ms = Math.max(1, stats.loading.end - stats.loading.start);
      this.bytesDownloaded += bytes;
      this.segmentsLoaded += 1;
      this.downloadMs += ms;
      this.lastSegMbps = (bytes * 8) / ms / 1000; // bits / ms = kbps -> /1000 = Mbps
    });
  }

  // For progressive MP4: total file size (from a HEAD request) lets us
  // estimate bytes downloaded from how much of the timeline is buffered.
  setProgressiveInfo(fileBytes) {
    this.fileBytes = fileBytes;
    this.render();
  }

  _onPlay() {
    if (!this.started) {
      this.playRequestedAt = performance.now();
    }
  }

  _onPlaying() {
    if (!this.started) {
      this.started = true;
      if (this.playRequestedAt !== null) {
        this.startupMs = performance.now() - this.playRequestedAt;
      }
    }
    if (this.stallStartedAt !== null) {
      this.stallMs += performance.now() - this.stallStartedAt;
      this.stallStartedAt = null;
    }
    this.render();
  }

  _onWaiting() {
    // Ignore stalls caused by the user seeking or before first frame.
    if (!this.started || this.seeking) return;
    if (this.stallStartedAt === null) {
      this.stallCount += 1;
      this.stallStartedAt = performance.now();
    }
    this.render();
  }

  _bufferAhead() {
    const { buffered, currentTime } = this.video;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
        return buffered.end(i) - currentTime;
      }
    }
    return 0;
  }

  _bufferedTotal() {
    const { buffered } = this.video;
    let total = 0;
    for (let i = 0; i < buffered.length; i++) total += buffered.end(i) - buffered.start(i);
    return total;
  }

  _downloadedBytes() {
    if (this.bytesDownloaded > 0) return { bytes: this.bytesDownloaded, exact: true };
    // Progressive fallback: fraction of timeline buffered x file size.
    if (this.fileBytes && this.video.duration) {
      return {
        bytes: (this._bufferedTotal() / this.video.duration) * this.fileBytes,
        exact: false,
      };
    }
    return null;
  }

  _dropped() {
    const q = this.video.getVideoPlaybackQuality?.();
    if (q) return `${q.droppedVideoFrames} / ${q.totalVideoFrames}`;
    return "n/a";
  }

  // What resolution this player could reasonably be showing: the ladder's
  // best rung, capped by the player's on-screen size.
  _targetHeight() {
    if (this.hls?.levels?.length) {
      const maxLevel = Math.max(...this.hls.levels.map((l) => l.height));
      const playerHeight = this.video.clientHeight || 0;
      return Math.min(maxLevel, Math.max(playerHeight, 360));
    }
    return null;
  }

  // Single 0-100 viewer-experience score. Weights follow standard QoE
  // findings: rebuffering hurts most, then startup delay, then picture
  // quality below what the player could show, then excessive switching.
  _score(stallMs) {
    if (!this.started) return null;
    let score = 100;
    score -= Math.min(25, ((this.startupMs ?? 0) / 1000) * 8);
    score -= Math.min(40, this.stallCount * 5 + (stallMs / 1000) * 4);
    const target = this._targetHeight();
    if (target && this.video.videoHeight) {
      score -= (1 - Math.min(1, this.video.videoHeight / target)) * 25;
    }
    score -= Math.min(10, Math.max(0, this.levelSwitches - 2) * 2);
    score = Math.max(0, Math.round(score));
    const label =
      score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 60 ? "Fair" : score >= 40 ? "Poor" : "Bad";
    return { value: score, label };
  }

  _tick() {
    this.render();
    if (this.chart && (this.started || this._bufferedTotal() > 0)) {
      this.chart.addSample({
        buffer: this._bufferAhead(),
        mbps: this.lastSegMbps,
        stalled: this.stallStartedAt !== null,
      });
    }
  }

  render() {
    const v = this.video;
    let stallMs = this.stallMs;
    if (this.stallStartedAt !== null) stallMs += performance.now() - this.stallStartedAt;

    const rows = [];
    const s = this._score(stallMs);
    rows.push({
      label: "Overall score",
      value: s
        ? `${s.value} · ${s.label}`
        : this.playRequestedAt !== null ? "measuring…" : "press play",
      cls: s ? (s.value >= 75 ? "score-good" : s.value >= 55 ? "score-mid" : "score-low") : "",
      score: true,
    });
    rows.push({
      label: "Start delay",
      value:
        this.startupMs !== null
          ? this.startupMs >= 1000
            ? `${(this.startupMs / 1000).toFixed(1)} s`
            : `${Math.round(this.startupMs)} ms`
          : "—",
    });
    rows.push({ label: "Freezes", value: `${this.stallCount} (${(stallMs / 1000).toFixed(1)} s)` });
    rows.push({ label: "Quality", value: v.videoHeight ? `${v.videoHeight}p` : "—" });
    const dl = this._downloadedBytes();
    if (dl) {
      rows.push({ label: dl.exact ? "Data used" : "Data used (est.)", value: `${(dl.bytes / 1e6).toFixed(1)} MB` });
    }
    if (this.hls && this.downloadMs) {
      rows.push({
        label: "Speed",
        value: `${((this.bytesDownloaded * 8) / this.downloadMs / 1000).toFixed(1)} Mbps`,
      });
    }

    if (this.advanced) {
      rows.push({ label: "Buffer ahead", value: `${this._bufferAhead().toFixed(1)} s` });
      rows.push({ label: "Dropped frames", value: this._dropped() });
      if (this.hls) {
        const level = this.hls.levels?.[this.hls.currentLevel];
        rows.push({ label: "Segments loaded", value: String(this.segmentsLoaded) });
        rows.push({ label: "Last segment", value: this.lastSegMbps ? `${this.lastSegMbps.toFixed(1)} Mbps` : "—" });
        rows.push({ label: "Bitrate", value: level ? `${Math.round(level.bitrate / 1000)} kbps` : "auto" });
        rows.push({ label: "Quality switches", value: String(this.levelSwitches) });
        rows.push({
          label: "Bandwidth est.",
          value: this.hls.bandwidthEstimate ? `${(this.hls.bandwidthEstimate / 1e6).toFixed(1)} Mbps` : "—",
        });
      }
    }

    if (v.error) {
      rows.push({ label: "Error", value: v.error.message || `code ${v.error.code}`, cls: "score-low" });
    }

    this.hud.innerHTML = rows
      .map(
        (r) =>
          `<div class="stat${r.score ? " score" : ""}"><div class="label">${r.label}</div>` +
          `<div class="value${r.cls ? ` ${r.cls}` : ""}">${r.value}</div></div>`
      )
      .join("");
  }

  destroy() {
    clearInterval(this.timer);
  }
}
