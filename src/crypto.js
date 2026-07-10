/**
 * Cryptographic primitives.
 *
 * Sensitive fields (bank account numbers, KYC file bytes) are encrypted at rest
 * with AES-256-GCM. GCM gives us confidentiality AND integrity: if a stored
 * ciphertext is tampered with, decryption throws instead of returning garbage.
 *
 * The key never lives in the database or the repo — only in APP_ENC_KEY.
 * Losing that key means the encrypted data is unrecoverable, by design.
 */
import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce, the GCM standard
const KEY_LEN = 32; // 256-bit

let _key = null;

/** Load and validate the master key. Called once at boot so we fail fast. */
export function loadKey(raw = process.env.APP_ENC_KEY) {
  if (!raw) {
    throw new Error(
      "APP_ENC_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(`APP_ENC_KEY must decode to exactly ${KEY_LEN} bytes (got ${key.length}).`);
  }
  _key = key;
  return key;
}

function key() {
  if (!_key) loadKey();
  return _key;
}

/**
 * Encrypt a Buffer. Returns a single self-describing Buffer:
 *   [ 12-byte IV ][ 16-byte auth tag ][ ciphertext ]
 * Storing them together means we can never mismatch an IV with its ciphertext.
 */
export function encryptBuffer(plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** Reverse of encryptBuffer. Throws if the data was tampered with. */
export function decryptBuffer(blob) {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + 16);
  const ct = blob.subarray(IV_LEN + 16);
  const decipher = crypto.createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypt a short string (e.g. bank account no.) to base64 for a TEXT column. */
export function encryptField(str) {
  if (str === null || str === undefined || str === "") return null;
  return encryptBuffer(Buffer.from(String(str), "utf8")).toString("base64");
}

/** Decrypt a field written by encryptField. Returns "" on any failure. */
export function decryptField(b64) {
  if (!b64) return "";
  try {
    return decryptBuffer(Buffer.from(b64, "base64")).toString("utf8");
  } catch {
    return ""; // tampered or key rotated — never leak raw ciphertext to callers
  }
}

/** Opaque session token for the cookie. */
export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * We store only the SHA-256 of the session token. A stolen database therefore
 * does not yield usable session cookies. (Tokens are already high-entropy, so a
 * fast hash is correct here — unlike passwords, which use bcrypt.)
 */
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare, to avoid leaking secrets through timing. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
