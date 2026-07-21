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

    const stats = {
      "Startup time":
        this.startupMs !== null ? `${Math.round(this.startupMs)} ms`
        : this.playRequestedAt !== null ? "loading…"
        : "press play",
      "Resolution": v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : "—",
      "Rebuffers": `${this.stallCount} (${(stallMs / 1000).toFixed(1)} s)`,
      "Buffer ahead": `${this._bufferAhead().toFixed(1)} s`,
      "Dropped frames": this._dropped(),
    };

    const dl = this._downloadedBytes();
    if (dl) {
      stats[dl.exact ? "Downloaded" : "Downloaded (est.)"] = `${(dl.bytes / 1e6).toFixed(1)} MB`;
    }

    if (this.hls) {
      stats["Segments loaded"] = String(this.segmentsLoaded);
      stats["Last segment speed"] = this.lastSegMbps ? `${this.lastSegMbps.toFixed(1)} Mbps` : "—";
      stats["Avg download speed"] = this.downloadMs
        ? `${((this.bytesDownloaded * 8) / this.downloadMs / 1000).toFixed(1)} Mbps`
        : "—";
      const level = this.hls.levels?.[this.hls.currentLevel];
      stats["Bitrate"] = level ? `${Math.round(level.bitrate / 1000)} kbps` : "auto";
      stats["Quality switches"] = String(this.levelSwitches);
      stats["ABR bandwidth est."] = this.hls.bandwidthEstimate
        ? `${(this.hls.bandwidthEstimate / 1e6).toFixed(1)} Mbps`
        : "—";
    }

    if (v.error) {
      stats["Error"] = v.error.message || `code ${v.error.code}`;
    }

    this.hud.innerHTML = Object.entries(stats)
      .map(
        ([label, value]) =>
          `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`
      )
      .join("");
  }

  destroy() {
    clearInterval(this.timer);
  }
}
