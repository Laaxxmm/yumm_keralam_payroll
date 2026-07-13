import { Router } from "express";
import { z } from "zod";
import { getDb, audit } from "../db.js";
import { requireRole } from "../auth.js";
import {
  activeEmployees, computeRow, baseDaysFor, monthLabel,
  postRecoveries, unpostRecovery,
} from "../services/payroll.js";

const router = Router();
const MK_RE = /^\d{4}-(?:[0-9]|1[01])$/; // YYYY-monthIndex(0..11)

/** GET /api/payroll/:mk?basis=cal|30|26 — server-computed rows + totals. */
router.get("/:mk", (req, res) => {
  const mk = req.params.mk;
  if (!MK_RE.test(mk)) return res.status(400).json({ error: "Bad month key." });
  const basis = ["cal", "30", "26"].includes(req.query.basis) ? req.query.basis : "cal";
  const rows = activeEmployees().map((e) => computeRow(e, mk, basis));
  const totals = rows.reduce(
    (t, r) => ({
      earned: t.earned + r.earned, bonus: t.bonus + r.bonus, ded: t.ded + r.ded,
      rec: t.rec + r.rec, net: t.net + r.net,
    }),
    { earned: 0, bonus: 0, ded: 0, rec: 0, net: 0 }
  );
  const pending = rows.filter((r) => !r.advPosted && r.rec > 0).length;
  res.json({ mk, label: monthLabel(mk), baseDays: baseDaysFor(mk, basis), basis, rows, totals, pending });
});

// `wd` and `adv` are nullable: null means "unset — fall back to the default"
// (base working days / scheduled recovery). `.nullable()` must wrap the coercion
// so an explicit null is preserved; a bare `z.union([z.coerce.number(), z.null()])`
// would let z.coerce.number() turn null into 0, making it impossible to clear
// an override (it would stay stuck at 0).
const AdjustSchema = z.object({
  wd: z.coerce.number().int().min(0).max(366).nullable().optional(),
  bonus: z.coerce.number().int().min(0).max(100_000_000).optional(),
  ded: z.coerce.number().int().min(0).max(100_000_000).optional(),
  adv: z.coerce.number().int().min(0).max(100_000_000).nullable().optional(),
});

/** PUT /api/payroll/:mk/:empId — set working days / bonus / deduction / recovery override. */
router.put("/:mk/:empId", requireRole("admin", "hr"), (req, res) => {
  const mk = req.params.mk, empId = Number(req.params.empId);
  if (!MK_RE.test(mk)) return res.status(400).json({ error: "Bad month key." });
  const parsed = AdjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const cur = getDb().prepare("SELECT * FROM payroll_adjust WHERE mk=? AND emp_id=?").get(mk, empId) || {};
  const wd = "wd" in parsed.data ? parsed.data.wd : cur.wd ?? null;
  const bonus = "bonus" in parsed.data ? parsed.data.bonus : cur.bonus ?? 0;
  const ded = "ded" in parsed.data ? parsed.data.ded : cur.ded ?? 0;
  const adv = "adv" in parsed.data ? parsed.data.adv : cur.adv ?? null;
  getDb().prepare(
    `INSERT INTO payroll_adjust (mk, emp_id, wd, bonus, ded, adv, adv_posted)
       VALUES (?,?,?,?,?,?, COALESCE((SELECT adv_posted FROM payroll_adjust WHERE mk=? AND emp_id=?),0))
     ON CONFLICT(mk, emp_id) DO UPDATE SET wd=excluded.wd, bonus=excluded.bonus, ded=excluded.ded, adv=excluded.adv`
  ).run(mk, empId, wd, bonus, ded, adv, mk, empId);
  res.json({ ok: true });
});

router.post("/:mk/post-recoveries", requireRole("admin", "hr"), (req, res) => {
  const mk = req.params.mk;
  if (!MK_RE.test(mk)) return res.status(400).json({ error: "Bad month key." });
  const posted = postRecoveries(mk, req.user);
  audit(req, "payroll.post_recoveries", "payroll", mk, `${posted} employees`);
  res.json({ ok: true, posted });
});

router.post("/:mk/unpost/:empId", requireRole("admin", "hr"), (req, res) => {
  const mk = req.params.mk, empId = Number(req.params.empId);
  if (!MK_RE.test(mk)) return res.status(400).json({ error: "Bad month key." });
  const mode = req.body?.mode === "delete" ? "delete" : "edit";
  unpostRecovery(mk, empId, mode);
  audit(req, "payroll.unpost", "payroll", mk, `emp ${empId} ${mode}`);
  res.json({ ok: true });
});

export default router;
