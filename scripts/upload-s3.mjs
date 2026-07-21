// Upload a video file (or an HLS folder) to S3 for CloudFront delivery.
// Usage: node scripts/upload-s3.mjs <file-or-dir> <s3-key-or-prefix>
//   e.g. node scripts/upload-s3.mjs ./lesson1.mp4 videos/lesson1.mp4
//        node scripts/upload-s3.mjs ./out/lesson1 hls/lesson1
import "dotenv/config";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";

const { AWS_REGION, S3_BUCKET, CLOUDFRONT_URL } = process.env;
if (!S3_BUCKET || !AWS_REGION) {
  console.error("Missing AWS_REGION / S3_BUCKET in .env (see .env.example). AWS credentials come from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.");
  process.exit(1);
}

const [target, key] = process.argv.slice(2);
if (!target || !key) {
  console.error("Usage: node scripts/upload-s3.mjs <file-or-dir> <s3-key-or-prefix>");
  process.exit(1);
}

const CONTENT_TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mp4": "video/mp4",
  ".m4s": "video/iso.segment",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".vtt": "text/vtt",
};

const s3 = new S3Client({ region: AWS_REGION });

async function put(file, s3Key) {
  const ext = path.extname(file).toLowerCase();
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: fs.createReadStream(file),
    ContentLength: fs.statSync(file).size,
    ContentType: CONTENT_TYPES[ext] || "application/octet-stream",
    CacheControl: ext === ".m3u8" ? "public, max-age=60" : "public, max-age=31536000, immutable",
  }));
  console.log(`  uploaded s3://${S3_BUCKET}/${s3Key}`);
}

function* walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const stat = fs.statSync(target);
let playbackKey = key;
if (stat.isDirectory()) {
  for (const file of walk(target)) {
    const rel = path.relative(target, file).split(path.sep).join("/");
    await put(file, `${key.replace(/\/+$/, "")}/${rel}`);
  }
  playbackKey = `${key.replace(/\/+$/, "")}/master.m3u8`;
} else {
  await put(target, key);
}

console.log("\nUpload complete.");
console.log(`Set in .env:  S3_VIDEO_KEY=${playbackKey}`);
if (CLOUDFRONT_URL) {
  console.log(`Playback URL: ${CLOUDFRONT_URL.replace(/\/+$/, "")}/${playbackKey}`);
} else {
  console.log("Also set CLOUDFRONT_URL once your CloudFront distribution is created (see README).");
}
