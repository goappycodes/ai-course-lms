// Minimal dependency-free strip chart: buffer level + segment download speed
// over the last ~60s, with rebuffer periods shaded red.
const WINDOW_SAMPLES = 120; // at 2 samples/s -> 60 s

export class StripChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.samples = []; // { buffer (s), mbps (or null), stalled (bool) }
  }

  addSample(sample) {
    this.samples.push(sample);
    if (this.samples.length > WINDOW_SAMPLES) this.samples.shift();
    this.render();
  }

  reset() {
    this.samples = [];
    this.render();
  }

  render() {
    const c = this.canvas;
    // Match the backing store to CSS size for crisp lines.
    const cssWidth = c.clientWidth || 600;
    if (c.width !== cssWidth) c.width = cssWidth;
    const w = c.width;
    const h = c.height;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);

    const n = this.samples.length;
    if (n < 2) return;
    const stepX = w / (WINDOW_SAMPLES - 1);
    const x = (i) => w - (n - 1 - i) * stepX;

    const maxBuffer = Math.max(10, ...this.samples.map((s) => s.buffer));
    const mbpsValues = this.samples.map((s) => s.mbps).filter((v) => v != null);
    const maxMbps = Math.max(2, ...mbpsValues);

    // Rebuffer shading behind everything else.
    ctx.fillStyle = "rgba(231, 76, 60, 0.25)";
    for (let i = 0; i < n; i++) {
      if (this.samples[i].stalled) ctx.fillRect(x(i) - stepX / 2, 0, stepX, h);
    }

    // Faint gridlines at 1/4, 1/2, 3/4.
    ctx.strokeStyle = "rgba(139, 148, 163, 0.15)";
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, h * f);
      ctx.lineTo(w, h * f);
      ctx.stroke();
    }

    const drawSeries = (get, max, color, fill) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = get(this.samples[i]);
        if (v == null) continue;
        const y = h - (v / max) * (h - 8) - 2;
        if (!started) { ctx.moveTo(x(i), y); started = true; }
        else ctx.lineTo(x(i), y);
      }
      if (!started) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (fill) {
        ctx.lineTo(x(n - 1), h);
        ctx.lineTo(x(0), h);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      }
    };

    drawSeries((s) => s.buffer, maxBuffer, "#2ecc71", "rgba(46, 204, 113, 0.12)");
    drawSeries((s) => s.mbps, maxMbps, "#4f8ef7", null);

    // Scale labels for each series' max.
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "#2ecc71";
    ctx.fillText(`${maxBuffer.toFixed(0)} s`, 4, 12);
    ctx.fillStyle = "#4f8ef7";
    ctx.fillText(`${maxMbps.toFixed(0)} Mbps`, 4, 24);
  }
}
