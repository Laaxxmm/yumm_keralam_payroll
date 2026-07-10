/**
 * Server-side authentication.
 *
 * The browser only ever holds an opaque random token in an httpOnly cookie.
 * It cannot read it from JavaScript, cannot forge it, and cannot elevate its
 * own role — every check happens here, on the server.
 */
import bcrypt from "bcryptjs";
import { getDb, audit } from "./db.js";
import { newToken, hashToken } from "./crypto.js";

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const REMEMBER_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_FAILED = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
export const COOKIE_NAME = "yhr_session";

export const MIN_PASSWORD = 10;

/** Reject the passwords that actually get breached, not just short ones. */
export function validatePassword(pw, username = "") {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD)
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return "Password is too long.";
  if (username && pw.toLowerCase().includes(String(username).toLowerCase()))
    return "Password must not contain your username.";
  const common = ["password", "12345678", "qwerty", "admin123", "letmein", "welcome", "iloveyou"];
  if (common.some((c) => pw.toLowerCase().includes(c)))
    return "Password is too common. Choose something less guessable.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw))
    return "Password must contain both letters and numbers.";
  return null;
}

export async function hashPassword(pw) {
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}

export async function createUser({ username, password, role = "hr", mustChange = 0 }) {
  const err = validatePassword(password, username);
  if (err) throw new Error(err);
  const hash = await hashPassword(password);
  const info = getDb()
    .prepare("INSERT INTO users (username, pass_hash, role, must_change) VALUES (?,?,?,?)")
    .run(String(username).trim(), hash, role, mustChange ? 1 : 0);
  return Number(info.lastInsertRowid);
}

function findUser(username) {
  return getDb().prepare("SELECT * FROM users WHERE username = ?").get(String(username).trim());
}

/**
 * Verify credentials.
 *
 * On an unknown username we still run a bcrypt comparison against a dummy hash.
 * Without that, a wrong username returns noticeably faster than a wrong
 * password, which lets an attacker enumerate valid usernames by timing.
 */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.9Zt6a6a3n8sQ5s7yq3.Qy0OQ0K6q3iy";

export async function verifyLogin(username, password, ip) {
  const user = findUser(username);
  const now = Date.now();

  if (user?.locked_until && user.locked_until > now) {
    const mins = Math.ceil((user.locked_until - now) / 60000);
    return { ok: false, error: `Account locked. Try again in ${mins} minute(s).` };
  }

  const ok = await bcrypt.compare(String(password ?? ""), user?.pass_hash ?? DUMMY_HASH);

  if (!user || !ok) {
    if (user) {
      const failed = user.failed_count + 1;
      const lockUntil = failed >= MAX_FAILED ? now + LOCKOUT_MS : null;
      getDb()
        .prepare("UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?")
        .run(failed, lockUntil, user.id);
      if (lockUntil) {
        audit({ ip }, "auth.lockout", "user", user.id, `after ${failed} failed attempts`);
        return { ok: false, error: "Too many failed attempts. Account locked for 15 minutes." };
      }
    }
    // Identical message either way — never reveal whether the username exists.
    return { ok: false, error: "Invalid username or password." };
  }

  getDb()
    .prepare("UPDATE users SET failed_count = 0, locked_until = NULL, last_login = datetime('now') WHERE id = ?")
    .run(user.id);
  return { ok: true, user };
}

export function createSession(userId, { remember = false, ip, userAgent } = {}) {
  const token = newToken();
  const now = Date.now();
  const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
  getDb()
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)"
    )
    .run(hashToken(token), userId, now, now + ttl, ip ?? null, String(userAgent ?? "").slice(0, 300));
  return { token, maxAge: ttl };
}

export function destroySession(token) {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function destroyAllSessionsFor(userId) {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function purgeExpiredSessions() {
  getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

function sessionUser(token) {
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT u.id, u.username, u.role, u.must_change, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(token);
    return null;
  }
  return { id: row.id, username: row.username, role: row.role, mustChange: !!row.must_change };
}

/** Populates req.user when a valid session cookie is present. Never rejects. */
export function attachUser(req, _res, next) {
  req.user = sessionUser(req.cookies?.[COOKIE_NAME]) || null;
  next();
}

/** Gate: a valid session is required. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  next();
}

/** Gate: the user's role must be in `roles`. Checked server-side, always. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required." });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: "You do not have permission to do that." });
    next();
  };
}

export const cookieOptions = (maxAge) => ({
  httpOnly: true,                                  // unreadable from JavaScript → XSS can't steal it
  secure: process.env.NODE_ENV === "production",   // HTTPS only in prod
  sameSite: "strict",                              // blocks cross-site CSRF
  path: "/",
  maxAge,
});
