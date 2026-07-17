/** Admin-only checker side of the maker–checker workflow. */
import { Router } from "express";
import { audit } from "../db.js";
import { getApproval, listApprovals, markDecided } from "../services/approvals.js";
import { applyEmployeeUpdate } from "./employees.js";
import { applyAdvCreate, applyAdvUpdate, applyAdvDelete, applyPayAdd, applyPayDelete } from "./advances.js";
import { postRecoveries, unpostRecovery } from "../services/payroll.js";

const router = Router();

router.get("/", (_req, res) => res.json(listApprovals()));

/** Replay the queued action. Throws (with .status when known) on failure. */
function execute(a, req) {
  const p = a.payload;
  if (!p) { const e = new Error("Stored request could not be read."); e.status = 500; throw e; }
  switch (a.action) {
    case "employee.update": return applyEmployeeUpdate(Number(p.id), p.data, req);
    case "advance.create": return applyAdvCreate(p.data, req);
    case "advance.update": return applyAdvUpdate(Number(p.id), p.data, req);
    case "advance.delete": return applyAdvDelete(Number(p.id), req);
    case "advance.payment_add": return applyPayAdd(Number(p.id), p.data, req);
    case "advance.payment_delete": return applyPayDelete(Number(p.id), Number(p.payId), req);
    case "payroll.post": {
      const posted = postRecoveries(p.mk, req.user);
      audit(req, "payroll.post_recoveries", "payroll", p.mk, `${posted} employees (approved request)`);
      return;
    }
    case "payroll.unpost": {
      unpostRecovery(p.mk, Number(p.empId), p.mode);
      audit(req, "payroll.unpost", "payroll", p.mk, `emp ${p.empId} ${p.mode} (approved request)`);
      return;
    }
    default: { const e = new Error(`Unknown action "${a.action}".`); e.status = 400; throw e; }
  }
}

router.post("/:id/approve", (req, res) => {
  const a = getApproval(req.params.id);
  if (!a) return res.status(404).json({ error: "Request not found." });
  if (a.status !== "pending") return res.status(400).json({ error: `Already ${a.status}.` });
  if (a.requested_by === req.user.id)
    return res.status(400).json({ error: "You cannot approve your own request." });
  try {
    execute(a, req);
  } catch (e) {
    // Leave it pending so the admin can see the problem and reject with a note.
    return res.status(e.status && e.status < 500 ? e.status : 400)
      .json({ error: `Could not apply: ${e.message}` });
  }
  markDecided(a.id, "approved", req);
  audit(req, "approval.approved", "approval", a.id, a.summary);
  res.json({ ok: true });
});

router.post("/:id/reject", (req, res) => {
  const a = getApproval(req.params.id);
  if (!a) return res.status(404).json({ error: "Request not found." });
  if (a.status !== "pending") return res.status(400).json({ error: `Already ${a.status}.` });
  markDecided(a.id, "rejected", req, req.body?.note || "");
  audit(req, "approval.rejected", "approval", a.id, a.summary);
  res.json({ ok: true });
});

export default router;
