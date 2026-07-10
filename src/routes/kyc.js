/**
 * KYC document upload/download.
 *
 * Threat model for file uploads:
 *  - A user uploads "aadhaar.pdf" that is really HTML with a <script> in it.
 *    Serving it back inline would run that script on our origin (stored XSS).
 *  - A user uploads a 2 GB file to exhaust the disk.
 *  - A user crafts a filename like "../../etc/passwd" to escape the data dir.
 *  - Anyone who steals the disk reads everyone's Aadhaar and PAN.
 *
 * Mitigations, in order: MIME allow-list checked against the file's real magic
 * bytes (not the browser's claim); a hard size cap; server-generated random
 * filenames (the original name is only ever a DB string); AES-256-GCM at rest;
 * and downloads forced to Content-Disposition: attachment with a neutered
 * Content-Type plus a sandboxing CSP.
 */
import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb, audit } from "../db.js";
import { requireRole } from "../auth.js";
import { encryptBuffer, decryptBuffer } from "../crypto.js";

const router = Router();
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const KYC_DIR = process.env.KYC_DIR || "./data/kyc";

const DOC_TYPES = new Set([
  "PAN Card", "Aadhaar Card", "Voter ID", "Driving License", "Passport",
  "Bank Passbook / Cheque", "Photo", "Appointment Letter", "Other",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

/** Verify the bytes really are what the extension/MIME claims. */
function sniffMime(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString("hex") === "25504446") return "application/pdf"; // %PDF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  return null; // unknown → reject
}

router.get("/:empId", (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT id, doc_type, file_name, mime, size, uploaded_at FROM kyc_files WHERE emp_id = ? ORDER BY id"
    )
    .all(Number(req.params.empId));
  res.json({ files: rows });
});

router.get("/counts/all", (_req, res) => {
  const rows = getDb().prepare("SELECT emp_id, COUNT(*) AS n FROM kyc_files GROUP BY emp_id").all();
  res.json({ counts: Object.fromEntries(rows.map((r) => [r.emp_id, r.n])) });
});

router.post("/:empId", requireRole("admin", "hr"), upload.single("file"), (req, res) => {
  const empId = Number(req.params.empId);
  const emp = getDb().prepare("SELECT id FROM employees WHERE id = ?").get(empId);
  if (!emp) return res.status(404).json({ error: "Employee not found." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const docType = String(req.body?.docType ?? "");
  if (!DOC_TYPES.has(docType)) return res.status(400).json({ error: "Invalid document type." });

  // Trust the bytes, not the browser.
  const realMime = sniffMime(req.file.buffer);
  if (!realMime)
    return res.status(400).json({ error: "Only PDF, JPEG, PNG or WebP files are allowed." });

  const sha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

  // Server-generated name: user input never touches the filesystem path.
  fs.mkdirSync(KYC_DIR, { recursive: true });
  const storedName = crypto.randomBytes(16).toString("hex") + ".enc";
  const fullPath = path.join(KYC_DIR, storedName);
  fs.writeFileSync(fullPath, encryptBuffer(req.file.buffer), { mode: 0o600 });

  // The original filename is stored only as data, and stripped of any path parts.
  const safeName = path.basename(String(req.file.originalname || "document")).slice(0, 120);

  const info = getDb()
    .prepare(
      `INSERT INTO kyc_files (emp_id, doc_type, file_name, mime, size, storage_path, sha256, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(empId, docType, safeName, realMime, req.file.size, storedName, sha256, req.user.id);

  audit(req, "kyc.upload", "employee", empId, `${docType} (${realMime}, ${req.file.size}B)`);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

router.get("/file/:id", (req, res) => {
  const row = getDb().prepare("SELECT * FROM kyc_files WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "File not found." });

  let plain;
  try {
    plain = decryptBuffer(fs.readFileSync(path.join(KYC_DIR, row.storage_path)));
  } catch {
    audit(req, "kyc.decrypt_failed", "kyc", row.id);
    return res.status(500).json({ error: "File could not be read." });
  }

  // Integrity: if the ciphertext were swapped wholesale, the hash won't match.
  if (crypto.createHash("sha256").update(plain).digest("hex") !== row.sha256) {
    audit(req, "kyc.integrity_failure", "kyc", row.id);
    return res.status(500).json({ error: "File integrity check failed." });
  }

  // Reading someone's Aadhaar is itself an auditable event.
  audit(req, "kyc.download", "employee", row.emp_id, `${row.doc_type} #${row.id}`);

  res.setHeader("Content-Type", row.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");        // no MIME sniffing
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", `attachment; filename="${row.file_name.replace(/"/g, "")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(plain);
});

router.delete("/file/:id", requireRole("admin", "hr"), (req, res) => {
  const row = getDb().prepare("SELECT * FROM kyc_files WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "File not found." });
  try { fs.unlinkSync(path.join(KYC_DIR, row.storage_path)); } catch { /* already gone */ }
  getDb().prepare("DELETE FROM kyc_files WHERE id = ?").run(row.id);
  audit(req, "kyc.delete", "employee", row.emp_id, `${row.doc_type} #${row.id}`);
  res.json({ ok: true });
});

// multer surfaces size violations as an error class, not a normal response.
router.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "File is larger than 8 MB." : "Upload rejected.";
    return res.status(400).json({ error: msg });
  }
  next(err);
});

export default router;
