/** Admin-only maintenance endpoints. */
import { Router } from "express";
import { getDb, audit } from "../db.js";
import { importLegacy } from "../services/import.js";

const router = Router();

/**
 * Import a legacy backup JSON straight from the admin's browser. This is how the
 * old data reaches a cloud deployment WITHOUT ever putting employee PII in the
 * git repo. `replace: true` wipes existing employees/advances/KYC first.
 */
router.post("/import-legacy", (req, res) => {
  const data = req.body?.backup ?? req.body;
  const replace = !!req.body?.replace;
  try {
    const result = importLegacy(getDb(), data, { replace });
    audit(req, "admin.import_legacy", null, null, `${result.employees} employees, replace=${replace}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Lightweight counts so the admin UI can show what's in the database. */
router.get("/stats", (_req, res) => {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get().n;
  res.json({
    employees: one("SELECT COUNT(*) n FROM employees"),
    advances: one("SELECT COUNT(*) n FROM advances"),
    kyc: one("SELECT COUNT(*) n FROM kyc_files"),
    users: one("SELECT COUNT(*) n FROM users"),
  });
});

export default router;
