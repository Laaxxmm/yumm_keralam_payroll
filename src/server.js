import "dotenv/config";
import { createApp } from "./app.js";
import { openDb, getDb } from "./db.js";
import { loadKey } from "./crypto.js";
import { createUser } from "./auth.js";

/**
 * First-run admin bootstrap.
 *
 * On a fresh deploy the database has no users, so nobody can log in and the
 * login screen (deliberately) has no self-registration. Setting
 * BOOTSTRAP_ADMIN_USER + BOOTSTRAP_ADMIN_PASSWORD creates the first admin on
 * startup — but ONLY when there are zero users, so it can never overwrite an
 * existing account or re-run. Remove the two vars after the first login.
 */
async function bootstrapAdmin() {
  const user = process.env.BOOTSTRAP_ADMIN_USER;
  const pass = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!user || !pass) return;
  const count = getDb().prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (count > 0) {
    console.log("[bootstrap] users already exist — skipping (safe to remove BOOTSTRAP_ADMIN_* now).");
    return;
  }
  try {
    await createUser({ username: user, password: pass, role: "admin" });
    console.log(`[bootstrap] created admin "${user}". Remove BOOTSTRAP_ADMIN_* env vars now.`);
  } catch (e) {
    console.error("[bootstrap] could not create admin:", e.message);
  }
}

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
await bootstrapAdmin();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0"; // bind all interfaces so the cloud proxy can reach us
createApp().listen(port, host, () => {
  console.log(`Yumm HR server listening on ${host}:${port} (NODE_ENV=${process.env.NODE_ENV || "development"})`);
});

// Graceful shutdown so SQLite's WAL is checkpointed cleanly on redeploy.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { console.log(`\n${sig} received, shutting down.`); process.exit(0); });
}
