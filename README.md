# AI Course LMS — Video Hosting Proof of Concept

Compares four ways to host course videos, each behind the **same unified player**
(hls.js / native HLS) with a metrics HUD, so numbers are directly comparable
across devices:

| # | Option | What it is | Main cost driver |
|---|--------|-----------|------------------|
| 1 | **Cloudflare Stream** | Fully managed (encode + store + deliver + player) | $5/1000 min stored + $1/1000 min delivered |
| 2 | **MUX** | Fully managed, best-in-class player & analytics | Per-minute encode + store + stream (highest) |
| 3 | **S3 + CloudFront** | You upload MP4/HLS, CloudFront CDN serves it | CloudFront egress (~$0.085–0.11/GB) |
| 4 | **R2 + own encoding** | You encode HLS with ffmpeg, R2 serves it | Storage only ($0.015/GB-mo) — **zero egress** |
| 5 | **YouTube embed** | Free benchmark — the quality bar to compare against | Free (but no access control) |

The HUD shows: startup time, resolution, rebuffer count/duration, buffer ahead,
dropped frames, bytes downloaded, and (for HLS via hls.js) segments loaded,
last/average measured segment download speed, bitrate, quality switches, and the
ABR bandwidth estimate. A **live chart** plots buffer level and segment download
speed over the last 60 s, with rebuffer periods shaded red.

In-player controls:
- **Quality selector** — force any rung of the ladder or leave on auto.
- **Bandwidth throttle** — simulate 0.6–16 Mbps connections (HLS sources only;
  it works by pacing hls.js segment delivery, so ABR reacts for real). For
  progressive MP4 or YouTube, use browser DevTools throttling instead.
- **Reload & re-measure** — fresh join-time measurement.

Stream and MUX pages also have a toggle to their **official players** to compare
vendor player UX, and every page ends with an architecture diagram
(who manages which stage), pros/cons, and a cost reality check.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. The terminal also prints a `Network:` URL — open that
on phones/tablets on the same wifi to test other devices.

**Every player works immediately with a public demo video.** Cards show
`demo` until you configure the real source in `.env` (copy `.env.example` → `.env`).

## Upload interface

Open **/upload.html** (linked from the home page): drop one lesson MP4, tick
the providers you want, and the server encodes an HLS ladder with ffmpeg,
pushes the file to Cloudflare Stream + MUX (they encode themselves) and the
HLS folder to S3 + R2, then points every player page at the new video
(results persist in `data/current.json`, which overrides the `.env` video IDs).
Providers without credentials in `.env` show as disabled.

## Deploying the players (Vercel)

The player pages + `/api/config` run fine on Vercel (`api/index.js` +
`vercel.json` are already set up) — useful for testing on any device without
being on your wifi. The **upload pipeline is local-only** (needs ffmpeg, a
writable disk, and long runtimes): upload locally, then commit the refreshed
`deploy-config.json` — a secret-free snapshot of playback IDs/URLs — and push;
Vercel redeploys and the hosted players switch to the new video. No environment
variables are needed on Vercel.

## Configure each option

### 1. Cloudflare Stream

1. Cloudflare dashboard → **Stream** → subscribe ($5/mo minimum).
2. Create an API token with **Stream:Edit** (My Profile → API Tokens).
3. Fill `CF_ACCOUNT_ID`, `CF_STREAM_API_TOKEN` in `.env`.
4. Upload: `node scripts/upload-stream.mjs lesson1.mp4` — it prints
   `CF_STREAM_VIDEO_UID` and `CF_STREAM_CUSTOMER_CODE` for `.env`.
   (Files > 200 MB: upload in the dashboard instead and copy the UID.)

### 2. MUX

1. dashboard.mux.com → Settings → **Access Tokens** → new token (Mux Video, read+write).
2. Fill `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` in `.env`.
3. Upload: `node scripts/upload-mux.mjs lesson1.mp4` — waits for encoding and
   prints `MUX_PLAYBACK_ID` for `.env`.

### 3. S3 + CloudFront

1. Put `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` in `.env`
   (keys need S3 + CloudFront create permissions for the setup script).
2. Run `npm run setup:aws` — creates a private bucket, an Origin Access
   Control, and a CloudFront distribution (CachingOptimized + SimpleCORS,
   PriceClass_200), locks the bucket to CloudFront-only reads, and writes
   `S3_BUCKET` / `CLOUDFRONT_URL` back into `.env`. Distribution takes
   ~5–10 min to deploy.
3. Upload via the upload interface, or manually:
   `node scripts/upload-s3.mjs ./out/lesson1 hls/lesson1`.

> A single progressive MP4 is the classic cheap setup, but it can't adapt quality
> to the viewer's connection. For a fair fight against the others, the pipeline
> uploads the same HLS ladder it builds for R2.

### 4. R2 + self-managed HLS (zero egress)

1. Install ffmpeg: `winget install Gyan.FFmpeg` (reopen the terminal after).
2. Cloudflare dashboard → **R2** → create bucket (e.g. `ai-lms-videos`).
3. Bucket → Settings → **Public access**: enable the `r2.dev` subdomain
   (or connect a custom domain — recommended for production, enables Cloudflare CDN caching).
4. R2 → **Manage R2 API Tokens** → create token (Object Read & Write); fill the
   `R2_*` variables in `.env` (`R2_PUBLIC_URL` is the `pub-….r2.dev` or custom domain URL).
5. Encode: `node scripts/encode-hls.mjs lesson1.mp4 ./out/lesson1`
   (builds a 1080p/720p/480p/360p ladder, skipping rungs above the source resolution).
6. Upload: `node scripts/upload-r2.mjs ./out/lesson1 hls/lesson1 --cors`
   (`--cors` is needed once per bucket so browsers can fetch the segments)
   → sets `R2_VIDEO_PREFIX=hls/lesson1`.

### 5. YouTube benchmark (no credentials)

Upload the same lesson to YouTube as **unlisted** and set `YOUTUBE_VIDEO_ID`
(the part after `v=` in the URL). Until then it plays a public demo video.
This one isn't a candidate for a paid course — it's the free baseline your
chosen option should get close to on startup time and quality.

## What to compare on your devices

- **Startup time** on wifi vs 4G (use the Reload & re-measure button).
- **Rebuffers / quality switches** while throttling the connection
  (Chrome DevTools → Network → Slow 4G is an easy simulator).
- **iPhone Safari** — it uses native HLS (no hls.js), which is the strictest
  compatibility test, especially for the self-encoded R2 ladder.
- **Seek behavior** — jump around the timeline; HLS seeks by segment (4 s here),
  progressive MP4 depends on byte-range support.
- Official Stream/MUX players (toggle button) for their UX: quality menu,
  playback speed, captions, etc.

## Notes for the real LMS build

- This PoC serves **public/unsigned** URLs — fine for testing, not for a paid
  course. All four options support locking down access later:
  Stream = signed tokens, MUX = signed playback policies,
  CloudFront = signed URLs/cookies, R2 = presigned URLs or a Worker in front.
- R2's zero egress makes it the cheapest at scale by a wide margin, but you own
  encoding, packaging bugs, and player edge cases — this PoC is exactly the test
  of whether that trade-off is acceptable.
- DRM (Widevine/FairPlay) is only offered by the managed options (Stream/MUX);
  signed HLS URLs deter casual sharing but not determined downloaders.
