/**
 * Authoritative money math: advance balances, scheduled recovery, and payroll
 * rows. Kept server-side so the client can never fabricate a net-payable or a
 * balance — it only renders what this computes.
 */
import { getDb } from "../db.js";

export const MONTHS = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

export function advBalance(advanceId) {
  const a = getDb().prepare("SELECT amount FROM advances WHERE id = ?").get(advanceId);
  if (!a) return 0;
  const paid = getDb().prepare("SELECT COALESCE(SUM(amount),0) AS p FROM advance_payments WHERE advance_id = ?")
    .get(advanceId).p;
  return Math.max(0, a.amount - paid);
}

export function advPaid(advanceId) {
  return getDb().prepare("SELECT COALESCE(SUM(amount),0) AS p FROM advance_payments WHERE advance_id = ?")
    .get(advanceId).p;
}

/** Open advances for an employee, oldest first (FIFO recovery order). */
export function openAdvances(empId) {
  const rows = getDb().prepare("SELECT * FROM advances WHERE emp_id = ? ORDER BY id").all(empId);
  return rows.map((a) => ({ ...a, balance: advBalance(a.id) })).filter((a) => a.balance > 0);
}

/** mk = "YEAR-monthIndex" (monthIndex 0..11) */
export function mkParts(mk) { const [y, m] = String(mk).split("-"); return { y: +y, m: +m }; }
export function monthLabel(mk) { const p = mkParts(mk); return `${MONTHS[p.m]} ${p.y}`; }
export function daysInMonth(mk) { const p = mkParts(mk); return new Date(p.y, p.m + 1, 0).getDate(); }
export function monthEndStr(mk) {
  const p = mkParts(mk); const d = new Date(p.y, p.m + 1, 0);
  return `${String(d.getDate()).padStart(2, "0")}.${String(p.m + 1).padStart(2, "0")}.${p.y}`;
}
export function baseDaysFor(mk, basis) {
  if (basis === "30") return 30;
  if (basis === "26") return 26;
  return daysInMonth(mk); // calendar
}

/** Parse a dd.mm.yyyy (also dd/mm/yyyy, dd-mm-yyyy) date to ISO yyyy-mm-dd, or null. */
export function dmyToIso(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** First and last day of a payroll month as ISO strings. */
export function monthRangeIso(mk) {
  const p = mkParts(mk);
  const last = new Date(p.y, p.m + 1, 0).getDate();
  const mm = String(p.m + 1).padStart(2, "0");
  return { start: `${p.y}-${mm}-01`, end: `${p.y}-${mm}-${String(last).padStart(2, "0")}` };
}

/**
 * The value of a history-tracked field (salary/desig) as of the given month's
 * end. Falls back to the current value when the employee has no recorded
 * changes; for months before the first recorded change, uses that change's
 * old value.
 */
export function fieldAsOf(empId, field, monthEndIso, currentValue) {
  const rows = getDb()
    .prepare("SELECT old_value, new_value, effective FROM emp_history WHERE emp_id=? AND field=? ORDER BY effective, id")
    .all(empId, field);
  if (!rows.length) return currentValue;
  let val = null;
  for (const r of rows) { if (r.effective <= monthEndIso) val = r.new_value; }
  if (val !== null) return field === "salary" ? Number(val) : val;
  const first = rows[0];
  if (first.old_value == null) return currentValue;
  return field === "salary" ? Number(first.old_value) : first.old_value;
}

export function getAdjust(mk, empId) {
  return getDb().prepare("SELECT * FROM payroll_adjust WHERE mk = ? AND emp_id = ?").get(mk, empId) || null;
}

/** Scheduled recovery for a month: sum over open advances of min(installment, balance). */
export function schedRecovery(empId, mk) {
  let total = 0;
  for (const a of openAdvances(empId)) {
    const inst = a.installment || 0;
    if (inst <= 0) continue;
    const already = getDb()
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM advance_payments WHERE advance_id=? AND kind='auto' AND mk=?")
      .get(a.id, mk).s;
    const remaining = a.balance + already;
    total += Math.min(inst, remaining);
  }
  return total;
}

export function recoveryFor(empId, mk) {
  const adj = getAdjust(mk, empId);
  if (adj && adj.adv != null) return adj.adv;
  return schedRecovery(empId, mk);
}

/** Automatic week off per full month (paid), pro-rated for mid-month joiners/leavers. */
export const WEEK_OFF_PER_MONTH = 4;
/** Calendar days of the month the employee was on the rolls (joining..leaving, inclusive). */
export function employedDays(emp, mk) {
  const { start, end } = monthRangeIso(mk);
  const j = dmyToIso(emp.joining), l = dmyToIso(emp.leaving);
  const from = j && j > start ? j : start;
  const to = l && l < end ? l : end;
  if (from > to) return 0;
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}
const half = (x) => Math.round(x * 2) / 2;

export function computeRow(emp, mk, basis) {
  const bd = baseDaysFor(mk, basis);
  const adj = getAdjust(mk, emp.id);
  // Share of the month the employee was employed (joined / left mid-month).
  const frac = employedDays(emp, mk) / daysInMonth(mk);
  const avail = frac === 1 ? bd : half(bd * frac);       // payable base days this month
  const woSet = !!(adj && adj.wo_set);
  // Week off (paid): a typed value wins; otherwise 4 per month, pro-rated.
  const woAuto = Math.round(WEEK_OFF_PER_MONTH * frac);
  const wo = woSet ? adj.wo || 0 : woAuto;
  const lv = adj ? (adj.lv || 0) : 0;   // leave days (unpaid)
  const override = adj && adj.wd != null;
  // Work Days shown = payable days − week off − leaves (actual days worked), unless
  // a direct wd override is set (e.g. attendance import = present days).
  const wd = override ? adj.wd : Math.max(0, avail - wo - lv);
  // Pay: week off is PAID, so only leaves reduce it — paid days = payable days − leaves.
  // With a direct override, pay follows the override (present days).
  const paidDays = override ? adj.wd : Math.max(0, avail - lv);
  const bonus = adj ? adj.bonus : 0;
  const ded = adj ? adj.ded : 0;
  // Pay the month with the salary/designation that was in force THAT month —
  // a raise recorded with a later effective date must not rewrite old months.
  const monthEnd = monthRangeIso(mk).end;
  const salary = fieldAsOf(emp.id, "salary", monthEnd, emp.salary || 0);
  const desig = fieldAsOf(emp.id, "desig", monthEnd, emp.desig);
  const earned = Math.round((salary || 0) * (paidDays / bd));
  const rec = recoveryFor(emp.id, mk);
  const net = earned + bonus - ded - rec;
  return {
    id: emp.id, name: emp.name, desig, loc: emp.loc, salary, salaryDate: emp.salary_date || "", joining: emp.joining || "",
    wd, wo, lv, bd, earned, bonus, ded, rec, net,
    woSet, woAuto, availDays: avail,
    wdOverride: adj ? adj.wd : null,
    advPosted: !!(adj && adj.adv_posted), advOverride: adj ? adj.adv : null,
  };
}

/** Only Active employees are paid. */
export function activeEmployees() {
  return getDb().prepare("SELECT * FROM employees WHERE status='Active' ORDER BY loc, name").all();
}

/**
 * Employees on the payroll of a given month:
 *  - joined on/before the month's end (unparseable/blank joining ⇒ no filter),
 *  - if a leaving date is set: included up to and including the leaving month
 *    (regardless of the Active flag, so history stays correct),
 *  - otherwise: the current Active flag decides, as before.
 */
export function employeesForMonth(mk) {
  const { start, end } = monthRangeIso(mk);
  return getDb().prepare("SELECT * FROM employees ORDER BY loc, name").all().filter((e) => {
    const j = dmyToIso(e.joining);
    if (j && j > end) return false;
    const l = dmyToIso(e.leaving);
    if (l) return l >= start;
    return e.status === "Active";
  });
}

/**
 * Post this month's recoveries: for each active employee, apply the scheduled
 * (or overridden) amount FIFO across their open advances, writing auto payments
 * and flagging the month as posted. Idempotent per employee.
 */
export function postRecoveries(mk, actor) {
  const db = getDb();
  const insPay = db.prepare(
    "INSERT INTO advance_payments (advance_id,date,amount,note,kind,mk) VALUES (?,?,?,?,?,?)"
  );
  const upAdj = db.prepare(
    `INSERT INTO payroll_adjust (mk, emp_id, adv, adv_posted) VALUES (?,?,?,1)
     ON CONFLICT(mk, emp_id) DO UPDATE SET adv=excluded.adv, adv_posted=1`
  );
  const autoPaidStmt = db.prepare(
    `SELECT COALESCE(SUM(ap.amount),0) AS s FROM advance_payments ap
       JOIN advances a ON a.id = ap.advance_id
      WHERE a.emp_id = ? AND ap.kind = 'auto' AND ap.mk = ?`
  );
  const clearStale = db.prepare(
    "UPDATE payroll_adjust SET adv = NULL, adv_posted = 0 WHERE mk = ? AND emp_id = ?"
  );
  let posted = 0;
  db.exec("BEGIN");
  try {
    for (const emp of employeesForMonth(mk)) {
      const adj = getAdjust(mk, emp.id);
      if (adj && adj.adv_posted) {
        // A month flagged "posted" must have actual auto-payments behind it.
        // If it has none, the advance it recovered was later deleted and this
        // flag is stale — clear it so the current open advances can recover.
        if (autoPaidStmt.get(emp.id, mk).s > 0) continue; // genuinely posted
        clearStale.run(mk, emp.id);
      }
      let amt = recoveryFor(emp.id, mk);
      if (amt <= 0) continue;
      let applied = 0;
      for (const a of openAdvances(emp.id)) {
        if (amt <= 0) break;
        const take = Math.min(a.balance, amt);
        if (take > 0) {
          insPay.run(a.id, monthEndStr(mk), take, "Salary recovery", "auto", mk);
          amt -= take; applied += take;
        }
      }
      if (applied > 0) { upAdj.run(mk, emp.id, applied); posted++; }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return posted;
}

/** Undo a posted recovery for one employee this month. mode 'edit'|'delete'. */
export function unpostRecovery(mk, empId, mode) {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const advs = db.prepare("SELECT id FROM advances WHERE emp_id = ?").all(empId);
    for (const a of advs) {
      db.prepare("DELETE FROM advance_payments WHERE advance_id=? AND kind='auto' AND mk=?").run(a.id, mk);
    }
    const adj = getAdjust(mk, empId);
    const keepAmt = mode === "delete" ? 0 : adj ? adj.adv : null;
    db.prepare(
      `INSERT INTO payroll_adjust (mk, emp_id, adv, adv_posted) VALUES (?,?,?,0)
       ON CONFLICT(mk, emp_id) DO UPDATE SET adv=excluded.adv, adv_posted=0`
    ).run(mk, empId, keepAmt);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
