// Shared provider + encoding functions used by both the CLI scripts and the
// server-side upload pipeline (/api/process).
import { S3Client, PutObjectCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------- utils ----

export const CONTENT_TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mp4": "video/mp4",
  ".m4s": "video/iso.segment",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".vtt": "text/vtt",
};

export function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

export function* walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDir(full);
    else yield full;
  }
}

// ------------------------------------------------------------- ffmpeg ------

// ffmpeg may be on PATH, or installed by winget after the current process
// started (PATH not refreshed) — fall back to winget's install locations.
export function findBinary(name) {
  if (spawnSync(name, ["-version"]).status === 0) return name;
  const wingetRoot = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet");
  const candidates = [path.join(wingetRoot, "Links", `${name}.exe`)];
  const pkgRoot = path.join(wingetRoot, "Packages");
  if (fs.existsSync(pkgRoot)) {
    for (const pkg of fs.readdirSync(pkgRoot)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      const pkgDir = path.join(pkgRoot, pkg);
      for (const sub of fs.readdirSync(pkgDir)) {
        candidates.push(path.join(pkgDir, sub, "bin", `${name}.exe`));
      }
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && spawnSync(c, ["-version"]).status === 0) return c;
  }
  return null;
}

export function probeVideo(input) {
  const ffprobe = findBinary("ffprobe");
  if (!ffprobe) return { height: null, duration: null };
  const out = spawnSync(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=height:format=duration",
    "-of", "json", input,
  ]);
  try {
    const json = JSON.parse(out.stdout.toString());
    return {
      height: json.streams?.[0]?.height ?? null,
      duration: Number(json.format?.duration) || null,
    };
  } catch {
    return { height: null, duration: null };
  }
}

export const LADDER = [
  { name: "1080p", height: 1080, vBitrate: "5000k", maxrate: "5350k", bufsize: "7500k", aBitrate: "128k" },
  { name: "720p",  height: 720,  vBitrate: "2800k", maxrate: "2996k", bufsize: "4200k", aBitrate: "128k" },
  { name: "480p",  height: 480,  vBitrate: "1400k", maxrate: "1498k", bufsize: "2100k", aBitrate: "96k" },
  { name: "360p",  height: 360,  vBitrate: "800k",  maxrate: "856k",  bufsize: "1200k", aBitrate: "96k" },
];
export const SEGMENT_SECONDS = 4;

function runFfmpeg(ffmpeg, args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args);
    let stderrTail = "";
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m && duration && onProgress) {
        const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress(Math.min(0.999, secs / duration));
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: …${stderrTail.slice(-600)}`));
    });
  });
}

// Encode a multi-bitrate HLS ladder. onProgress(renditionName, fraction).
export async function encodeHlsLadder(input, outDir, { onLog = () => {}, onProgress = () => {} } = {}) {
  const ffmpeg = findBinary("ffmpeg");
  if (!ffmpeg) {
    throw new Error("ffmpeg not found. Install it (winget install Gyan.FFmpeg) and retry.");
  }
  const { height: sourceHeight, duration } = probeVideo(input);
  const renditions = LADDER.filter((r) => r.height <= (sourceHeight || Infinity));
  if (renditions.length === 0) renditions.push(LADDER[LADDER.length - 1]);
  fs.mkdirSync(outDir, { recursive: true });

  for (const r of renditions) {
    const dir = path.join(outDir, r.name);
    fs.mkdirSync(dir, { recursive: true });
    onLog(`Encoding ${r.name}…`);
    const args = [
      "-y", "-i", input,
      "-vf", `scale=-2:${r.height}`,
      "-c:v", "libx264", "-profile:v", "main", "-preset", "fast",
      "-b:v", r.vBitrate, "-maxrate", r.maxrate, "-bufsize", r.bufsize,
      // Keyframe every SEGMENT_SECONDS so segment boundaries align across renditions.
      "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
      "-c:a", "aac", "-b:a", r.aBitrate, "-ac", "2",
      "-hls_time", String(SEGMENT_SECONDS),
      "-hls_playlist_type", "vod",
      "-hls_segment_filename", path.join(dir, "seg_%04d.ts"),
      path.join(dir, "index.m3u8"),
    ];
    await runFfmpeg(ffmpeg, args, duration, (f) => onProgress(r.name, f));
    onProgress(r.name, 1);
  }

  // Master playlist. Bandwidth = video maxrate + audio bitrate with headroom.
  const toBps = (s) => parseInt(s, 10) * 1000;
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    ...renditions.flatMap((r) => {
      const bandwidth = Math.round((toBps(r.maxrate) + toBps(r.aBitrate)) * 1.1);
      const width = Math.round((r.height * 16) / 9 / 2) * 2;
      return [
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${r.height},CODECS="avc1.4d401f,mp4a.40.2"`,
        `${r.name}/index.m3u8`,
      ];
    }),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "master.m3u8"), master + "\n");
  onLog(`HLS ladder done: ${renditions.map((r) => r.name).join(", ")}`);
  return { renditions: renditions.map((r) => r.name) };
}

// ----------------------------------------------------------- S3 and R2 -----

export function makeR2Client(env) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export function makeS3Client(env) {
  return new S3Client({ region: env.AWS_REGION });
}

export async function putBucketCorsOpen(client, bucket) {
  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedMethods: ["GET", "HEAD"],
        AllowedOrigins: ["*"],
        AllowedHeaders: ["*"],
        MaxAgeSeconds: 86400,
      }],
    },
  }));
}

export async function putFile(client, bucket, key, file) {
  const ext = path.extname(file).toLowerCase();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(file),
    ContentLength: fs.statSync(file).size,
    ContentType: contentTypeFor(file),
    // Segments never change -> cache aggressively. Playlists: short TTL.
    CacheControl: ext === ".m3u8" ? "public, max-age=60" : "public, max-age=31536000, immutable",
  }));
}

// Upload a directory with limited concurrency. onProgress(done, total).
export async function uploadDir(client, bucket, dir, prefix, { onProgress = () => {}, concurrency = 5 } = {}) {
  const files = [...walkDir(dir)];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const rel = path.relative(dir, file).split(path.sep).join("/");
      await putFile(client, bucket, `${prefix.replace(/\/+$/, "")}/${rel}`, file);
      done += 1;
      onProgress(done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return files.length;
}

// ---------------------------------------------------- Cloudflare Stream ----

// tus resumable upload — works for any size (the basic upload API caps at 200 MB).
export async function streamTusUpload(file, { accountId, apiToken }, { onProgress = () => {}, onLog = () => {} } = {}) {
  const size = fs.statSync(file).size;
  const name = Buffer.from(path.basename(file)).toString("base64");

  const createRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(size),
        "Upload-Metadata": `name ${name}`,
      },
    }
  );
  if (createRes.status !== 201) {
    throw new Error(`Stream tus create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const location = createRes.headers.get("location");
  const uid = createRes.headers.get("stream-media-id");
  onLog(`Stream upload created (uid ${uid})`);

  const CHUNK = 50 * 1024 * 1024; // multiple of 256 KiB, >= 5 MB
  const fd = fs.openSync(file, "r");
  try {
    let offset = 0;
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const res = await fetch(location, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
        },
        body: buf,
      });
      if (res.status !== 204) {
        throw new Error(`Stream tus chunk failed at ${offset}: ${res.status} ${await res.text()}`);
      }
      offset += len;
      onProgress(offset / size);
    }
  } finally {
    fs.closeSync(fd);
  }
  return uid;
}

// Poll video details until playback URLs exist; returns { customerCode, hls, readyToStream }.
export async function streamGetPlayback(accountId, apiToken, uid, { onLog = () => {}, timeoutMs = 15 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    const json = await res.json();
    if (!json.success) throw new Error(`Stream video fetch failed: ${JSON.stringify(json.errors)}`);
    last = json.result;
    const hls = last.playback?.hls;
    if (hls) {
      const match = hls.match(/customer-([a-z0-9]+)\.cloudflarestream\.com/);
      if (last.readyToStream) {
        return { customerCode: match?.[1] ?? null, hls, readyToStream: true };
      }
      onLog(`Stream encoding… ${last.status?.pctComplete ?? ""}%`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  // Playback URL exists even if encoding hasn't finished; return what we have.
  const hls = last?.playback?.hls ?? null;
  const match = hls?.match(/customer-([a-z0-9]+)\.cloudflarestream\.com/);
  return { customerCode: match?.[1] ?? null, hls, readyToStream: false };
}

// --------------------------------------------------------------- MUX --------

async function muxApi(env, apiPath, init = {}) {
  const auth = "Basic " + Buffer.from(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`).toString("base64");
  const res = await fetch(`https://api.mux.com${apiPath}`, {
    ...init,
    headers: { Authorization: auth, "Content-Type": "application/json", ...init.headers },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`MUX API ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
}

export async function muxUpload(file, env, { onProgress = () => {}, onLog = () => {} } = {}) {
  onLog("Creating MUX direct upload…");
  const upload = await muxApi(env, "/video/v1/uploads", {
    method: "POST",
    body: JSON.stringify({
      cors_origin: "*",
      new_asset_settings: { playback_policies: ["public"], video_quality: "plus" },
    }),
  });

  const size = fs.statSync(file).size;
  onLog(`Uploading ${(size / 1e6).toFixed(0)} MB to MUX…`);
  const putRes = await fetch(upload.url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) },
    body: fs.createReadStream(file),
    duplex: "half",
  });
  if (!putRes.ok) throw new Error(`MUX upload PUT failed: ${putRes.status}`);
  onProgress(0.5);

  onLog("Waiting for MUX to create the asset…");
  let assetId = null;
  for (let i = 0; i < 100 && !assetId; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const u = await muxApi(env, `/video/v1/uploads/${upload.id}`);
    if (u.status === "errored") throw new Error(`MUX upload errored: ${JSON.stringify(u.error)}`);
    assetId = u.asset_id || null;
  }
  if (!assetId) throw new Error("Timed out waiting for the MUX asset.");

  let asset = await muxApi(env, `/video/v1/assets/${assetId}`);
  onLog(`MUX asset ${assetId} (${asset.status}). Waiting until ready…`);
  for (let i = 0; i < 240 && asset.status === "preparing"; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    asset = await muxApi(env, `/video/v1/assets/${assetId}`);
    onProgress(0.5 + Math.min(0.49, i * 0.01));
  }
  const playbackId = asset.playback_ids?.find((p) => p.policy === "public")?.id;
  if (!playbackId) throw new Error(`MUX asset has no public playback id (status ${asset.status}).`);
  onProgress(1);
  return { assetId, playbackId, status: asset.status };
}
