import "dotenv/config";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { loadKey } from "./crypto.js";

// Fail fast and loudly rather than starting up in an insecure state.
try {
  loadKey();
} catch (e) {
  console.error("\n[FATAL] " + e.message + "\n");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && !process.env.TRUST_PROXY_OK) {
  // A reminder, not a blocker: secure cookies require HTTPS termination.
  console.warn("[warn] NODE_ENV=production — ensure the app sits behind HTTPS.");
}

openDb();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0"; // bind all interfaces so the cloud proxy can reach us
createApp().listen(port, host, () => {
  console.log(`Yumm HR server listening on ${host}:${port} (NODE_ENV=${process.env.NODE_ENV || "development"})`);
});

// Graceful shutdown so SQLite's WAL is checkpointed cleanly on redeploy.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { console.log(`\n${sig} received, shutting down.`); process.exit(0); });
}
