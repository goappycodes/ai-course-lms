// Upload a video to Cloudflare Stream (basic upload, files up to 200 MB).
// Usage: node scripts/upload-stream.mjs <file.mp4>
// For larger files, upload via the Cloudflare dashboard (Stream -> Upload)
// and copy the video UID into .env instead.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

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
if (size > 200 * 1024 * 1024) {
  console.error(
    `File is ${(size / 1e6).toFixed(0)} MB — the basic upload API caps at 200 MB.\n` +
    "Upload it via the Cloudflare dashboard (Stream -> Upload) and set CF_STREAM_VIDEO_UID manually."
  );
  process.exit(1);
}

console.log(`Uploading ${file} (${(size / 1e6).toFixed(1)} MB) to Cloudflare Stream…`);

const form = new FormData();
form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${CF_STREAM_API_TOKEN}` },
    body: form,
  }
);
const json = await res.json();
if (!json.success) {
  console.error("Upload failed:", JSON.stringify(json.errors, null, 2));
  process.exit(1);
}

const video = json.result;
console.log("\nUpload accepted. Stream is now encoding it (usually ready in ~1x video length or less).");
console.log(`Video UID: ${video.uid}`);

// The HLS playback URL embeds the customer code: customer-XXXX.cloudflarestream.com
const hls = video.playback?.hls || "";
const match = hls.match(/customer-([a-z0-9]+)\.cloudflarestream\.com/);
console.log("\nSet in .env:");
console.log(`  CF_STREAM_VIDEO_UID=${video.uid}`);
if (match) console.log(`  CF_STREAM_CUSTOMER_CODE=${match[1]}`);
if (hls) console.log(`\nHLS URL: ${hls}`);
