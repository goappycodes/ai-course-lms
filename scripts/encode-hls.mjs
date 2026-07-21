// Encode a source video into a multi-bitrate HLS ladder with ffmpeg.
// Usage: node scripts/encode-hls.mjs <input.mp4> <output-dir>
// Produces <output-dir>/master.m3u8 + one folder of segments per rendition.
import fs from "node:fs";
import { encodeHlsLadder } from "../lib/providers.mjs";

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error("Usage: node scripts/encode-hls.mjs <input.mp4> <output-dir>");
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error(`Input not found: ${input}`);
  process.exit(1);
}

let lastLine = "";
const { renditions } = await encodeHlsLadder(input, outDir, {
  onLog: (msg) => console.log(msg),
  onProgress: (name, f) => {
    const line = `  ${name}: ${(f * 100).toFixed(0)}%`;
    if (line !== lastLine) { process.stdout.write(`\r${line}   `); lastLine = line; }
    if (f === 1) process.stdout.write("\n");
  },
});

console.log(`\nDone. HLS ladder written to ${outDir} (${renditions.join(", ")})`);
console.log(`Next: node scripts/upload-r2.mjs ${outDir} hls/lesson1 --cors`);
