import { Router } from "express";
import { z } from "zod";
import { getDb, audit } from "../db.js";
import { requireRole } from "../auth.js";
import { advBalance, advPaid } from "../services/payroll.js";
import { queueApproval } from "../services/approvals.js";

const router = Router();

// Maker–checker: money-moving changes made by 'hr' wait for an admin.
const isMaker = (req) => req.user.role === "hr";
const queued = (res, aid) => res.status(202).json({ queued: true, approvalId: aid });
const empName = (id) => getDb().prepare("SELECT name FROM employees WHERE id=?").get(id)?.name || `employee #${id}`;

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

/* ------------------------- apply (perform) functions ------------------------
   Called directly for admins, and replayed when an admin approves a maker's
   queued request. Each throws Error with .status on failure. */

export function applyAdvCreate(a, req) {
  const info = getDb()
    .prepare("INSERT INTO advances (emp_id,date,amount,reason,installment) VALUES (?,?,?,?,?)")
    .run(a.empId, a.date, a.amount, a.reason, a.installment);
  audit(req, "advance.create", "advance", info.lastInsertRowid, `emp ${a.empId} amt ${a.amount}`);
  return Number(info.lastInsertRowid);
}

export function applyAdvUpdate(id, a, req) {
  const info = getDb()
    .prepare("UPDATE advances SET emp_id=?,date=?,amount=?,reason=?,installment=? WHERE id=?")
    .run(a.empId, a.date, a.amount, a.reason, a.installment, id);
  if (!info.changes) { const e = new Error("Advance not found."); e.status = 404; throw e; }
  audit(req, "advance.update", "advance", id);
}

export function applyAdvDelete(id, req) {
  const db = getDb();
  const row = db.prepare("SELECT id, emp_id FROM advances WHERE id=?").get(id);
  if (!row) { const e = new Error("Advance not found."); e.status = 404; throw e; }
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
    // stale value. wd/bonus/ded are left untouched.
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM advances WHERE emp_id=?").get(row.emp_id).n;
    if (remaining === 0) {
      db.prepare("UPDATE payroll_adjust SET adv=NULL, adv_posted=0 WHERE emp_id=?").run(row.emp_id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  audit(req, "advance.delete", "advance", id);
}

export function applyPayAdd(id, p, req) {
  if (!getDb().prepare("SELECT id FROM advances WHERE id=?").get(id)) {
    const e = new Error("Advance not found."); e.status = 404; throw e;
  }
  getDb().prepare("INSERT INTO advance_payments (advance_id,date,amount,note,kind) VALUES (?,?,?,?, 'manual')")
    .run(id, p.date, p.amount, p.note);
  audit(req, "advance.repayment", "advance", id, `manual ${p.amount}`);
  return advBalance(id);
}

export function applyPayDelete(id, payId, req) {
  const p = getDb().prepare("SELECT * FROM advance_payments WHERE id=? AND advance_id=?").get(payId, id);
  if (!p) { const e = new Error("Payment not found."); e.status = 404; throw e; }
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
  return advBalance(id);
}

/* --------------------------------- routes --------------------------------- */

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
  if (isMaker(req)) {
    return queued(res, queueApproval(req, "advance.create", null,
      `Issue advance ₹${a.amount} to ${empName(a.empId)}`,
      `Amount ₹${a.amount} · installment ₹${a.installment}/mo · date ${a.date || "—"} · reason ${a.reason || "—"}`,
      { data: a }));
  }
  res.status(201).json({ id: applyAdvCreate(a, req) });
});

router.put("/:id", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id);
  const cur = getDb().prepare("SELECT * FROM advances WHERE id=?").get(id);
  if (!cur) return res.status(404).json({ error: "Advance not found." });
  const parsed = AdvanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const a = parsed.data;
  if (isMaker(req)) {
    return queued(res, queueApproval(req, "advance.update", id,
      `Edit advance #${id} (${empName(cur.emp_id)})`,
      `Amount ₹${cur.amount} → ₹${a.amount} · installment ₹${cur.installment} → ₹${a.installment} · reason ${a.reason || "—"}`,
      { id, data: a }));
  }
  applyAdvUpdate(id, a, req);
  res.json({ ok: true });
});

router.delete("/:id", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id);
  const row = getDb().prepare("SELECT * FROM advances WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "Advance not found." });
  if (isMaker(req)) {
    return queued(res, queueApproval(req, "advance.delete", id,
      `Delete advance #${id} (${empName(row.emp_id)}, balance ₹${advBalance(id)})`,
      `Advance of ₹${row.amount} dated ${row.date || "—"}; deleting also removes its repayment history.`,
      { id }));
  }
  applyAdvDelete(id, req);
  res.json({ ok: true });
});

router.post("/:id/payments", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id);
  const adv = getDb().prepare("SELECT * FROM advances WHERE id=?").get(id);
  if (!adv) return res.status(404).json({ error: "Advance not found." });
  const parsed = PaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const p = parsed.data;
  if (isMaker(req)) {
    return queued(res, queueApproval(req, "advance.payment_add", id,
      `Add repayment ₹${p.amount} — advance #${id} (${empName(adv.emp_id)})`,
      `Date ${p.date || "—"} · note ${p.note || "—"}`,
      { id, data: p }));
  }
  res.status(201).json({ ok: true, balance: applyPayAdd(id, p, req) });
});

router.delete("/:id/payments/:payId", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id), payId = Number(req.params.payId);
  const p = getDb().prepare("SELECT * FROM advance_payments WHERE id=? AND advance_id=?").get(payId, id);
  if (!p) return res.status(404).json({ error: "Payment not found." });
  if (isMaker(req)) {
    const adv = getDb().prepare("SELECT emp_id FROM advances WHERE id=?").get(id);
    return queued(res, queueApproval(req, "advance.payment_delete", id,
      `Remove repayment ₹${p.amount} — advance #${id} (${empName(adv?.emp_id)})`,
      `${p.kind === "auto" ? "Auto salary recovery" : "Manual repayment"} dated ${p.date || "—"}; the amount returns to the balance.`,
      { id, payId }));
  }
  res.json({ ok: true, balance: applyPayDelete(id, payId, req) });
});

export default router;
