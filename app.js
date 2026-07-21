import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeHlsLadder, findBinary, makeR2Client, makeS3Client,
  putBucketCorsOpen, uploadDir, streamTusUpload, streamGetPlayback, muxUpload,
} from "./lib/providers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// On Vercel the filesystem is read-only and functions are short-lived, so the
// upload/encode pipeline is local-only; the deployed site serves players +
// config from the committed deploy-config.json snapshot.
const SERVERLESS = Boolean(process.env.VERCEL);
const UPLOADS_DIR = path.join(__dirname, "uploads");
const OUT_DIR = path.join(__dirname, "out");
const DATA_FILE = path.join(__dirname, "data", "current.json");
const SNAPSHOT_FILE = path.join(__dirname, "deploy-config.json");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Results of the last successful pipeline run — these override .env video IDs
// so the players switch to the newest uploaded course video automatically.
function readCurrent() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Committed, secret-free snapshot of the latest published video (playback IDs
// and public URLs only) — lets the Vercel deployment play the real videos
// without any environment variables. Written by the pipeline's finalize step.
function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeCurrent(patch) {
  const merged = { ...readCurrent(), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

// Refresh the committed snapshot with ONLY public playback identifiers —
// no tokens or keys ever go in here.
function writeSnapshot(slug, results) {
  const env = process.env;
  const snap = { ...readSnapshot(), slug, updatedAt: new Date().toISOString() };
  if (results.stream) snap.stream = results.stream;
  if (results.mux) snap.mux = results.mux;
  if (results.s3 && env.CLOUDFRONT_URL) snap.s3 = { base: env.CLOUDFRONT_URL, key: results.s3.key };
  if (results.r2 && env.R2_PUBLIC_URL) snap.r2 = { base: env.R2_PUBLIC_URL, prefix: results.r2.prefix };
  if (env.YOUTUBE_VIDEO_ID) snap.youtube = { videoId: env.YOUTUBE_VIDEO_ID };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2) + "\n");
}

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
  const cur = readCurrent();
  const snap = readSnapshot();

  // --- Cloudflare Stream ---
  const streamCode = cur.stream?.customerCode || env.CF_STREAM_CUSTOMER_CODE || snap.stream?.customerCode;
  const streamUid = cur.stream?.uid || env.CF_STREAM_VIDEO_UID || snap.stream?.uid;
  const streamConfigured = Boolean(streamCode && streamUid);
  const sc = streamConfigured ? streamCode : DEMO.streamCustomerCode;
  const su = streamConfigured ? streamUid : DEMO.streamVideoUid;
  const stream = {
    configured: streamConfigured,
    hlsUrl: `https://customer-${sc}.cloudflarestream.com/${su}/manifest/video.m3u8`,
    iframeUrl: `https://customer-${sc}.cloudflarestream.com/${su}/iframe`,
    poster: `https://customer-${sc}.cloudflarestream.com/${su}/thumbnails/thumbnail.jpg?time=2s`,
  };

  // --- MUX ---
  const muxPlaybackId = cur.mux?.playbackId || env.MUX_PLAYBACK_ID || snap.mux?.playbackId;
  const muxConfigured = Boolean(muxPlaybackId);
  const mux = {
    configured: muxConfigured,
    playbackId: muxConfigured ? muxPlaybackId : DEMO.muxPlaybackId,
    hlsUrl: muxConfigured ? `https://stream.mux.com/${muxPlaybackId}.m3u8` : DEMO.muxHls,
    poster: muxConfigured ? `https://image.mux.com/${muxPlaybackId}/thumbnail.jpg?time=2` : null,
  };

  // --- S3 + CloudFront ---
  const s3Key = cur.s3?.key || env.S3_VIDEO_KEY || snap.s3?.key;
  const s3Base = env.CLOUDFRONT_URL || snap.s3?.base;
  const s3Configured = Boolean(s3Base && s3Key);
  const s3 = {
    configured: s3Configured,
    url: s3Configured ? joinUrl(s3Base, s3Key) : DEMO.mp4,
    // Poster exists only for pipeline-encoded HLS uploads (it sits next to master.m3u8).
    poster: s3Configured && /master\.m3u8$/.test(s3Key)
      ? joinUrl(s3Base, s3Key.replace(/master\.m3u8$/, "poster.jpg"))
      : null,
  };

  // --- R2 + self-managed HLS ---
  const r2Prefix = cur.r2?.prefix || env.R2_VIDEO_PREFIX || snap.r2?.prefix;
  const r2Base = env.R2_PUBLIC_URL || snap.r2?.base;
  const r2Configured = Boolean(r2Base && r2Prefix);
  const r2 = {
    configured: r2Configured,
    url: r2Configured
      ? joinUrl(r2Base, `${r2Prefix.replace(/\/+$/, "")}/master.m3u8`)
      : DEMO.hls,
    poster: r2Configured
      ? joinUrl(r2Base, `${r2Prefix.replace(/\/+$/, "")}/poster.jpg`)
      : null,
  };

  // --- YouTube (benchmark) ---
  const youtubeId = env.YOUTUBE_VIDEO_ID || snap.youtube?.videoId;
  const youtube = {
    configured: Boolean(youtubeId),
    videoId: youtubeId || "M7lc1UVf-VE",
  };

  // Which providers the upload pipeline can push to with current credentials.
  const upload = {
    serverless: SERVERLESS,
    ffmpeg: !SERVERLESS && Boolean(findBinary("ffmpeg")),
    stream: !SERVERLESS && Boolean(env.CF_ACCOUNT_ID && env.CF_STREAM_API_TOKEN),
    mux: !SERVERLESS && Boolean(env.MUX_TOKEN_ID && env.MUX_TOKEN_SECRET),
    s3: !SERVERLESS && Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.S3_BUCKET),
    r2: !SERVERLESS && Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET),
  };

  res.json({ stream, mux, s3, r2, youtube, upload, current: cur.slug || snap.slug || null });
});

// ------------------------------------------------------------- uploads -----

// multer.diskStorage() mkdirs its destination at construction time, which
// crashes on Vercel's read-only filesystem — so build the middleware lazily,
// only when a local upload actually arrives (localOnly 501s first on Vercel).
let uploadMiddleware = null;
function uploadSingle(req, res, next) {
  if (!uploadMiddleware) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const storage = multer.diskStorage({
      destination: UPLOADS_DIR,
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
        cb(null, `${Date.now().toString(36)}-${safe}`);
      },
    });
    uploadMiddleware = multer({ storage, limits: { fileSize: 6 * 1024 * 1024 * 1024 } }).single("video");
  }
  return uploadMiddleware(req, res, next);
}

// The pipeline needs ffmpeg, a writable disk, and minutes of runtime — none of
// which serverless offers. Run `npm start` locally to upload/encode/publish.
function localOnly(_req, res, next) {
  if (SERVERLESS) {
    return res.status(501).json({
      error: "The upload pipeline runs on your local machine only. Run `npm start` locally, upload there, then commit the updated deploy-config.json to publish the result here.",
    });
  }
  next();
}

app.post("/api/upload", localOnly, uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received (field name: video)." });
  res.json({
    filename: req.file.filename,
    size: req.file.size,
    originalName: req.file.originalname,
  });
});

// --------------------------------------------------------- job pipeline ----

const jobs = new Map();
let activeJobId = null;

function setStep(job, key, patch) {
  const step = job.steps.find((s) => s.key === key);
  Object.assign(step, patch);
}
function log(job, msg) {
  job.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
}

async function runPipeline(job, filePath, providers) {
  const env = process.env;
  const slug = job.slug;
  const outDir = path.join(OUT_DIR, slug);
  const needEncode = job.steps.some((s) => s.key === "encode");

  try {
    if (needEncode) {
      setStep(job, "encode", { status: "running" });
      log(job, `Encoding HLS ladder -> ${outDir}`);
      await encodeHlsLadder(filePath, outDir, {
        onLog: (m) => log(job, m),
        onProgress: (name, f) =>
          setStep(job, "encode", { detail: `${name}: ${(f * 100).toFixed(0)}%` }),
      });
      setStep(job, "encode", { status: "done", detail: "master.m3u8 + ladder ready" });
    }

    if (providers.includes("stream")) {
      setStep(job, "stream", { status: "running", detail: "uploading (tus)…" });
      try {
        const uid = await streamTusUpload(
          filePath,
          { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_STREAM_API_TOKEN },
          {
            onLog: (m) => log(job, m),
            onProgress: (f) => setStep(job, "stream", { detail: `upload ${(f * 100).toFixed(0)}%` }),
          }
        );
        setStep(job, "stream", { detail: "Stream is encoding…" });
        const pb = await streamGetPlayback(env.CF_ACCOUNT_ID, env.CF_STREAM_API_TOKEN, uid, {
          onLog: (m) => log(job, m),
        });
        job.results.stream = { uid, customerCode: pb.customerCode };
        setStep(job, "stream", { status: "done", detail: `uid ${uid}` });
      } catch (err) {
        log(job, `Stream failed: ${err.message}`);
        setStep(job, "stream", { status: "error", detail: err.message.slice(0, 200) });
      }
    }

    if (providers.includes("mux")) {
      setStep(job, "mux", { status: "running", detail: "uploading…" });
      try {
        const { playbackId } = await muxUpload(filePath, env, {
          onLog: (m) => log(job, m),
          onProgress: (f) => setStep(job, "mux", { detail: `${(f * 100).toFixed(0)}%` }),
        });
        job.results.mux = { playbackId };
        setStep(job, "mux", { status: "done", detail: `playback ${playbackId}` });
      } catch (err) {
        log(job, `MUX failed: ${err.message}`);
        setStep(job, "mux", { status: "error", detail: err.message.slice(0, 200) });
      }
    }

    if (providers.includes("s3")) {
      setStep(job, "s3", { status: "running" });
      try {
        const client = makeS3Client(env);
        await putBucketCorsOpen(client, env.S3_BUCKET).catch(() => {});
        const prefix = `hls/${slug}`;
        await uploadDir(client, env.S3_BUCKET, outDir, prefix, {
          onProgress: (done, total) => setStep(job, "s3", { detail: `${done}/${total} files` }),
        });
        job.results.s3 = { key: `${prefix}/master.m3u8` };
        setStep(job, "s3", { status: "done", detail: `s3://${env.S3_BUCKET}/${prefix}` });
        if (!env.CLOUDFRONT_URL) log(job, "S3 uploaded, but CLOUDFRONT_URL is not set — run npm run setup:aws.");
      } catch (err) {
        log(job, `S3 failed: ${err.message}`);
        setStep(job, "s3", { status: "error", detail: err.message.slice(0, 200) });
      }
    }

    if (providers.includes("r2")) {
      setStep(job, "r2", { status: "running" });
      try {
        const client = makeR2Client(env);
        await putBucketCorsOpen(client, env.R2_BUCKET);
        const prefix = `hls/${slug}`;
        await uploadDir(client, env.R2_BUCKET, outDir, prefix, {
          onProgress: (done, total) => setStep(job, "r2", { detail: `${done}/${total} files` }),
        });
        job.results.r2 = { prefix };
        setStep(job, "r2", { status: "done", detail: `r2://${env.R2_BUCKET}/${prefix}` });
        if (!env.R2_PUBLIC_URL) log(job, "R2 uploaded, but R2_PUBLIC_URL is not set — enable public access on the bucket.");
      } catch (err) {
        log(job, `R2 failed: ${err.message}`);
        setStep(job, "r2", { status: "error", detail: err.message.slice(0, 200) });
      }
    }

    setStep(job, "finalize", { status: "running" });
    if (Object.keys(job.results).length > 0) {
      writeCurrent({ slug, ...job.results });
      writeSnapshot(slug, job.results);
      setStep(job, "finalize", { status: "done", detail: "players now serve this video" });
      log(job, "Saved results — player pages now use the uploaded video.");
      log(job, "deploy-config.json updated — commit & push it to update the Vercel site.");
    } else if (providers.length === 0 || providers[0] === "encode-only") {
      setStep(job, "finalize", {
        status: "done",
        detail: `encode-only run — preview at /out/${slug}/master.m3u8`,
      });
    } else {
      setStep(job, "finalize", { status: "error", detail: "no provider succeeded" });
    }
  } catch (err) {
    // Encode failure lands here: mark remaining steps skipped.
    log(job, `Pipeline error: ${err.message}`);
    for (const s of job.steps) {
      if (s.status === "running") { s.status = "error"; s.detail = err.message.slice(0, 200); }
      else if (s.status === "pending") { s.status = "skipped"; }
    }
    job.error = err.message;
  } finally {
    job.done = true;
    activeJobId = null;
  }
}

app.post("/api/process", localOnly, (req, res) => {
  const { filename, providers } = req.body || {};
  if (!filename) return res.status(400).json({ error: "filename required (from /api/upload)." });
  const filePath = path.join(UPLOADS_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Uploaded file not found." });
  if (activeJobId) return res.status(409).json({ error: "A job is already running.", jobId: activeJobId });

  const selected = (Array.isArray(providers) ? providers : []).filter((p) =>
    ["stream", "mux", "s3", "r2"].includes(p)
  );
  const needEncode = selected.includes("r2") || selected.includes("s3");
  if (needEncode && !findBinary("ffmpeg")) {
    return res.status(400).json({ error: "ffmpeg not found — needed for the R2/S3 HLS encode." });
  }

  const id = Date.now().toString(36);
  const slug = path.basename(filename).replace(/\.[^.]+$/, "").toLowerCase();
  const steps = [];
  if (needEncode || selected.length === 0) steps.push({ key: "encode", name: "Encode HLS ladder (ffmpeg)" });
  if (selected.includes("stream")) steps.push({ key: "stream", name: "Upload to Cloudflare Stream" });
  if (selected.includes("mux")) steps.push({ key: "mux", name: "Upload to MUX" });
  if (selected.includes("s3")) steps.push({ key: "s3", name: "Upload HLS to S3" });
  if (selected.includes("r2")) steps.push({ key: "r2", name: "Upload HLS to R2" });
  steps.push({ key: "finalize", name: "Point players at the new video" });

  const job = {
    id, slug,
    steps: steps.map((s) => ({ ...s, status: "pending", detail: "" })),
    logs: [], results: {}, done: false, error: null,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  activeJobId = id;
  runPipeline(job, filePath, selected.length === 0 ? ["encode-only"] : selected);
  res.json({ jobId: id });
});

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job." });
  res.json(job);
});

// Serve locally encoded HLS output too (handy for sanity checks).
app.use("/out", express.static(OUT_DIR));

export default app;
