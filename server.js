// Local dev server entry — `npm start`. On Vercel, api/index.js serves the
// same app as a serverless function instead.
import os from "node:os";
import app from "./app.js";

const PORT = process.env.PORT || 3000;

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
