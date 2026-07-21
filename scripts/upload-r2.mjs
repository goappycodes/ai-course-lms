// Upload an HLS output folder to Cloudflare R2 (S3-compatible API).
// Usage: node scripts/upload-r2.mjs <local-dir> <r2-prefix> [--cors]
//   e.g. node scripts/upload-r2.mjs ./out/lesson1 hls/lesson1 --cors
// --cors sets a permissive GET CORS policy on the bucket (needed once so
// hls.js in the browser can fetch playlists/segments cross-origin).
import "dotenv/config";
import { makeR2Client, putBucketCorsOpen, uploadDir } from "../lib/providers.mjs";

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } = process.env;
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error("Missing R2_* variables in .env (see .env.example).");
  process.exit(1);
}

const [dir, prefix] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const setCors = process.argv.includes("--cors");
if (!dir || !prefix) {
  console.error("Usage: node scripts/upload-r2.mjs <local-dir> <r2-prefix> [--cors]");
  process.exit(1);
}

const s3 = makeR2Client(process.env);

if (setCors) {
  await putBucketCorsOpen(s3, R2_BUCKET);
  console.log("Bucket CORS policy set (GET/HEAD from any origin).");
}

console.log(`Uploading to r2://${R2_BUCKET}/${prefix} …`);
const count = await uploadDir(s3, R2_BUCKET, dir, prefix, {
  onProgress: (done, total) => {
    if (done % 25 === 0 || done === total) console.log(`  ${done}/${total}`);
  },
});

console.log(`\nUpload complete (${count} files).`);
console.log(`Set in .env:  R2_VIDEO_PREFIX=${prefix}`);
if (R2_PUBLIC_URL) {
  console.log(`Playback URL: ${R2_PUBLIC_URL.replace(/\/+$/, "")}/${prefix}/master.m3u8`);
} else {
  console.log("Also set R2_PUBLIC_URL (enable public access on the bucket or connect a custom domain).");
}
