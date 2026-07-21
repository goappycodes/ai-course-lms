// Vercel serverless entry: every /api/* request is rewritten here
// (see vercel.json) and handled by the same Express app used locally.
// The app is imported lazily so a boot failure produces a readable
// error response instead of an opaque FUNCTION_INVOCATION_FAILED.
let appPromise = null;

export default async function handler(req, res) {
  try {
    if (!appPromise) appPromise = import("../app.js");
    const { default: app } = await appPromise;
    return app(req, res);
  } catch (err) {
    appPromise = null;
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(`app boot failed: ${err.stack || err.message}`);
  }
}
