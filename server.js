import "dotenv/config";
import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Public demo sources used until real credentials/videos are configured.
const DEMO = {
  streamCustomerCode: "f33zs165nr7gyfy4",
  streamVideoUid: "6b9e68b07dfee8cc2d116e4c51d6a957",
  muxHls: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  muxPlaybackId: "EcHgOK9coz5K4rjSwOkoE7Y7O01201YMIC200RI6lNxnhs",
  // Short CC0 clip; just proves the progressive-MP4 path until a real
  // CloudFront URL is configured.
  mp4: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  hls: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
};

function joinUrl(base, key) {
  return `${base.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

app.get("/api/config", (_req, res) => {
  const env = process.env;

  // --- Cloudflare Stream ---
  const streamConfigured = Boolean(env.CF_STREAM_CUSTOMER_CODE && env.CF_STREAM_VIDEO_UID);
  const sc = streamConfigured ? env.CF_STREAM_CUSTOMER_CODE : DEMO.streamCustomerCode;
  const su = streamConfigured ? env.CF_STREAM_VIDEO_UID : DEMO.streamVideoUid;
  const stream = {
    configured: streamConfigured,
    hlsUrl: `https://customer-${sc}.cloudflarestream.com/${su}/manifest/video.m3u8`,
    iframeUrl: `https://customer-${sc}.cloudflarestream.com/${su}/iframe`,
  };

  // --- MUX ---
  const muxConfigured = Boolean(env.MUX_PLAYBACK_ID);
  const mux = {
    configured: muxConfigured,
    playbackId: muxConfigured ? env.MUX_PLAYBACK_ID : DEMO.muxPlaybackId,
    hlsUrl: muxConfigured ? `https://stream.mux.com/${env.MUX_PLAYBACK_ID}.m3u8` : DEMO.muxHls,
  };

  // --- S3 + CloudFront ---
  const s3Configured = Boolean(env.CLOUDFRONT_URL && env.S3_VIDEO_KEY);
  const s3 = {
    configured: s3Configured,
    url: s3Configured ? joinUrl(env.CLOUDFRONT_URL, env.S3_VIDEO_KEY) : DEMO.mp4,
  };

  // --- YouTube (benchmark) ---
  const youtubeConfigured = Boolean(env.YOUTUBE_VIDEO_ID);
  const youtube = {
    configured: youtubeConfigured,
    videoId: youtubeConfigured ? env.YOUTUBE_VIDEO_ID : "M7lc1UVf-VE",
  };

  // --- R2 + self-managed HLS ---
  const r2Configured = Boolean(env.R2_PUBLIC_URL && env.R2_VIDEO_PREFIX);
  const r2 = {
    configured: r2Configured,
    url: r2Configured
      ? joinUrl(env.R2_PUBLIC_URL, `${env.R2_VIDEO_PREFIX.replace(/\/+$/, "")}/master.m3u8`)
      : DEMO.hls,
  };

  res.json({ stream, mux, s3, r2, youtube });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  LMS video PoC running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === "IPv4" && !iface.internal) {
      console.log(`  Network: http://${iface.address}:${PORT}   <- open this on phones/tablets on the same wifi`);
    }
  }
  console.log("");
});
