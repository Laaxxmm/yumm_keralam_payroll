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

/*
 * Automatic advance recovery — booked against the advance with no manual
 * "post" step, in every month from the first advance on:
 *  - an advance is recovered in the payroll of the month it was given, in full;
 *  - from October 2026 ("2026-9"), an advance WITH an installment is instead
 *    recovered by that installment each month, starting the month it was given.
 * Undated advances have no month, so they are only recovered by installment
 * (Oct 2026 on) or by hand.
 */
export const INSTALLMENTS_FROM = "2026-9";
const mkNum = (mk) => { const p = mkParts(mk); return p.y * 12 + p.m; };
/** Payroll month key of a dd.mm.yyyy date, or null. */
export function mkOfDate(s) { const iso = dmyToIso(s); return iso ? `${+iso.slice(0, 4)}-${+iso.slice(5, 7) - 1}` : null; }
/** The current month in India (IST), as a month key. */
export function currentMk() { const d = new Date(Date.now() + 5.5 * 3600e3); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; }
/** Months whose recoveries are due now: the first advance's month .. current month. */
export function dueMonths() {
  const end = mkNum(currentMk());
  let start = Math.min(end, mkNum(INSTALLMENTS_FROM));
  for (const r of getDb().prepare("SELECT date FROM advances").all()) {
    const m = mkOfDate(r.date); if (m) start = Math.min(start, mkNum(m));
  }
  const out = [];
  for (let n = start; n <= end; n++) out.push(`${Math.floor(n / 12)}-${n % 12}`);
  return out;
}

/** Scheduled recovery for a month: sum over open advances of min(installment, balance). */
export function schedRecovery(empId, mk) {
  let total = 0;
  const installments = mkNum(mk) >= mkNum(INSTALLMENTS_FROM);
  for (const a of openAdvances(empId)) {
    const issued = mkOfDate(a.date);
    if (issued && mkNum(issued) > mkNum(mk)) continue; // given after this month
    // In full in the month it was given; from Oct 2026 an installment, if set, instead.
    const full = issued === mk ? Infinity : 0;
    const inst = installments && a.installment > 0 ? a.installment : full;
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

/**
 * Week-off bonus (October 2026 = "2026-9" onward): the 4 week offs a month
 * (pro-rated) are an entitlement; any not taken are paid as extra days, shown
 * separately as WO Bonus. 30-day month, 1 week off taken → 3 unused →
 * paid days 33. With attendance present days P: up to 4 absences count as
 * week offs, the rest as unpaid leave → paid days = P + entitlement.
 */
export const WO_BONUS_FROM = "2026-9";

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
  const typedLv = adj ? (adj.lv || 0) : 0;   // leave days (unpaid)
  const override = adj && adj.wd != null;
  const woBonusRule = mkNum(mk) >= mkNum(WO_BONUS_FROM);
  let woTaken = wo, lv = typedLv, wd, payDays, woUnused = 0;
  if (woBonusRule) {
    if (override) {
      // Attendance / typed present days: absences up to the entitlement are week offs, the rest leave.
      const absent = Math.max(0, avail - adj.wd);
      woTaken = Math.min(woAuto, absent);
      lv = Math.max(0, absent - woAuto);
      wd = adj.wd;
    } else {
      wd = Math.max(0, avail - wo - lv);
    }
    woUnused = Math.max(0, woAuto - woTaken);
    payDays = Math.max(0, avail - lv);           // salary days (week offs taken are paid)
  } else {
    // Before Oct 2026: Work Days = payable days − week off − leaves; an override is present days and drives pay.
    wd = override ? adj.wd : Math.max(0, avail - wo - lv);
    payDays = override ? adj.wd : Math.max(0, avail - lv);
  }
  const paidDays = payDays + woUnused;           // e.g. 30 + 3 unused week offs = 33
  const bonus = adj ? adj.bonus : 0;
  const ded = adj ? adj.ded : 0;
  // Pay the month with the salary/designation that was in force THAT month —
  // a raise recorded with a later effective date must not rewrite old months.
  const monthEnd = monthRangeIso(mk).end;
  const salary = fieldAsOf(emp.id, "salary", monthEnd, emp.salary || 0);
  const desig = fieldAsOf(emp.id, "desig", monthEnd, emp.desig);
  const earned = Math.round((salary || 0) * (payDays / bd));
  const woBonus = Math.round((salary || 0) * (woUnused / bd));
  const rec = recoveryFor(emp.id, mk);
  const net = earned + woBonus + bonus - ded - rec;
  return {
    id: emp.id, empCode: emp.emp_code || "", name: emp.name, desig, loc: emp.loc, salary, salaryDate: emp.salary_date || "", joining: emp.joining || "",
    wd, wo: woTaken, lv, bd, earned, bonus, ded, rec, net,
    woUnused, woBonus, paidDays,
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

/** Run fn inside one transaction (all-or-nothing). */
function tx(fn) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(db); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** How much of this advance falls due in month mk (advance balance as it stands). */
function dueFromAdvance(a, mk) {
  const issued = mkOfDate(a.date);
  if (issued && mkNum(issued) > mkNum(mk)) return 0; // given after this month
  const inst = mkNum(mk) >= mkNum(INSTALLMENTS_FROM) && a.installment > 0 ? a.installment
    : issued === mk ? Infinity : 0;
  return Math.max(0, Math.min(inst, a.balance));
}

/**
 * Book month mk's recoveries for every employee on that payroll. No
 * transaction of its own — callers wrap it. Duplicate-proof:
 *  - an employee-month already booked (flag + payments behind it) is skipped;
 *  - otherwise any auto payments left in that employee-month are removed
 *    first, so a month is always booked from a clean slate, never on top;
 *  - each advance gets at most one auto payment per month (also enforced by
 *    the unique index idx_auto_once).
 */
function postMonth(db, mk) {
  const insPay = db.prepare(
    "INSERT INTO advance_payments (advance_id,date,amount,note,kind,mk) VALUES (?,?,?,?,?,?)"
  );
  const upAdj = db.prepare(
    `INSERT INTO payroll_adjust (mk, emp_id, adv, adv_posted) VALUES (?,?,?,1)
     ON CONFLICT(mk, emp_id) DO UPDATE SET adv=excluded.adv, adv_posted=1`
  );
  const autoPaid = db.prepare(
    `SELECT COALESCE(SUM(ap.amount),0) AS s FROM advance_payments ap
       JOIN advances a ON a.id = ap.advance_id WHERE a.emp_id = ? AND ap.kind = 'auto' AND ap.mk = ?`
  );
  const clearMonth = db.prepare(
    "DELETE FROM advance_payments WHERE kind='auto' AND mk=? AND advance_id IN (SELECT id FROM advances WHERE emp_id=?)"
  );
  const clearFlag = db.prepare("UPDATE payroll_adjust SET adv_posted = 0 WHERE mk = ? AND emp_id = ?");
  let posted = 0;
  for (const emp of employeesForMonth(mk)) {
    const adj = getAdjust(mk, emp.id);
    if (adj && adj.adv_posted) {
      if (autoPaid.get(emp.id, mk).s > 0) continue;   // genuinely booked
      clearFlag.run(mk, emp.id);                      // stale flag (its advance was deleted)
    }
    clearMonth.run(mk, emp.id);                       // clean slate — never book on top
    const advs = openAdvances(emp.id);
    const takes = new Map();
    if (adj && adj.adv != null) {
      // A typed amount (✎): this month's own advances first, then the oldest open ones.
      let left = adj.adv;
      const order = [...advs.filter((a) => dueFromAdvance(a, mk) > 0), ...advs.filter((a) => dueFromAdvance(a, mk) <= 0)];
      for (const a of order) { if (left <= 0) break; const t = Math.min(a.balance, left); if (t > 0) { takes.set(a.id, t); left -= t; } }
    } else {
      for (const a of advs) { const t = dueFromAdvance(a, mk); if (t > 0) takes.set(a.id, t); }
    }
    let applied = 0;
    for (const [id, t] of takes) { insPay.run(id, monthEndStr(mk), t, "Salary recovery", "auto", mk); applied += t; }
    if (applied > 0) { upAdj.run(mk, emp.id, applied); posted++; }
  }
  return posted;
}

/** Book one month's recoveries (admin action / approval replay). */
export function postRecoveries(mk, _actor) { return tx((db) => postMonth(db, mk)); }

/** Book every due month's recoveries, oldest first, in one transaction (idempotent). */
export function autoPostDue(_actor) {
  return tx((db) => dueMonths().reduce((n, mk) => n + postMonth(db, mk), 0));
}

/** An employee's advances changed: drop all their auto recoveries and book them again. */
export function rebookEmployee(empId, _actor) {
  return tx((db) => {
    db.prepare("DELETE FROM advance_payments WHERE kind='auto' AND advance_id IN (SELECT id FROM advances WHERE emp_id=?)").run(empId);
    db.prepare("UPDATE payroll_adjust SET adv=NULL, adv_posted=0 WHERE emp_id=?").run(empId);
    return dueMonths().reduce((n, mk) => n + postMonth(db, mk), 0);
  });
}

/**
 * One-time switch to automatic recovery: drop every salary recovery that was
 * posted by hand (all months) and book them all again by the rule above, for
 * all employees, in one transaction. Manual (cash) repayments are kept.
 */
export function rebookAllDue(_actor) {
  return tx((db) => {
    db.prepare("DELETE FROM advance_payments WHERE kind='auto'").run();
    db.prepare("UPDATE payroll_adjust SET adv=NULL, adv_posted=0").run();
    return dueMonths().reduce((n, mk) => n + postMonth(db, mk), 0);
  });
}

/** One auto recovery per advance per month, enforced by the database. */
export function ensureAutoOnceIndex() {
  getDb().exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_once ON advance_payments(advance_id, mk) WHERE kind = 'auto'");
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
