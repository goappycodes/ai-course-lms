// Upload an HLS output folder to Cloudflare R2 (S3-compatible API).
// Usage: node scripts/upload-r2.mjs <local-dir> <r2-prefix> [--cors]
//   e.g. node scripts/upload-r2.mjs ./out/lesson1 hls/lesson1 --cors
// --cors sets a permissive GET CORS policy on the bucket (needed once so
// hls.js in the browser can fetch playlists/segments cross-origin).
import "dotenv/config";
import { S3Client, PutObjectCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";

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

const CONTENT_TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mp4": "video/mp4",
  ".m4s": "video/iso.segment",
  ".jpg": "image/jpeg",
  ".vtt": "text/vtt",
};

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

function* walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

if (setCors) {
  await s3.send(new PutBucketCorsCommand({
    Bucket: R2_BUCKET,
    CORSConfiguration: {
      CORSRules: [{
        AllowedMethods: ["GET", "HEAD"],
        AllowedOrigins: ["*"],
        AllowedHeaders: ["*"],
        MaxAgeSeconds: 86400,
      }],
    },
  }));
  console.log("Bucket CORS policy set (GET/HEAD from any origin).");
}

const files = [...walk(dir)];
console.log(`Uploading ${files.length} files to r2://${R2_BUCKET}/${prefix} …`);
let done = 0;
for (const file of files) {
  const rel = path.relative(dir, file).split(path.sep).join("/");
  const key = `${prefix.replace(/\/+$/, "")}/${rel}`;
  const ext = path.extname(file).toLowerCase();
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: fs.createReadStream(file),
    ContentLength: fs.statSync(file).size,
    ContentType: CONTENT_TYPES[ext] || "application/octet-stream",
    // Segments never change -> cache aggressively. Playlists: short TTL.
    CacheControl: ext === ".m3u8" ? "public, max-age=60" : "public, max-age=31536000, immutable",
  }));
  done += 1;
  if (done % 25 === 0 || done === files.length) console.log(`  ${done}/${files.length}`);
}

console.log("\nUpload complete.");
console.log(`Set in .env:  R2_VIDEO_PREFIX=${prefix}`);
if (R2_PUBLIC_URL) {
  console.log(`Playback URL: ${R2_PUBLIC_URL.replace(/\/+$/, "")}/${prefix}/master.m3u8`);
} else {
  console.log("Also set R2_PUBLIC_URL (enable public access on the bucket or connect a custom domain).");
}
