import { Router } from "express";
import { z } from "zod";
import { getDb, audit } from "../db.js";
import { requireRole } from "../auth.js";
import { encryptField, decryptField } from "../crypto.js";
import { queueApproval, maskAcc } from "../services/approvals.js";
import { dmyToIso } from "../services/payroll.js";

const router = Router();

const EmployeeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  desig: z.string().trim().max(80).default(""),
  loc: z.string().trim().max(80).default(""),
  joining: z.string().trim().max(20).default(""),
  leaving: z.string().trim().max(20).default(""),
  effectiveFrom: z.string().trim().max(20).default(""), // for salary/desig history, not a column
  salary: z.coerce.number().int().min(0).max(100_000_000).default(0),
  phone: z.string().trim().max(20).regex(/^[0-9+\-\s()]*$/, "Invalid phone").default(""),
  status: z.enum(["Active", "Inactive"]).default("Active"),
  fatherName: z.string().trim().max(120).default(""),
  dob: z.string().trim().max(20).default(""),
  address: z.string().trim().max(300).default(""),
  qualGen: z.string().trim().max(120).default(""),
  qualTech: z.string().trim().max(120).default(""),
  experience: z.string().trim().max(200).default(""),
  langRead: z.string().trim().max(120).default(""),
  langWrite: z.string().trim().max(120).default(""),
  langSpeak: z.string().trim().max(120).default(""),
  reportTime: z.string().trim().max(20).default(""),
  hobbies: z.string().trim().max(200).default(""),
  documents: z.string().trim().max(300).default(""),
  bankName: z.string().trim().max(80).default(""),
  accName: z.string().trim().max(120).default(""),
  accNo: z.string().trim().max(30).regex(/^[0-9]*$/, "Account number must be digits").default(""),
  ifsc: z.string().trim().toUpperCase().max(15).default(""),
  branch: z.string().trim().max(80).default(""),
  upi: z.string().trim().max(80).default(""),
});

/**
 * Bank account numbers are decrypted only for admin/hr. A `viewer` never
 * receives them at all — the field is omitted from the JSON, not blanked,
 * so it cannot be recovered from the response.
 */
function toApi(row, role) {
  const canSeeBank = role === "admin" || role === "hr";
  const out = {
    id: row.id, name: row.name, desig: row.desig, loc: row.loc, joining: row.joining,
    leaving: row.leaving || "", salary: row.salary, phone: row.phone, status: row.status,
    fatherName: row.father_name, dob: row.dob, address: row.address,
    qualGen: row.qual_gen, qualTech: row.qual_tech, experience: row.experience,
    langRead: row.lang_read, langWrite: row.lang_write, langSpeak: row.lang_speak,
    reportTime: row.report_time, hobbies: row.hobbies, documents: row.documents,
    bankName: row.bank_name, accName: row.acc_name, ifsc: row.ifsc,
    branch: row.branch, upi: row.upi,
  };
  if (canSeeBank) out.accNo = decryptField(row.acc_no_enc);
  return out;
}

router.get("/", (req, res) => {
  const rows = getDb().prepare("SELECT * FROM employees ORDER BY name COLLATE NOCASE").all();
  res.json({ employees: rows.map((r) => toApi(r, req.user.role)) });
});

router.get("/:id", (req, res) => {
  const row = getDb().prepare("SELECT * FROM employees WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Employee not found." });
  res.json({ employee: toApi(row, req.user.role) });
});

router.post("/", requireRole("admin", "hr"), (req, res) => {
  const parsed = EmployeeSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.issues[0].message });
  const e = parsed.data;
  const info = getDb()
    .prepare(
      `INSERT INTO employees
        (name,desig,loc,joining,leaving,salary,phone,status,father_name,dob,address,qual_gen,qual_tech,
         experience,lang_read,lang_write,lang_speak,report_time,hobbies,documents,
         bank_name,acc_name,acc_no_enc,ifsc,branch,upi)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      e.name, e.desig, e.loc, e.joining, e.leaving, e.salary, e.phone, e.status, e.fatherName, e.dob,
      e.address, e.qualGen, e.qualTech, e.experience, e.langRead, e.langWrite, e.langSpeak,
      e.reportTime, e.hobbies, e.documents, e.bankName, e.accName,
      encryptField(e.accNo), e.ifsc, e.branch, e.upi
    );
  const id = Number(info.lastInsertRowid);
  audit(req, "employee.create", "employee", id, e.name);
  res.status(201).json({ id });
});

/**
 * Apply a validated employee update: write the row and record salary /
 * designation changes in emp_history with their effective date. Used directly
 * by admins and replayed when an admin approves a maker's queued change.
 */
export function applyEmployeeUpdate(id, e, req) {
  const db = getDb();
  const cur = db.prepare("SELECT * FROM employees WHERE id = ?").get(id);
  if (!cur) { const err = new Error("Employee not found."); err.status = 404; throw err; }
  const effective = dmyToIso(e.effectiveFrom) || new Date().toISOString().slice(0, 10);
  const insHist = db.prepare(
    "INSERT INTO emp_history (emp_id, field, old_value, new_value, effective, changed_by) VALUES (?,?,?,?,?,?)"
  );
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE employees SET name=?,desig=?,loc=?,joining=?,leaving=?,salary=?,phone=?,status=?,
         father_name=?,dob=?,address=?,qual_gen=?,qual_tech=?,experience=?,
         lang_read=?,lang_write=?,lang_speak=?,report_time=?,hobbies=?,documents=?,
         bank_name=?,acc_name=?,acc_no_enc=?,ifsc=?,branch=?,upi=?,updated_at=datetime('now')
       WHERE id=?`
    ).run(
      e.name, e.desig, e.loc, e.joining, e.leaving, e.salary, e.phone, e.status, e.fatherName, e.dob,
      e.address, e.qualGen, e.qualTech, e.experience, e.langRead, e.langWrite, e.langSpeak,
      e.reportTime, e.hobbies, e.documents, e.bankName, e.accName,
      encryptField(e.accNo), e.ifsc, e.branch, e.upi, id
    );
    if (Number(e.salary) !== cur.salary)
      insHist.run(id, "salary", String(cur.salary), String(e.salary), effective, req?.user?.username ?? null);
    if (e.desig !== cur.desig)
      insHist.run(id, "desig", cur.desig, e.desig, effective, req?.user?.username ?? null);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  audit(req, "employee.update", "employee", id, e.name);
}

/** The field changes that require a checker when made by an hr user. */
function sensitiveChanges(cur, e) {
  const ch = [];
  if (Number(e.salary) !== cur.salary) ch.push(`Salary ₹${cur.salary} → ₹${e.salary}`);
  if (e.desig !== cur.desig) ch.push(`Designation "${cur.desig || "—"}" → "${e.desig || "—"}"`);
  const curAcc = decryptField(cur.acc_no_enc);
  if (e.accNo !== curAcc) ch.push(`Account no ${maskAcc(curAcc)} → ${maskAcc(e.accNo)}`);
  if (e.bankName !== cur.bank_name) ch.push(`Bank "${cur.bank_name || "—"}" → "${e.bankName || "—"}"`);
  if (e.accName !== cur.acc_name) ch.push(`Account holder "${cur.acc_name || "—"}" → "${e.accName || "—"}"`);
  if (e.ifsc !== cur.ifsc) ch.push(`IFSC ${cur.ifsc || "—"} → ${e.ifsc || "—"}`);
  if (e.branch !== cur.branch) ch.push(`Branch "${cur.branch || "—"}" → "${e.branch || "—"}"`);
  if (e.upi !== cur.upi) ch.push(`UPI "${cur.upi || "—"}" → "${e.upi || "—"}"`);
  return ch;
}

router.put("/:id", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id);
  const cur = getDb().prepare("SELECT * FROM employees WHERE id = ?").get(id);
  if (!cur) return res.status(404).json({ error: "Employee not found." });

  const parsed = EmployeeSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.issues[0].message });
  const e = parsed.data;

  // Maker–checker: hr changing salary/designation/bank details needs an admin.
  if (req.user.role === "hr") {
    const changes = sensitiveChanges(cur, e);
    if (changes.length) {
      const aid = queueApproval(
        req, "employee.update", id,
        `Update ${cur.name} — ${changes[0]}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ""}`,
        changes.join("\n"),
        { id, data: e }
      );
      return res.status(202).json({ queued: true, approvalId: aid });
    }
  }
  applyEmployeeUpdate(id, e, req);
  res.json({ ok: true });
});

/** Salary / designation change history for one employee, newest first. */
router.get("/:id/history", (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT field, old_value, new_value, effective, changed_by, changed_at FROM emp_history WHERE emp_id = ? ORDER BY effective DESC, id DESC"
    )
    .all(Number(req.params.id));
  res.json({ history: rows });
});

// Deleting people (and, by cascade, their KYC and advances) is admin-only.
router.delete("/:id", requireRole("admin"), (req, res) => {
  const id = Number(req.params.id);
  const row = getDb().prepare("SELECT name FROM employees WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Employee not found." });
  getDb().prepare("DELETE FROM employees WHERE id = ?").run(id);
  audit(req, "employee.delete", "employee", id, row.name);
  res.json({ ok: true });
});

export default router;
