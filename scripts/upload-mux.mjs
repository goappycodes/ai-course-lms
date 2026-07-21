// Upload a video to MUX via a direct upload, then wait for the asset
// and print its public playback ID.
// Usage: node scripts/upload-mux.mjs <file.mp4>
import "dotenv/config";
import fs from "node:fs";
import { muxUpload } from "../lib/providers.mjs";

const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;
if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
  console.error("Missing MUX_TOKEN_ID / MUX_TOKEN_SECRET in .env (see .env.example).");
  process.exit(1);
}

const [file] = process.argv.slice(2);
if (!file || !fs.existsSync(file)) {
  console.error("Usage: node scripts/upload-mux.mjs <file.mp4>");
  process.exit(1);
}

const { assetId, playbackId, status } = await muxUpload(file, process.env, {
  onLog: (msg) => console.log(msg),
});

console.log(`\nAsset ${assetId} status: ${status}`);
console.log("Set in .env:");
console.log(`  MUX_PLAYBACK_ID=${playbackId}`);
console.log(`\nHLS URL: https://stream.mux.com/${playbackId}.m3u8`);
