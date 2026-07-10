/**
 * Legacy import: turn a backup JSON from the old single-file app into rows in
 * the secure database. Used by both the CLI script and the admin API endpoint,
 * so the logic lives in exactly one place.
 *
 * Bank account numbers are encrypted on the way in. KYC files are not part of
 * the JSON backup (they lived in the browser) and must be re-uploaded.
 */
import { encryptField } from "../crypto.js";

const S = (v) => (v == null ? "" : String(v));

export function importLegacy(db, data, { replace = false } = {}) {
  if (!data || !Array.isArray(data.employees)) {
    throw new Error("Backup must contain an 'employees' array.");
  }

  const insEmp = db.prepare(
    `INSERT INTO employees
       (name,desig,loc,joining,salary,phone,status,father_name,dob,address,qual_gen,qual_tech,
        experience,lang_read,lang_write,lang_speak,report_time,hobbies,documents,
        bank_name,acc_name,acc_no_enc,ifsc,branch,upi)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insAdv = db.prepare("INSERT INTO advances (emp_id,date,amount,reason,installment) VALUES (?,?,?,?,?)");
  const insPay = db.prepare("INSERT INTO advance_payments (advance_id,date,amount,note,kind,mk) VALUES (?,?,?,?,?,?)");

  const idMap = new Map();
  let emps = 0, advs = 0;

  db.exec("BEGIN");
  try {
    if (replace) {
      db.exec("DELETE FROM advance_payments; DELETE FROM advances; DELETE FROM kyc_files; DELETE FROM employees;");
    }
    for (const e of data.employees) {
      if (!S(e.name).trim()) continue;
      const info = insEmp.run(
        S(e.name), S(e.desig), S(e.loc), S(e.joining), Math.max(0, Number(e.salary) || 0),
        S(e.phone), e.status === "Inactive" ? "Inactive" : "Active",
        S(e.fatherName), S(e.dob), S(e.address), S(e.qualGen), S(e.qualTech), S(e.experience),
        S(e.langRead), S(e.langWrite), S(e.langSpeak), S(e.reportTime), S(e.hobbies), S(e.documents),
        S(e.bankName), S(e.accName), e.accNo ? encryptField(S(e.accNo)) : null,
        S(e.ifsc).toUpperCase(), S(e.branch), S(e.upi)
      );
      idMap.set(e.id, Number(info.lastInsertRowid));
      emps++;
    }

    if (data.company) {
      const c = data.company;
      db.prepare(
        `UPDATE company SET name=?,entity_type=?,contact=?,mobile=?,email=?,addr1=?,addr2=?,
           city=?,state=?,pincode=?,country=?,gstin=?,pan=?,uid=?,tagline=? WHERE id=1`
      ).run(
        S(c.name), S(c.entityType), S(c.contact), S(c.mobile), S(c.email), S(c.addr1), S(c.addr2),
        S(c.city), S(c.state), S(c.pincode), S(c.country), S(c.gstin), S(c.pan), S(c.uid), S(c.tagline)
      );
    }

    for (const a of data.advances ?? []) {
      const empId = idMap.get(a.empId);
      if (!empId || !(Number(a.amount) > 0)) continue;
      const info = insAdv.run(empId, S(a.date), Number(a.amount), S(a.reason), Number(a.installment) || 0);
      const advId = Number(info.lastInsertRowid);
      for (const p of a.payments ?? []) {
        if (!(Number(p.amount) > 0)) continue;
        insPay.run(advId, S(p.date), Number(p.amount), S(p.note), p.kind === "auto" ? "auto" : "manual", p.mk ?? null);
      }
      advs++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { employees: emps, advances: advs };
}
