// Vercel serverless entry: every /api/* request is rewritten here
// (see vercel.json) and handled by the same Express app used locally.
import app from "../app.js";

export default app;
