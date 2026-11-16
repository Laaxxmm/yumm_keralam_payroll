/** Domain-logic tests: company, advances, payroll recovery, users. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.APP_ENC_KEY = crypto.randomBytes(32).toString("base64");
process.env.DB_FILE = ":memory:";
process.env.NODE_ENV = "test";
process.env.LOGIN_RATE_MAX = "100000";
process.env.API_RATE_MAX = "100000";

const { createApp } = await import("../src/app.js");
const { openDb, getDb, closeDb } = await import("../src/db.js");
const { createUser } = await import("../src/auth.js");

let server, base, adminCookie, empId;
const H = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };

before(async () => {
  openDb(":memory:");
  await createUser({ username: "boss", password: "Qw8rtY2motp", role: "admin" });
  await new Promise((r) => { server = createApp().listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ username: "boss", password: "Qw8rtY2motp" }) });
  adminCookie = login.headers.get("set-cookie").split(";")[0];
  const c = await fetch(`${base}/api/employees`, { method: "POST", headers: { ...H, cookie: adminCookie }, body: JSON.stringify({ name: "Abdul", salary: 14000, status: "Active" }) });
  empId = (await c.json()).id;
});
after(() => { server?.close(); closeDb(); });

const api = (path, opts = {}) =>
  fetch(`${base}${path}`, { ...opts, headers: { ...H, cookie: adminCookie, ...(opts.headers || {}) } });

test("company profile round-trips", async () => {
  await api("/api/company", { method: "PUT", body: JSON.stringify({ name: "Yumm Keralam", gstin: "22AAAAA0000A1Z5", city: "Bangalore" }) });
  const c = await (await api("/api/company")).json();
  assert.equal(c.company.name, "Yumm Keralam");
  assert.equal(c.company.gstin, "22AAAAA0000A1Z5");
});

// Advances are recovered automatically: in full in the month they are given
// (before Oct 2026 even when an installment is set). No posting step.
test("advance recovery: booked in full in its own month, automatically", async () => {
  const adv = await (await api("/api/advances", { method: "POST", body: JSON.stringify({ empId, amount: 6000, installment: 500, reason: "Medical", date: "01.07.2026" }) })).json();
  const mk = "2026-6"; // July 2026

  const r = await (await api(`/api/payroll/${mk}?basis=cal`)).json();
  const row = r.rows.find((x) => x.id === empId);
  assert.equal(row.earned, 14000);       // full month
  assert.deepEqual([row.rec, row.advPosted, row.net], [6000, true, 8000]);
  const led = await (await api(`/api/advances/${adv.id}/ledger`)).json();
  assert.equal(led.advance.balance, 0);
  assert.deepEqual(led.payments.filter((p) => p.kind === "auto").map((p) => [p.mk, p.amount]), [[mk, 6000]]);
  // Nothing in the following month — it was all recovered in July
  assert.equal((await (await api(`/api/payroll/2026-7?basis=cal`)).json()).rows.find((x) => x.id === empId).rec, 0);
});

test("advance recovery: 🗑 skips the month, ✎ books a different amount", async () => {
  const mk = "2026-6";
  const row = async () => (await (await api(`/api/payroll/${mk}?basis=cal`)).json()).rows.find((x) => x.id === empId);
  const advOf = async () => (await (await api("/api/advances")).json()).advances.find((x) => x.empId === empId);
  // From Oct 2026 the 500 installment applies to whatever July left, so subtract those months.
  const otherMonths = async () => (await (await api(`/api/advances/${(await advOf()).id}/ledger`)).json())
    .payments.filter((p) => p.kind === "auto" && p.mk !== mk).reduce((t, p) => t + p.amount, 0);
  const bal = async () => (await advOf()).balance + await otherMonths();

  await api(`/api/payroll/${mk}/unpost/${empId}`, { method: "POST", body: JSON.stringify({ mode: "delete" }) });
  assert.deepEqual([(await row()).rec, (await row()).net], [0, 14000]);   // stays skipped
  assert.equal(await bal(), 6000);

  // ✎: un-post (edit) then the new amount; it is booked on the next load
  await api(`/api/payroll/${mk}/unpost/${empId}`, { method: "POST", body: JSON.stringify({ mode: "edit" }) });
  await api(`/api/payroll/${mk}/${empId}`, { method: "PUT", body: JSON.stringify({ adv: 2000 }) });
  const r = await row();
  assert.deepEqual([r.rec, r.advPosted], [2000, true]);
  assert.equal(await bal(), 4000);

  // A booked amount can't be overwritten directly
  const put = await api(`/api/payroll/${mk}/${empId}`, { method: "PUT", body: JSON.stringify({ adv: 1 }) });
  assert.equal(put.status, 409);
});

test("manual repayment reduces balance; deleting it restores", async () => {
  const advs = await (await api("/api/advances")).json();
  const a = advs.advances.find((x) => x.empId === empId);
  const start = a.balance;
  const pay = await (await api(`/api/advances/${a.id}/payments`, { method: "POST", body: JSON.stringify({ amount: 1000, note: "Cash", date: "05.07.2026" }) })).json();
  assert.equal(pay.balance, start - 1000);
  const led = await (await api(`/api/advances/${a.id}/ledger`)).json();
  const manual = led.payments.find((p) => p.kind === "manual");
  const del = await (await api(`/api/advances/${a.id}/payments/${manual.id}`, { method: "DELETE" })).json();
  assert.equal(del.balance, start);
});

test("payroll basis 30 halves earned at 15 working days", async () => {
  const mk = "2026-6";
  await api(`/api/payroll/${mk}/${empId}`, { method: "PUT", body: JSON.stringify({ wd: 15 }) });
  const r = await (await api(`/api/payroll/${mk}?basis=30`)).json();
  const row = r.rows.find((x) => x.id === empId);
  assert.equal(row.bd, 30);
  assert.equal(row.earned, 7000); // 14000 * 15/30
});

test("admin can create a user; duplicate is rejected", async () => {
  const ok = await api("/api/users", { method: "POST", body: JSON.stringify({ username: "clerk", password: "Kp93zXwq18", role: "viewer" }) });
  assert.equal(ok.status, 201);
  const dup = await api("/api/users", { method: "POST", body: JSON.stringify({ username: "clerk", password: "Kp93zXwq18", role: "viewer" }) });
  assert.equal(dup.status, 409);
});

test("cannot delete the last admin", async () => {
  const users = await (await api("/api/users")).json();
  const adminId = users.users.find((u) => u.role === "admin").id;
  const r = await api(`/api/users/${adminId}`, { method: "DELETE" });
  assert.equal(r.status, 400);
});

test("bad month key is rejected", async () => {
  const r = await api("/api/payroll/not-a-month?basis=cal");
  assert.equal(r.status, 400);
});

test("admin legacy import creates employees with encrypted bank number", async () => {
  const backup = { employees: [
    { id: 1, name: "Imported One", desig: "Cook", loc: "YKK", salary: 20000, phone: "9000000000", accNo: "555544443333", ifsc: "sbin0009999" },
    { id: 2, name: "Imported Two", desig: "Waiter", loc: "YKW", salary: 15000, status: "Inactive" },
  ], company: { name: "Yumm Keralam", gstin: "22AAAAA0000A1Z5" } };
  const r = await api("/api/admin/import-legacy", { method: "POST", body: JSON.stringify({ backup }) });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.employees, 2);
  const list = await (await api("/api/employees")).json();
  const one = list.employees.find((e) => e.name === "Imported One");
  assert.equal(one.accNo, "555544443333"); // admin sees decrypted
  const row = getDb().prepare("SELECT acc_no_enc FROM employees WHERE name='Imported One'").get();
  assert.ok(!row.acc_no_enc.includes("555544443333")); // stored encrypted
});

test("legacy import rejects malformed payload", async () => {
  const r = await api("/api/admin/import-legacy", { method: "POST", body: JSON.stringify({ backup: { nope: true } }) });
  assert.equal(r.status, 400);
});

test("salary history: each month pays the salary in force that month", async () => {
  const emp = await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name: "HistTest", salary: 10000, status: "Active" }) })).json();
  const row = async (mk) => (await (await api(`/api/payroll/${mk}?basis=30`)).json()).rows.find((x) => x.id === emp.id);
  assert.equal((await row("2026-6")).salary, 10000);

  const full = (await (await api("/api/employees/" + emp.id)).json()).employee;
  await api("/api/employees/" + emp.id, { method: "PUT", body: JSON.stringify({ ...full, salary: 20000, effectiveFrom: "01.08.2026" }) });

  assert.equal((await row("2026-6")).salary, 10000); // July still old salary
  assert.equal((await row("2026-7")).salary, 20000); // August uses the raise
  const hist = (await (await api(`/api/employees/${emp.id}/history`)).json()).history;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].field, "salary");
  assert.equal(hist[0].new_value, "20000");
  assert.equal(hist[0].effective, "2026-08-01");
});

test("joining/leaving dates control which months an employee is on payroll", async () => {
  const emp = await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name: "LeaveTest", salary: 9000, status: "Active", joining: "01.06.2026", leaving: "15.07.2026" }) })).json();
  const inMonth = async (mk) => !!(await (await api(`/api/payroll/${mk}?basis=30`)).json()).rows.find((x) => x.id === emp.id);
  assert.equal(await inMonth("2026-4"), false); // May — before joining
  assert.equal(await inMonth("2026-5"), true);  // June
  assert.equal(await inMonth("2026-6"), true);  // July — leaving month still included
  assert.equal(await inMonth("2026-7"), false); // August — gone
});

test("maker-checker: hr's sensitive changes wait for admin approval", async () => {
  await api("/api/users", { method: "POST", body: JSON.stringify({ username: "hrmaker", password: "Mk8rPass773", role: "hr" }) });
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ username: "hrmaker", password: "Mk8rPass773" }) });
  const hrCookie = login.headers.get("set-cookie").split(";")[0];
  const hrApi = (path, opts = {}) => fetch(`${base}${path}`, { ...opts, headers: { ...H, cookie: hrCookie, ...(opts.headers || {}) } });

  const emp = await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name: "MakerTest", salary: 12000, status: "Active" }) })).json();
  const full = (await (await api("/api/employees/" + emp.id)).json()).employee;

  // Non-sensitive edit by hr applies immediately
  const direct = await hrApi("/api/employees/" + emp.id, { method: "PUT", body: JSON.stringify({ ...full, phone: "9999" }) });
  assert.equal(direct.status, 200);

  // Salary change by hr is queued, not applied
  const q = await hrApi("/api/employees/" + emp.id, { method: "PUT", body: JSON.stringify({ ...full, phone: "9999", salary: 15000 }) });
  assert.equal(q.status, 202);
  assert.equal((await q.json()).queued, true);
  assert.equal((await (await api("/api/employees/" + emp.id)).json()).employee.salary, 12000);

  // hr cannot access the approvals API
  assert.equal((await hrApi("/api/approvals")).status, 403);

  // Admin approves → change applies (and lands in history)
  const list = await (await api("/api/approvals")).json();
  const pend = list.pending.find((p) => p.action === "employee.update" && p.entity_id === String(emp.id));
  assert.ok(pend, "queued employee update visible to admin");
  assert.equal((await api(`/api/approvals/${pend.id}/approve`, { method: "POST", body: "{}" })).status, 200);
  assert.equal((await (await api("/api/employees/" + emp.id)).json()).employee.salary, 15000);

  // hr advance is queued; admin rejects → nothing created
  const qa = await hrApi("/api/advances", { method: "POST", body: JSON.stringify({ empId: emp.id, amount: 3000, installment: 500 }) });
  assert.equal(qa.status, 202);
  const pend2 = (await (await api("/api/approvals")).json()).pending.find((p) => p.action === "advance.create");
  assert.ok(pend2);
  await api(`/api/approvals/${pend2.id}/reject`, { method: "POST", body: JSON.stringify({ note: "not needed" }) });
  const advs = (await (await api("/api/advances")).json()).advances;
  assert.ok(!advs.find((a) => a.empId === emp.id), "rejected advance was not created");
});

test("clearing a recovery override (null) reverts to the automatic amount — null is not coerced to 0", async () => {
  const mk = "2026-8";
  const emp = await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name: "OverrideTest", salary: 20000, status: "Active" }) })).json();
  const eid = emp.id;
  await api("/api/advances", { method: "POST", body: JSON.stringify({ empId: eid, amount: 3000, reason: "T", date: "01.09.2026" }) });
  const rec = async () => (await (await api(`/api/payroll/${mk}?basis=cal`)).json()).rows.find((x) => x.id === eid);

  assert.equal((await rec()).rec, 3000);        // booked automatically in September

  await api(`/api/payroll/${mk}/unpost/${eid}`, { method: "POST", body: JSON.stringify({ mode: "delete" }) });
  assert.equal((await rec()).rec, 0);           // overridden to zero — stays skipped

  // Emptying the override sends null. It must clear it (not become 0) → automatic again.
  await api(`/api/payroll/${mk}/${eid}`, { method: "PUT", body: JSON.stringify({ adv: null }) });
  const r = await rec();
  assert.deepEqual([r.rec, r.advPosted], [3000, true]);
});

test("auto week off: 4 a month, pro-rated + joining/leaving pro-rate pay", async () => {
  const mk = "2026-8"; // September 2026, 30 days
  const mkEmp = async (body) => (await (await api("/api/employees", { method: "POST", body: JSON.stringify({ salary: 30000, status: "Active", ...body }) })).json()).id;
  const full = await mkEmp({ name: "WO Full", joining: "01.01.2026" });
  const mid = await mkEmp({ name: "WO Joiner", joining: "16.09.2026" });
  const left = await mkEmp({ name: "WO Leaver", joining: "01.01.2026", leaving: "10.09.2026" });
  const get = async (id, m = mk) => (await (await api(`/api/payroll/${m}?basis=cal`)).json()).rows.find((r) => r.id === id);

  let r = await get(full);
  assert.deepEqual([r.wo, r.woSet, r.wd, r.earned], [4, false, 26, 30000]); // week off paid

  r = await get(mid);                       // employed 16–30 Sept = 15 days
  assert.deepEqual([r.availDays, r.wo, r.wd, r.earned], [15, 2, 13, 15000]);

  r = await get(left);                      // employed 1–10 Sept = 10 days
  assert.deepEqual([r.availDays, r.wo, r.wd, r.earned], [10, 1, 9, 10000]);

  // Leaves still reduce pay on top of the pro-ration
  await api(`/api/payroll/${mk}/${mid}`, { method: "PUT", body: JSON.stringify({ lv: 3 }) });
  r = await get(mid);
  assert.deepEqual([r.wo, r.wd, r.earned], [2, 10, 12000]);

  // A typed week off (even 0) wins; clearing it (null) returns to automatic
  await api(`/api/payroll/${mk}/${full}`, { method: "PUT", body: JSON.stringify({ wo: 0 }) });
  r = await get(full);
  assert.deepEqual([r.wo, r.woSet, r.wd], [0, true, 30]);
  await api(`/api/payroll/${mk}/${full}`, { method: "PUT", body: JSON.stringify({ wo: null }) });
  r = await get(full);
  assert.deepEqual([r.wo, r.woSet, r.wd], [4, false, 26]);

  // Applies to every month: July 2026 (31 days), joined 16th → 16 days employed
  const julyJoiner = await mkEmp({ name: "WO July", joining: "16.07.2026" });
  r = await get(julyJoiner, "2026-6");
  assert.deepEqual([r.availDays, r.wo, r.wd, r.earned], [16, 2, 14, 15484]);
});

test("employee ID (Petpooja ID): blank by default, editable, unique, set via emp-code", async () => {
  const mk = async (body) => (await api("/api/employees", { method: "POST", body: JSON.stringify({ salary: 1000, status: "Active", ...body }) }));
  const get = async (id) => (await (await api("/api/employees/" + id)).json()).employee;
  const setCode = (id, empCode) => api(`/api/employees/${id}/emp-code`, { method: "PUT", body: JSON.stringify({ empCode }) });

  const a = (await (await mk({ name: "PID A" })).json()).id;
  const b = (await (await mk({ name: "PID B" })).json()).id;
  assert.equal((await get(a)).empCode, "");                    // nothing invented

  // The attendance import saves the Petpooja ID; leading zeros are kept
  assert.equal((await setCode(a, "098")).status, 200);
  assert.equal((await get(a)).empCode, "098");

  // Duplicates are rejected — via emp-code, full edit and create
  let r = await setCode(b, "098");
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /already used by PID A/);
  r = await api("/api/employees/" + b, { method: "PUT", body: JSON.stringify({ ...(await get(b)), empCode: "098" }) });
  assert.equal(r.status, 400);
  assert.equal((await mk({ name: "PID Dup", empCode: "098" })).status, 400);

  // Editable by hand in the form, and can be cleared; two blanks never clash
  r = await api("/api/employees/" + b, { method: "PUT", body: JSON.stringify({ ...(await get(b)), empCode: "200" }) });
  assert.equal(r.status, 200);
  assert.equal((await get(b)).empCode, "200");
  assert.equal((await setCode(a, "")).status, 200);
  assert.equal((await setCode(b, "")).status, 200);
  assert.equal((await setCode(a, "bad id!")).status, 400);
});

test("automatic recovery (Oct 2026+): advance booked in its own month, no posting step", async () => {
  const mk = "2026-9"; // October 2026
  const eid = (await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name: "Auto Rec", salary: 14000, status: "Active", joining: "01.01.2026" }) })).json()).id;
  const row = async (m = mk) => (await (await api(`/api/payroll/${m}?basis=cal`)).json()).rows.find((r) => r.id === eid);
  const advOf = async (id) => (await (await api("/api/advances")).json()).advances.find((a) => a.id === id);

  // No installment → deducted in full from October, booked immediately
  const a1 = (await (await api("/api/advances", { method: "POST", body: JSON.stringify({ empId: eid, amount: 500, date: "31.10.2026" }) })).json()).id;
  let a = await advOf(a1);
  assert.deepEqual([a.recovered, a.balance, a.open], [500, 0, false]);
  let r = await row();
  assert.deepEqual([r.rec, r.advPosted, r.net], [500, true, 13500]);
  // September (before the automatic rule) is untouched
  assert.equal((await row("2026-8")).rec, 0);

  // Editing the amount re-books October
  const cur = await advOf(a1);
  await api(`/api/advances/${a1}`, { method: "PUT", body: JSON.stringify({ empId: eid, amount: 800, date: cur.date, reason: "", installment: 0 }) });
  a = await advOf(a1);
  assert.deepEqual([a.recovered, a.balance], [800, 0]);
  assert.equal((await row()).rec, 800);

  // Installment advance: only the installment comes off in October
  const a2 = (await (await api("/api/advances", { method: "POST", body: JSON.stringify({ empId: eid, amount: 3000, installment: 1000, date: "10.10.2026" }) })).json()).id;
  const oct = (await (await api(`/api/advances/${a2}/ledger`)).json()).payments.filter((p) => p.kind === "auto" && p.mk === mk);
  assert.equal(oct.reduce((s, p) => s + p.amount, 0), 1000);
  assert.equal((await row()).rec, 1800);   // 800 + 1000 installment

  // Deleting an advance takes its deduction back out of October
  await api(`/api/advances/${a1}`, { method: "DELETE" });
  assert.equal((await row()).rec, 1000);
});

test("no duplicate recoveries: repeated loads, ledger deletes, re-booking", async () => {
  const mk = "2026-9"; // October 2026
  const eid = (await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name: "Dup Guard", salary: 20000, status: "Active", joining: "01.01.2026" }) })).json()).id;
  const mkAdv = async (b) => (await (await api("/api/advances", { method: "POST", body: JSON.stringify({ empId: eid, ...b }) })).json()).id;
  const old = await mkAdv({ amount: 900 });                                     // undated, no installment
  const inst = await mkAdv({ amount: 3000, installment: 1000, date: "05.10.2026" });
  const full = await mkAdv({ amount: 500, date: "20.10.2026" });
  const ledger = async (id) => (await (await api(`/api/advances/${id}/ledger`)).json()).payments.filter((p) => p.kind === "auto");
  const octRec = async () => (await (await api(`/api/payroll/${mk}?basis=cal`)).json()).rows.find((r) => r.id === eid).rec;
  const perAdvMonth = async () => {
    const all = [...await ledger(old), ...await ledger(inst), ...await ledger(full)];
    const key = (p) => `${p.advance_id ?? ""}|${p.mk}|${p.amount}`;
    return { n: all.length, octTotal: all.filter((p) => p.mk === mk).reduce((t, p) => t + p.amount, 0), all };
  };

  // Many loads of Payroll and Advances never add a second booking
  for (let i = 0; i < 4; i++) { await octRec(); await api("/api/advances"); }
  assert.equal(await octRec(), 1500);                         // 1000 installment + 500 in full
  assert.equal((await ledger(inst)).filter((p) => p.mk === mk).length, 1);
  assert.equal((await ledger(full)).filter((p) => p.mk === mk).length, 1);
  assert.equal((await ledger(old)).length, 0);                // booked to the right advance, not the oldest

  // Deleting one booking from a ledger re-books the month from a clean slate — not on top
  const fp = (await ledger(full)).find((p) => p.mk === mk);
  await api(`/api/advances/${full}/payments/${fp.id}`, { method: "DELETE" });
  for (let i = 0; i < 3; i++) await octRec();
  assert.equal(await octRec(), 1500);
  assert.equal((await ledger(inst)).filter((p) => p.mk === mk).length, 1);
  assert.equal((await ledger(full)).filter((p) => p.mk === mk).length, 1);
  assert.equal((await perAdvMonth()).octTotal, 1500);

  // Editing an advance re-books without leftovers
  await api(`/api/advances/${full}`, { method: "PUT", body: JSON.stringify({ empId: eid, amount: 700, date: "20.10.2026", reason: "", installment: 0 }) });
  assert.equal(await octRec(), 1700);
  assert.equal((await perAdvMonth()).octTotal, 1700);
});

test("week-off bonus (Oct 2026+): unused week offs paid as WO Bonus; attendance absences → week offs first", async () => {
  const mk = "2026-9"; // October 2026; basis 30 → base 30 days
  const eid = (await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name: "WO Bonus", salary: 30000, status: "Active", joining: "01.01.2026" }) })).json()).id;
  const row = async (m = mk) => (await (await api(`/api/payroll/${m}?basis=30`)).json()).rows.find((r) => r.id === eid);
  const put = (body, m = mk) => api(`/api/payroll/${m}/${eid}`, { method: "PUT", body: JSON.stringify(body) });
  const pick = (r) => [r.wo, r.woUnused, r.wd, r.paidDays, r.earned, r.woBonus, r.net];

  // Automatic: all 4 week offs taken → no bonus
  assert.deepEqual(pick(await row()), [4, 0, 26, 30, 30000, 0, 30000]);

  // Only 1 of 4 taken → 3 unused → paid days 33, ₹3,000 WO bonus
  await put({ wo: 1 });
  assert.deepEqual(pick(await row()), [1, 3, 29, 33, 30000, 3000, 33000]);

  // Leaves still cut pay, bonus unchanged
  await put({ lv: 2 });
  assert.deepEqual(pick(await row()), [1, 3, 27, 31, 28000, 3000, 31000]);

  // Attendance: present 29 → 1 absence = 1 week off taken → 33 paid days
  await put({ wd: 29 });
  let r = await row();
  assert.deepEqual([r.wo, r.lv, r.woUnused, r.paidDays, r.earned, r.woBonus], [1, 0, 3, 33, 30000, 3000]);

  // Attendance: present 24 → 6 absences = 4 week offs + 2 leave → 28 paid days, no bonus
  await put({ wd: 24 });
  r = await row();
  assert.deepEqual([r.wo, r.lv, r.woUnused, r.paidDays, r.earned, r.woBonus], [4, 2, 0, 28, 28000, 0]);

  // September (before the rule): a typed 1 week off earns no bonus
  await put({ wo: 1 }, "2026-8");
  r = await row("2026-8");
  assert.deepEqual([r.woBonus, r.paidDays, r.earned], [0, 30, 30000]);
});

test("salary slips PDF: one A4 page per employee, in the requested order", async () => {
  const mk = "2026-9";
  const mkEmp = async (name) => (await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name, salary: 31000, status: "Active", joining: "01.01.2026" }) })).json()).id;
  const a = await mkEmp("PDF Slip A"), b = await mkEmp("PDF Slip B");
  const res = await api(`/api/payroll/${mk}/slips.pdf?basis=cal&ids=${b},${a}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="SalarySlips_October_2026\.pdf"/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  assert.equal((buf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 2);

  const one = await api(`/api/payroll/${mk}/slips.pdf?ids=${a}`);
  assert.equal(one.status, 200);
  assert.match(one.headers.get("content-disposition"), /SalarySlip_PDF_Slip_A_October_2026\.pdf/);
  assert.equal((await api(`/api/payroll/${mk}/slips.pdf?ids=999999`)).status, 404);
  assert.equal((await api(`/api/payroll/bad/slips.pdf`)).status, 400);
});
