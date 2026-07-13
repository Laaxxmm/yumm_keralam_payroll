import { Router } from "express";
import { z } from "zod";
import { getDb, audit } from "../db.js";
import { requireRole } from "../auth.js";
import { advBalance, advPaid } from "../services/payroll.js";

const router = Router();

const AdvanceSchema = z.object({
  empId: z.coerce.number().int().positive(),
  date: z.string().trim().max(20).default(""),
  amount: z.coerce.number().int().positive().max(100_000_000),
  reason: z.string().trim().max(200).default(""),
  installment: z.coerce.number().int().min(0).max(100_000_000).default(0),
});

const PaymentSchema = z.object({
  date: z.string().trim().max(20).default(""),
  amount: z.coerce.number().int().positive().max(100_000_000),
  note: z.string().trim().max(200).default(""),
});

function advToApi(a) {
  const paid = advPaid(a.id);
  const balance = Math.max(0, a.amount - paid);
  return {
    id: a.id, empId: a.emp_id, date: a.date, amount: a.amount, reason: a.reason,
    installment: a.installment, recovered: paid, balance, open: balance > 0,
  };
}

router.get("/", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM advances ORDER BY id DESC").all();
  res.json({ advances: rows.map(advToApi) });
});

router.get("/:id/ledger", (req, res) => {
  const a = getDb().prepare("SELECT * FROM advances WHERE id = ?").get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: "Advance not found." });
  const payments = getDb()
    .prepare("SELECT id, date, amount, note, kind, mk FROM advance_payments WHERE advance_id=? ORDER BY id")
    .all(a.id);
  res.json({ advance: advToApi(a), payments });
});

router.post("/", requireRole("admin", "hr"), (req, res) => {
  const parsed = AdvanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const a = parsed.data;
  if (!getDb().prepare("SELECT id FROM employees WHERE id=?").get(a.empId))
    return res.status(400).json({ error: "Employee not found." });
  const info = getDb()
    .prepare("INSERT INTO advances (emp_id,date,amount,reason,installment) VALUES (?,?,?,?,?)")
    .run(a.empId, a.date, a.amount, a.reason, a.installment);
  audit(req, "advance.create", "advance", info.lastInsertRowid, `emp ${a.empId} amt ${a.amount}`);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

router.put("/:id", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id);
  if (!getDb().prepare("SELECT id FROM advances WHERE id=?").get(id))
    return res.status(404).json({ error: "Advance not found." });
  const parsed = AdvanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const a = parsed.data;
  getDb().prepare("UPDATE advances SET emp_id=?,date=?,amount=?,reason=?,installment=? WHERE id=?")
    .run(a.empId, a.date, a.amount, a.reason, a.installment, id);
  audit(req, "advance.update", "advance", id);
  res.json({ ok: true });
});

router.delete("/:id", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id);
  const row = getDb().prepare("SELECT id, emp_id FROM advances WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "Advance not found." });
  const db = getDb();
  // Any month this advance auto-posted a recovery in must have its "posted" flag
  // cleared — otherwise, once the advance (and its auto-payments) are gone,
  // payroll keeps thinking the month is recovered and won't recover new advances.
  const months = db.prepare(
    "SELECT DISTINCT mk FROM advance_payments WHERE advance_id=? AND kind='auto' AND mk IS NOT NULL"
  ).all(id);
  db.exec("BEGIN");
  try {
    for (const m of months) {
      db.prepare(
        `INSERT INTO payroll_adjust (mk, emp_id, adv, adv_posted) VALUES (?,?,NULL,0)
         ON CONFLICT(mk, emp_id) DO UPDATE SET adv=NULL, adv_posted=0`
      ).run(m.mk, row.emp_id);
    }
    db.prepare("DELETE FROM advances WHERE id=?").run(id); // cascades payments
    // If this was the employee's last advance, any leftover recovery override is
    // meaningless — clear it so a future advance isn't silently blocked by a
    // stale value (e.g. a 0 left behind by a deleted recovery). wd/bonus/ded are
    // left untouched.
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM advances WHERE emp_id=?").get(row.emp_id).n;
    if (remaining === 0) {
      db.prepare("UPDATE payroll_adjust SET adv=NULL, adv_posted=0 WHERE emp_id=?").run(row.emp_id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  audit(req, "advance.delete", "advance", id);
  res.json({ ok: true });
});

router.post("/:id/payments", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id);
  if (!getDb().prepare("SELECT id FROM advances WHERE id=?").get(id))
    return res.status(404).json({ error: "Advance not found." });
  const parsed = PaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const p = parsed.data;
  getDb().prepare("INSERT INTO advance_payments (advance_id,date,amount,note,kind) VALUES (?,?,?,?, 'manual')")
    .run(id, p.date, p.amount, p.note);
  audit(req, "advance.repayment", "advance", id, `manual ${p.amount}`);
  res.status(201).json({ ok: true, balance: advBalance(id) });
});

router.delete("/:id/payments/:payId", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id), payId = Number(req.params.payId);
  const p = getDb().prepare("SELECT * FROM advance_payments WHERE id=? AND advance_id=?").get(payId, id);
  if (!p) return res.status(404).json({ error: "Payment not found." });
  getDb().prepare("DELETE FROM advance_payments WHERE id=?").run(payId);
  // If it was an auto salary recovery, un-post that month so payroll stays in sync.
  if (p.kind === "auto" && p.mk) {
    getDb().prepare(
      `INSERT INTO payroll_adjust (mk, emp_id, adv, adv_posted)
         SELECT ?, emp_id, NULL, 0 FROM advances WHERE id=?
       ON CONFLICT(mk, emp_id) DO UPDATE SET adv=NULL, adv_posted=0`
    ).run(p.mk, id);
  }
  audit(req, "advance.payment_delete", "advance", id, `payment ${payId}`);
  res.json({ ok: true, balance: advBalance(id) });
});

export default router;
