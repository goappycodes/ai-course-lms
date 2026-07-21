// Upload a video file (or an HLS folder) to S3 for CloudFront delivery.
// Usage: node scripts/upload-s3.mjs <file-or-dir> <s3-key-or-prefix>
//   e.g. node scripts/upload-s3.mjs ./lesson1.mp4 videos/lesson1.mp4
//        node scripts/upload-s3.mjs ./out/lesson1 hls/lesson1
import "dotenv/config";
import fs from "node:fs";
import { makeS3Client, putFile, uploadDir } from "../lib/providers.mjs";

const { AWS_REGION, S3_BUCKET, CLOUDFRONT_URL } = process.env;
if (!S3_BUCKET || !AWS_REGION) {
  console.error("Missing AWS_REGION / S3_BUCKET in .env (see .env.example).");
  process.exit(1);
}

const [target, key] = process.argv.slice(2);
if (!target || !key) {
  console.error("Usage: node scripts/upload-s3.mjs <file-or-dir> <s3-key-or-prefix>");
  process.exit(1);
}

const s3 = makeS3Client(process.env);
let playbackKey = key;

if (fs.statSync(target).isDirectory()) {
  console.log(`Uploading folder to s3://${S3_BUCKET}/${key} …`);
  const count = await uploadDir(s3, S3_BUCKET, target, key, {
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  ${done}/${total}`);
    },
  });
  console.log(`Uploaded ${count} files.`);
  playbackKey = `${key.replace(/\/+$/, "")}/master.m3u8`;
} else {
  await putFile(s3, S3_BUCKET, key, target);
  console.log(`Uploaded s3://${S3_BUCKET}/${key}`);
}

console.log("\nUpload complete.");
console.log(`Set in .env:  S3_VIDEO_KEY=${playbackKey}`);
if (CLOUDFRONT_URL) {
  console.log(`Playback URL: ${CLOUDFRONT_URL.replace(/\/+$/, "")}/${playbackKey}`);
} else {
  console.log("Also set CLOUDFRONT_URL once your CloudFront distribution exists (npm run setup:aws creates it).");
}
