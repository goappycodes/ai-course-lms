// "What is actually happening" section per provider: a pipeline diagram
// (color-coded by who runs each stage), how it's served, pros/cons, and cost.
const COLORS = {
  you: { fill: "#1d2b45", stroke: "#4f8ef7", label: "You manage" },
  vendor: { fill: "#2b1d45", stroke: "#a06df7", label: "Provider manages" },
  edge: { fill: "#1d4530", stroke: "#2ecc71", label: "CDN edge (cached)" },
};

const INFO = {
  stream: {
    how: "You upload one MP4. Cloudflare Stream transcodes it into an adaptive HLS ladder, stores it, and serves it from Cloudflare's CDN. The player fetches a manifest and 4–6 s segments, switching quality to match the connection.",
    stages: [
      { label: "Your MP4", sub: "one upload", who: "you" },
      { label: "Stream encoder", sub: "auto ABR ladder", who: "vendor", arrow: "upload API" },
      { label: "Stream storage", sub: "$5 / 1000 min", who: "vendor" },
      { label: "Cloudflare CDN", sub: "300+ cities", who: "edge" },
      { label: "Player", sub: "HLS adaptive", who: "you", arrow: "$1 / 1000 min watched" },
    ],
    pros: [
      "Simplest pipeline — upload and you're done",
      "Predictable per-minute pricing (not per GB)",
      "Signed URLs and DRM available for a paid course",
      "Same vendor as R2 — easy to mix later",
    ],
    cons: [
      "Delivery fee scales with watch time forever",
      "Basic player and analytics compared to MUX",
      "Less encoding control (fixed ladder)",
    ],
    cost: "Storage $5/1,000 min + delivery $1/1,000 min watched. 1,000 students × 10 h course ≈ 600k min watched ≈ <b>$600</b> per full cohort view-through.",
  },
  mux: {
    how: "Same managed model as Stream: upload once, MUX transcodes (per-title optimized), stores, and serves via multi-CDN. Adds best-in-class player and per-view analytics (MUX Data).",
    stages: [
      { label: "Your MP4", sub: "one upload", who: "you" },
      { label: "MUX encoder", sub: "per-title ABR", who: "vendor", arrow: "direct upload" },
      { label: "MUX storage", sub: "per min stored", who: "vendor" },
      { label: "Multi-CDN", sub: "Fastly + more", who: "edge" },
      { label: "mux-player", sub: "HLS + analytics", who: "you", arrow: "per min streamed" },
    ],
    pros: [
      "Best player, QoE analytics, and encoding quality",
      "Per-title encoding = fewer bits for same quality",
      "Signed playback + DRM add-on",
      "Great developer experience and docs",
    ],
    cons: [
      "Most expensive of the four options",
      "Billed on encode + store + stream, all per minute",
      "Overkill if you don't need the analytics",
    ],
    cost: "Roughly: encode ~$0.04/min (one-time) + storage ~$0.003/min-mo + streaming ~$0.0009/min. The same 600k min cohort ≈ <b>$540 streaming</b> + encode/storage on top — typically the priciest.",
  },
  s3: {
    how: "S3 is dumb storage; CloudFront caches your file at the edge. If you upload a single MP4, browsers progressive-download it (no quality adaptation — one bitrate for everyone). Upload an HLS folder instead (see the R2 encode script) to get adaptation.",
    stages: [
      { label: "Your MP4 / HLS", sub: "you encode (optional)", who: "you" },
      { label: "S3 bucket", sub: "$0.023 / GB-mo", who: "vendor", arrow: "PutObject" },
      { label: "CloudFront", sub: "edge cache", who: "edge", arrow: "OAC (private bucket)" },
      { label: "Player", sub: "progressive or HLS", who: "you", arrow: "egress $0.085–0.11 / GB" },
    ],
    pros: [
      "Mature, boring, infinitely documented",
      "Cheap storage; full control over everything",
      "Signed URLs / cookies for access control",
      "Already on AWS? Zero new vendors",
    ],
    cons: [
      "CloudFront egress dominates cost at scale",
      "No encoding service — single MP4 can't adapt to slow networks",
      "Most console setup (OAC, policies, distribution)",
    ],
    cost: "A 10 h course ≈ 8 GB (720p). 1,000 full view-throughs ≈ 8 TB egress ≈ <b>$680–880</b> per cohort — the per-GB meter is the whole story.",
  },
  r2: {
    how: "You run ffmpeg once to build the same kind of HLS ladder the managed services build, upload the folder to R2, and serve it from R2's public URL (put a custom domain on it and Cloudflare's CDN caches segments at the edge). hls.js in your player does the adaptive switching. R2 charges nothing for egress.",
    stages: [
      { label: "ffmpeg", sub: "your HLS ladder", who: "you" },
      { label: "R2 bucket", sub: "$0.015 / GB-mo", who: "vendor", arrow: "S3-compatible API" },
      { label: "Cloudflare CDN", sub: "via custom domain", who: "edge" },
      { label: "hls.js player", sub: "HLS adaptive", who: "you", arrow: "egress $0 — free" },
    ],
    pros: [
      "Zero egress — cost barely grows with students",
      "Storage cheaper than S3 ($0.015/GB-mo)",
      "Same adaptive HLS experience as managed options",
      "Custom domain = free Cloudflare CDN caching",
    ],
    cons: [
      "You own the encoding pipeline and its bugs",
      "No DRM; signed access needs a Worker in front",
      "Player edge cases (old iOS, smart TVs) are yours to debug",
      "r2.dev URL is rate-limited — custom domain required for production",
    ],
    cost: "That same 8 GB course: storage <b>$0.12/month</b>, delivery <b>$0</b> no matter how many students. The only real cost is your time owning the pipeline.",
  },
  youtube: {
    how: "Benchmark only: YouTube encodes, stores, and serves the video for free through the best-tuned ABR stack on the planet, embedded via iframe. Use it as the quality/startup baseline your chosen option should get close to.",
    stages: [
      { label: "Your MP4", sub: "unlisted upload", who: "you" },
      { label: "YouTube encode", sub: "VP9/AV1 + H.264", who: "vendor" },
      { label: "Google CDN", sub: "unmatched reach", who: "edge" },
      { label: "iframe embed", sub: "YouTube player", who: "vendor", arrow: "free" },
    ],
    pros: [
      "Free, world-class encoding and delivery",
      "The startup/quality bar to compare against",
      "Zero infrastructure to maintain",
    ],
    cons: [
      "Unlisted ≠ private: anyone with the link can watch/share",
      "No real access control — wrong for a paid course",
      "YouTube branding, related videos, possible ads",
      "Embeds of paywalled content sit in ToS gray area",
      "Player metrics are locked inside the iframe",
    ],
    cost: "<b>$0</b>, but you give up access control, branding, and the student data — which is why it's the benchmark, not a candidate.",
  },
};

function diagramSvg(stages) {
  const H = 150;
  const W = 900;
  const gap = 46;
  const boxW = (W - gap * (stages.length - 1) - 20) / stages.length;
  const boxH = 64;
  const y = (H - boxH) / 2;

  let svg = "";
  stages.forEach((s, i) => {
    const x = 10 + i * (boxW + gap);
    const c = COLORS[s.who];
    if (i > 0) {
      const ax0 = x - gap + 4;
      const ax1 = x - 6;
      const ay = y + boxH / 2;
      svg += `<line x1="${ax0}" y1="${ay}" x2="${ax1}" y2="${ay}" stroke="#8b94a3" stroke-width="1.5"/>` +
        `<path d="M ${ax1} ${ay} l -7 -4.5 v 9 z" fill="#8b94a3"/>`;
      if (stages[i].arrow) {
        svg += `<text x="${(ax0 + ax1) / 2}" y="${ay - 10}" text-anchor="middle" font-size="10.5" fill="#8b94a3">${stages[i].arrow}</text>`;
      }
    }
    svg += `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="10" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>` +
      `<text x="${x + boxW / 2}" y="${y + 27}" text-anchor="middle" font-size="13" font-weight="600" fill="#e6e9ee">${s.label}</text>` +
      `<text x="${x + boxW / 2}" y="${y + 45}" text-anchor="middle" font-size="10.5" fill="#8b94a3">${s.sub}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">${svg}</svg>`;
}

export function renderInfo(providerId, container) {
  const info = INFO[providerId];
  if (!info) return;
  const legend = Object.values(COLORS)
    .map((c) => `<span><i class="dot" style="background:${c.stroke}"></i> ${c.label}</span>`)
    .join("");
  container.innerHTML = `
    <h2>What's actually happening here</h2>
    <p class="how">${info.how}</p>
    <div class="diagram-wrap">
      ${diagramSvg(info.stages)}
      <div class="diagram-legend">${legend}</div>
    </div>
    <div class="pros-cons">
      <div class="col pros"><h3>Pros</h3><ul>${info.pros.map((p) => `<li>${p}</li>`).join("")}</ul></div>
      <div class="col cons"><h3>Cons</h3><ul>${info.cons.map((c) => `<li>${c}</li>`).join("")}</ul></div>
    </div>
    <div class="cost-line"><b>Cost reality check:</b> ${info.cost}</div>
  `;
}
