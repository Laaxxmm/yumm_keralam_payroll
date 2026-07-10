import { Router } from "express";
import { z } from "zod";
import { getDb, audit } from "../db.js";
import { requireRole } from "../auth.js";
import { encryptField, decryptField } from "../crypto.js";

const router = Router();

const EmployeeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  desig: z.string().trim().max(80).default(""),
  loc: z.string().trim().max(80).default(""),
  joining: z.string().trim().max(20).default(""),
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
    salary: row.salary, phone: row.phone, status: row.status,
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
        (name,desig,loc,joining,salary,phone,status,father_name,dob,address,qual_gen,qual_tech,
         experience,lang_read,lang_write,lang_speak,report_time,hobbies,documents,
         bank_name,acc_name,acc_no_enc,ifsc,branch,upi)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      e.name, e.desig, e.loc, e.joining, e.salary, e.phone, e.status, e.fatherName, e.dob,
      e.address, e.qualGen, e.qualTech, e.experience, e.langRead, e.langWrite, e.langSpeak,
      e.reportTime, e.hobbies, e.documents, e.bankName, e.accName,
      encryptField(e.accNo), e.ifsc, e.branch, e.upi
    );
  const id = Number(info.lastInsertRowid);
  audit(req, "employee.create", "employee", id, e.name);
  res.status(201).json({ id });
});

router.put("/:id", requireRole("admin", "hr"), (req, res) => {
  const id = Number(req.params.id);
  const exists = getDb().prepare("SELECT id FROM employees WHERE id = ?").get(id);
  if (!exists) return res.status(404).json({ error: "Employee not found." });

  const parsed = EmployeeSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.issues[0].message });
  const e = parsed.data;
  getDb()
    .prepare(
      `UPDATE employees SET name=?,desig=?,loc=?,joining=?,salary=?,phone=?,status=?,
         father_name=?,dob=?,address=?,qual_gen=?,qual_tech=?,experience=?,
         lang_read=?,lang_write=?,lang_speak=?,report_time=?,hobbies=?,documents=?,
         bank_name=?,acc_name=?,acc_no_enc=?,ifsc=?,branch=?,upi=?,updated_at=datetime('now')
       WHERE id=?`
    )
    .run(
      e.name, e.desig, e.loc, e.joining, e.salary, e.phone, e.status, e.fatherName, e.dob,
      e.address, e.qualGen, e.qualTech, e.experience, e.langRead, e.langWrite, e.langSpeak,
      e.reportTime, e.hobbies, e.documents, e.bankName, e.accName,
      encryptField(e.accNo), e.ifsc, e.branch, e.upi, id
    );
  audit(req, "employee.update", "employee", id, e.name);
  res.json({ ok: true });
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
