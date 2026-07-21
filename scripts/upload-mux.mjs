// Upload a video to MUX via a direct upload, then wait for the asset
// and print its public playback ID.
// Usage: node scripts/upload-mux.mjs <file.mp4>
import "dotenv/config";
import fs from "node:fs";

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

const auth = "Basic " + Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString("base64");
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.mux.com${path}`, {
    ...init,
    headers: { Authorization: auth, "Content-Type": "application/json", ...init.headers },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`MUX API ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
};

console.log("Creating direct upload…");
const upload = await api("/video/v1/uploads", {
  method: "POST",
  body: JSON.stringify({
    cors_origin: "*",
    new_asset_settings: {
      playback_policies: ["public"],
      video_quality: "plus",
    },
  }),
});

const size = fs.statSync(file).size;
console.log(`Uploading ${file} (${(size / 1e6).toFixed(1)} MB)…`);
const putRes = await fetch(upload.url, {
  method: "PUT",
  headers: { "Content-Type": "application/octet-stream" },
  body: fs.readFileSync(file),
});
if (!putRes.ok) {
  console.error(`Upload PUT failed: ${putRes.status}`);
  process.exit(1);
}

console.log("Waiting for MUX to create the asset…");
let assetId = null;
for (let i = 0; i < 60 && !assetId; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const u = await api(`/video/v1/uploads/${upload.id}`);
  if (u.status === "errored") {
    console.error("Upload errored:", JSON.stringify(u.error));
    process.exit(1);
  }
  assetId = u.asset_id || null;
}
if (!assetId) {
  console.error("Timed out waiting for the asset. Check the MUX dashboard.");
  process.exit(1);
}

let asset = await api(`/video/v1/assets/${assetId}`);
console.log(`Asset created: ${assetId} (status: ${asset.status}). Waiting for it to be ready…`);
for (let i = 0; i < 120 && asset.status === "preparing"; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  asset = await api(`/video/v1/assets/${assetId}`);
}

const playbackId = asset.playback_ids?.find((p) => p.policy === "public")?.id;
console.log(`\nAsset status: ${asset.status}`);
console.log("Set in .env:");
console.log(`  MUX_PLAYBACK_ID=${playbackId}`);
console.log(`\nHLS URL: https://stream.mux.com/${playbackId}.m3u8`);
