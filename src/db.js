/**
 * SQLite via Node's built-in driver (no native build step).
 *
 * The whole database is one file, which makes backups trivial: copy it.
 * For a multi-instance cloud deploy, swap this module for Postgres — every
 * query lives here and in the route files, nowhere else.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

let db;

export function openDb(file = process.env.DB_FILE || "./data/yumm-hr.db") {
  if (db) return db;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");   // survives crashes mid-write
  db.exec("PRAGMA foreign_keys = ON");    // enforce referential integrity
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function getDb() {
  if (!db) openDb();
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash     TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin','hr','viewer')),
      failed_count  INTEGER NOT NULL DEFAULT 0,
      locked_until  INTEGER,
      must_change   INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login    TEXT
    );

    -- Only the SHA-256 of the cookie value is kept, so a DB leak yields no live sessions.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      ip          TEXT,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS employees (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      desig        TEXT NOT NULL DEFAULT '',
      loc          TEXT NOT NULL DEFAULT '',
      joining      TEXT NOT NULL DEFAULT '',
      salary       INTEGER NOT NULL DEFAULT 0 CHECK (salary >= 0),
      phone        TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
      father_name  TEXT NOT NULL DEFAULT '',
      dob          TEXT NOT NULL DEFAULT '',
      address      TEXT NOT NULL DEFAULT '',
      qual_gen     TEXT NOT NULL DEFAULT '',
      qual_tech    TEXT NOT NULL DEFAULT '',
      experience   TEXT NOT NULL DEFAULT '',
      lang_read    TEXT NOT NULL DEFAULT '',
      lang_write   TEXT NOT NULL DEFAULT '',
      lang_speak   TEXT NOT NULL DEFAULT '',
      report_time  TEXT NOT NULL DEFAULT '',
      hobbies      TEXT NOT NULL DEFAULT '',
      documents    TEXT NOT NULL DEFAULT '',
      bank_name    TEXT NOT NULL DEFAULT '',
      acc_name     TEXT NOT NULL DEFAULT '',
      acc_no_enc   TEXT,               -- AES-256-GCM, never plaintext
      ifsc         TEXT NOT NULL DEFAULT '',
      branch       TEXT NOT NULL DEFAULT '',
      upi          TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_emp_status ON employees(status);
    CREATE INDEX IF NOT EXISTS idx_emp_loc ON employees(loc);

    CREATE TABLE IF NOT EXISTS company (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      name        TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      contact     TEXT NOT NULL DEFAULT '',
      mobile      TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL DEFAULT '',
      addr1       TEXT NOT NULL DEFAULT '',
      addr2       TEXT NOT NULL DEFAULT '',
      city        TEXT NOT NULL DEFAULT '',
      state       TEXT NOT NULL DEFAULT '',
      pincode     TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT '',
      gstin       TEXT NOT NULL DEFAULT '',
      pan         TEXT NOT NULL DEFAULT '',
      uid         TEXT NOT NULL DEFAULT '',
      tagline     TEXT NOT NULL DEFAULT '',
      logo_b64    TEXT
    );

    CREATE TABLE IF NOT EXISTS advances (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date        TEXT NOT NULL DEFAULT '',
      amount      INTEGER NOT NULL CHECK (amount > 0),
      reason      TEXT NOT NULL DEFAULT '',
      installment INTEGER NOT NULL DEFAULT 0 CHECK (installment >= 0),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_adv_emp ON advances(emp_id);

    CREATE TABLE IF NOT EXISTS advance_payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      advance_id  INTEGER NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
      date        TEXT NOT NULL DEFAULT '',
      amount      INTEGER NOT NULL CHECK (amount > 0),
      note        TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL CHECK (kind IN ('auto','manual')),
      mk          TEXT,                 -- payroll month key, for auto recoveries
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_advpay_adv ON advance_payments(advance_id);

    CREATE TABLE IF NOT EXISTS payroll_adjust (
      mk          TEXT NOT NULL,
      emp_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      wd          INTEGER,
      bonus       INTEGER NOT NULL DEFAULT 0 CHECK (bonus >= 0),
      ded         INTEGER NOT NULL DEFAULT 0 CHECK (ded >= 0),
      adv         INTEGER,
      adv_posted  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mk, emp_id)
    );

    -- File bytes are AES-GCM encrypted on disk; this row holds only metadata.
    CREATE TABLE IF NOT EXISTS kyc_files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      doc_type     TEXT NOT NULL,
      file_name    TEXT NOT NULL,
      mime         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      sha256       TEXT NOT NULL,
      uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
      uploaded_by  INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_emp ON kyc_files(emp_id);

    -- Append-only trail. Every mutation and every KYC read is recorded.
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL DEFAULT (datetime('now')),
      user_id   INTEGER,
      username  TEXT,
      action    TEXT NOT NULL,
      entity    TEXT,
      entity_id TEXT,
      detail    TEXT,
      ip        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  `);

  // Company is a singleton row.
  d.exec("INSERT OR IGNORE INTO company (id) VALUES (1)");
}

/** Write an audit entry. Never throws — auditing must not break a request. */
export function audit(req, action, entity, entityId, detail) {
  try {
    getDb()
      .prepare(
        `INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail, ip)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        req?.user?.id ?? null,
        req?.user?.username ?? null,
        action,
        entity ?? null,
        entityId != null ? String(entityId) : null,
        detail ? String(detail).slice(0, 500) : null,
        req?.ip ?? null
      );
  } catch (e) {
    console.error("audit failed:", e.message);
  }
}
