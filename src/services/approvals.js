/**
 * Maker–checker queue.
 *
 * A sensitive action performed by an 'hr' user (the maker) is not applied
 * immediately: the validated request is stored here, encrypted, until an admin
 * (the checker) approves or rejects it. The payload is AES-GCM encrypted
 * because it can contain bank account numbers; the human-readable summary and
 * detail columns must therefore never include a full account number.
 */
import { getDb, audit } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";

/** Mask an account number for display: keep the last 4 digits only. */
export const maskAcc = (s) => (s ? "****" + String(s).slice(-4) : "—");

/** Queue an action for admin approval. Returns the approval id. */
export function queueApproval(req, action, entityId, summary, detail, payload) {
  const info = getDb()
    .prepare(
      `INSERT INTO approvals (action, entity_id, summary, detail, payload_enc, requested_by, requested_by_name)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      action,
      entityId != null ? String(entityId) : null,
      String(summary).slice(0, 300),
      String(detail).slice(0, 2000),
      encryptField(JSON.stringify(payload)),
      req.user.id,
      req.user.username
    );
  const id = Number(info.lastInsertRowid);
  audit(req, "approval.requested", "approval", id, `${action} — ${String(summary).slice(0, 120)}`);
  return id;
}

export function getApproval(id) {
  const row = getDb().prepare("SELECT * FROM approvals WHERE id = ?").get(Number(id));
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(decryptField(row.payload_enc)); } catch { /* unreadable */ }
  return { ...row, payload };
}

export function listApprovals() {
  const db = getDb();
  const pending = db.prepare(
    "SELECT id, action, entity_id, summary, detail, requested_by_name, requested_at, status FROM approvals WHERE status='pending' ORDER BY id"
  ).all();
  const decided = db.prepare(
    "SELECT id, action, entity_id, summary, requested_by_name, requested_at, status, decided_by, decided_at, note FROM approvals WHERE status != 'pending' ORDER BY id DESC LIMIT 20"
  ).all();
  return { pending, decided };
}

export function markDecided(id, status, req, note = "") {
  getDb()
    .prepare("UPDATE approvals SET status=?, decided_by=?, decided_at=datetime('now'), note=? WHERE id=?")
    .run(status, req.user.username, String(note).slice(0, 300), Number(id));
}
