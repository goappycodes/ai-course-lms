// Encode a source video into a multi-bitrate HLS ladder with ffmpeg.
// Usage: node scripts/encode-hls.mjs <input.mp4> <output-dir>
// Produces <output-dir>/master.m3u8 + one folder of segments per rendition.
// Requires ffmpeg on PATH (Windows: winget install Gyan.FFmpeg).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LADDER = [
  { name: "1080p", height: 1080, vBitrate: "5000k", maxrate: "5350k", bufsize: "7500k", aBitrate: "128k" },
  { name: "720p",  height: 720,  vBitrate: "2800k", maxrate: "2996k", bufsize: "4200k", aBitrate: "128k" },
  { name: "480p",  height: 480,  vBitrate: "1400k", maxrate: "1498k", bufsize: "2100k", aBitrate: "96k" },
  { name: "360p",  height: 360,  vBitrate: "800k",  maxrate: "856k",  bufsize: "1200k", aBitrate: "96k" },
];
const SEGMENT_SECONDS = 4;

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error("Usage: node scripts/encode-hls.mjs <input.mp4> <output-dir>");
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error(`Input not found: ${input}`);
  process.exit(1);
}
if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
  console.error("ffmpeg not found on PATH. Install it first (Windows: winget install Gyan.FFmpeg).");
  process.exit(1);
}

// Probe source height so we don't upscale (e.g. skip 1080p for a 720p source).
const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=height", "-of", "csv=p=0", input,
]);
const sourceHeight = parseInt(probe.stdout?.toString().trim(), 10) || Infinity;
const renditions = LADDER.filter((r) => r.height <= sourceHeight);
if (renditions.length === 0) renditions.push(LADDER[LADDER.length - 1]);

fs.mkdirSync(outDir, { recursive: true });

for (const r of renditions) {
  const dir = path.join(outDir, r.name);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\nEncoding ${r.name}…`);
  const args = [
    "-y", "-i", input,
    "-vf", `scale=-2:${r.height}`,
    "-c:v", "libx264", "-profile:v", "main", "-preset", "medium",
    "-b:v", r.vBitrate, "-maxrate", r.maxrate, "-bufsize", r.bufsize,
    // Keyframe every SEGMENT_SECONDS so segment boundaries align across renditions.
    "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    "-c:a", "aac", "-b:a", r.aBitrate, "-ac", "2",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, "seg_%04d.ts"),
    path.join(dir, "index.m3u8"),
  ];
  const res = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`ffmpeg failed for ${r.name}`);
    process.exit(1);
  }
}

// Master playlist. Bandwidth = video maxrate + audio bitrate with a little headroom.
const toBps = (s) => parseInt(s, 10) * 1000;
const master = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  ...renditions.flatMap((r) => {
    const bandwidth = Math.round((toBps(r.maxrate) + toBps(r.aBitrate)) * 1.1);
    // Width for a 16:9 source; players treat RESOLUTION as a hint, minor mismatch is fine.
    const width = Math.round((r.height * 16) / 9 / 2) * 2;
    return [
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${r.height},CODECS="avc1.4d401f,mp4a.40.2"`,
      `${r.name}/index.m3u8`,
    ];
  }),
].join("\n");
fs.writeFileSync(path.join(outDir, "master.m3u8"), master + "\n");

console.log(`\nDone. HLS ladder written to ${outDir}`);
console.log(`Renditions: ${renditions.map((r) => r.name).join(", ")}`);
console.log(`Next: node scripts/upload-r2.mjs ${outDir} hls/lesson1`);
