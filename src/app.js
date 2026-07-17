import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { getDb, audit } from "./db.js";
import {
  attachUser, requireAuth, requireRole, verifyLogin, createSession,
  destroySession, destroyAllSessionsFor, purgeExpiredSessions,
  cookieOptions, COOKIE_NAME, validatePassword, hashPassword,
} from "./auth.js";
import employeesRouter from "./routes/employees.js";
import kycRouter from "./routes/kyc.js";
import companyRouter from "./routes/company.js";
import advancesRouter from "./routes/advances.js";
import payrollRouter from "./routes/payroll.js";
import usersRouter from "./routes/users.js";
import adminRouter from "./routes/admin.js";
import approvalsRouter from "./routes/approvals.js";
import { requireRole as _rr } from "./auth.js";
import bcrypt from "bcryptjs";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // behind the cloud provider's TLS terminator
  app.disable("x-powered-by");

  // Content-Security-Policy: no inline scripts, no external origins. Even if an
  // attacker injects markup, the browser refuses to execute it.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // inline styles only, never scripts
          imgSrc: ["'self'", "data:", "blob:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],              // clickjacking
          formAction: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'"],
        },
      },
      hsts: process.env.NODE_ENV === "production"
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: "no-referrer" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
    })
  );
  app.use(express.json({ limit: "2mb" })); // headroom for the one-shot legacy import
  app.use(cookieParser());
  app.use(attachUser);

  /**
   * CSRF defence, layer 2 (SameSite=strict on the cookie is layer 1).
   * A cross-site <form> POST cannot set a custom header, and browsers only send
   * an Origin the attacker can't spoof. Anything mutating must satisfy both.
   */
  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("Origin");
    if (origin) {
      const host = req.get("Host");
      let originHost;
      try { originHost = new URL(origin).host; } catch { originHost = null; }
      if (originHost !== host) {
        audit(req, "security.csrf_blocked", null, null, `origin=${origin}`);
        return res.status(403).json({ error: "Cross-origin request blocked." });
      }
    }
    if (req.get("X-Requested-With") !== "XMLHttpRequest")
      return res.status(403).json({ error: "Missing X-Requested-With header." });
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_MAX || 10), // per IP, on top of per-account lockout
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { error: "Too many login attempts. Please try again later." },
  });
  app.use("/api/", rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_MAX || 300),
    validate: { trustProxy: false },
  }));

  /* ------------------------------- auth ------------------------------- */

  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const { username, password, remember } = req.body ?? {};
    if (!username || !password)
      return res.status(400).json({ error: "Username and password are required." });

    const result = await verifyLogin(username, password, req.ip);
    if (!result.ok) {
      audit(req, "auth.login_failed", "user", null, `username=${String(username).slice(0, 40)}`);
      return res.status(401).json({ error: result.error });
    }
    const { token, maxAge } = createSession(result.user.id, {
      remember: !!remember, ip: req.ip, userAgent: req.get("User-Agent"),
    });
    res.cookie(COOKIE_NAME, token, cookieOptions(maxAge));
    audit({ ...req, user: result.user }, "auth.login", "user", result.user.id);
    res.json({
      user: { username: result.user.username, role: result.user.role, mustChange: !!result.user.must_change },
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    destroySession(req.cookies?.[COOKIE_NAME]);
    if (req.user) audit(req, "auth.logout", "user", req.user.id);
    res.clearCookie(COOKIE_NAME, cookieOptions(0));
    res.json({ ok: true });
  });

  app.get("/api/auth/me", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not signed in." });
    res.json({ user: req.user });
  });

  app.post("/api/auth/change-password", requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const row = getDb().prepare("SELECT pass_hash FROM users WHERE id = ?").get(req.user.id);
    if (!(await bcrypt.compare(String(currentPassword ?? ""), row.pass_hash)))
      return res.status(400).json({ error: "Current password is incorrect." });

    const err = validatePassword(newPassword, req.user.username);
    if (err) return res.status(400).json({ error: err });

    getDb()
      .prepare("UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?")
      .run(await hashPassword(newPassword), req.user.id);

    // Changing a password invalidates every other session for that user.
    destroyAllSessionsFor(req.user.id);
    audit(req, "auth.password_changed", "user", req.user.id);
    res.clearCookie(COOKIE_NAME, cookieOptions(0));
    res.json({ ok: true, message: "Password updated. Please sign in again." });
  });

  /* ------------------------------ domain ------------------------------ */

  app.use("/api/employees", requireAuth, employeesRouter);
  app.use("/api/kyc", requireAuth, kycRouter);
  app.use("/api/company", requireAuth, companyRouter);
  app.use("/api/advances", requireAuth, advancesRouter);
  app.use("/api/payroll", requireAuth, payrollRouter);
  app.use("/api/users", requireAuth, _rr("admin"), usersRouter);
  app.use("/api/admin", requireAuth, _rr("admin"), adminRouter);
  app.use("/api/approvals", requireAuth, _rr("admin"), approvalsRouter);

  app.get("/api/audit", requireRole("admin"), (req, res) => {
    const rows = getDb()
      .prepare("SELECT ts, username, action, entity, entity_id, detail, ip FROM audit_log ORDER BY id DESC LIMIT 500")
      .all();
    res.json({ entries: rows });
  });

  // BUILD is bumped on each deploy so we can confirm a release actually went
  // live (the health check alone can't tell old code from new during Railway's
  // zero-downtime swap).
  app.get("/api/health", (_req, res) => res.json({ ok: true, build: "2026-07-14-history-leaving-maker-checker" }));

  /* ------------------------------ static ------------------------------ */
  // Served with no PII baked in — the client fetches everything over the API.
  // maxAge:0 + ETag means the browser revalidates every load (cheap 304s), so a
  // redeploy of index.html/app.js/styles.css reaches users on their next normal
  // refresh instead of being stuck behind a stale cache for up to an hour.
  app.use(express.static("public", { maxAge: 0, etag: true, index: "index.html" }));

  // Central error handler: never leak stack traces or SQL to the client.
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    audit(req, "error", null, null, err.message);
    res.status(status).json({ error: status >= 500 ? "Internal server error." : err.message });
  });

  setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();
  return app;
}
