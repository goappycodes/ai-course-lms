// Upload a video to Cloudflare Stream via tus resumable upload (any size).
// Usage: node scripts/upload-stream.mjs <file.mp4>
import "dotenv/config";
import fs from "node:fs";
import { streamTusUpload, streamGetPlayback } from "../lib/providers.mjs";

const { CF_ACCOUNT_ID, CF_STREAM_API_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_STREAM_API_TOKEN) {
  console.error("Missing CF_ACCOUNT_ID / CF_STREAM_API_TOKEN in .env (see .env.example).");
  process.exit(1);
}

const [file] = process.argv.slice(2);
if (!file || !fs.existsSync(file)) {
  console.error("Usage: node scripts/upload-stream.mjs <file.mp4>");
  process.exit(1);
}

const size = fs.statSync(file).size;
console.log(`Uploading ${file} (${(size / 1e6).toFixed(1)} MB) to Cloudflare Stream…`);

const uid = await streamTusUpload(
  file,
  { accountId: CF_ACCOUNT_ID, apiToken: CF_STREAM_API_TOKEN },
  {
    onLog: (msg) => console.log(msg),
    onProgress: (f) => process.stdout.write(`\r  upload: ${(f * 100).toFixed(0)}%   `),
  }
);
console.log("\nUpload complete. Waiting for Stream to encode…");

const { customerCode, hls, readyToStream } = await streamGetPlayback(
  CF_ACCOUNT_ID, CF_STREAM_API_TOKEN, uid,
  { onLog: (msg) => console.log(`  ${msg}`) }
);

console.log(`\n${readyToStream ? "Ready to stream." : "Still encoding (playback URL is already valid)."}`);
console.log("Set in .env:");
console.log(`  CF_STREAM_VIDEO_UID=${uid}`);
if (customerCode) console.log(`  CF_STREAM_CUSTOMER_CODE=${customerCode}`);
if (hls) console.log(`\nHLS URL: ${hls}`);
