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

test("advance recovery: post reduces balance and net", async () => {
  // 6000 advance, 500/month installment
  const adv = await (await api("/api/advances", { method: "POST", body: JSON.stringify({ empId, amount: 6000, installment: 500, reason: "Medical", date: "01.07.2026" }) })).json();
  const mk = "2026-6"; // July 2026

  const before = await (await api(`/api/payroll/${mk}?basis=cal`)).json();
  const row = before.rows.find((r) => r.id === empId);
  assert.equal(row.rec, 500);            // scheduled recovery shows
  assert.equal(row.earned, 14000);       // full month
  assert.equal(row.net, 13500);          // 14000 - 500
  assert.equal(before.pending, 1);

  await api(`/api/payroll/${mk}/post-recoveries`, { method: "POST", body: "{}" });
  const led = await (await api(`/api/advances/${adv.id}/ledger`)).json();
  assert.equal(led.advance.balance, 5500);
  assert.equal(led.payments.filter((p) => p.kind === "auto").length, 1);

  const after = await (await api(`/api/payroll/${mk}?basis=cal`)).json();
  assert.equal(after.rows.find((r) => r.id === empId).advPosted, true);
  assert.equal(after.pending, 0);
});

test("advance recovery: unpost restores balance", async () => {
  const mk = "2026-6";
  await api(`/api/payroll/${mk}/unpost/${empId}`, { method: "POST", body: JSON.stringify({ mode: "delete" }) });
  const advs = await (await api("/api/advances")).json();
  const a = advs.advances.find((x) => x.empId === empId);
  assert.equal(a.balance, 6000); // fully restored
  const after = await (await api(`/api/payroll/${mk}?basis=cal`)).json();
  assert.equal(after.rows.find((r) => r.id === empId).net, 14000);
});

test("manual repayment reduces balance; deleting it restores", async () => {
  const advs = await (await api("/api/advances")).json();
  const a = advs.advances.find((x) => x.empId === empId);
  const pay = await (await api(`/api/advances/${a.id}/payments`, { method: "POST", body: JSON.stringify({ amount: 1000, note: "Cash", date: "05.07.2026" }) })).json();
  assert.equal(pay.balance, 5000);
  const led = await (await api(`/api/advances/${a.id}/ledger`)).json();
  const manual = led.payments.find((p) => p.kind === "manual");
  const del = await (await api(`/api/advances/${a.id}/payments/${manual.id}`, { method: "DELETE" })).json();
  assert.equal(del.balance, 6000);
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

test("clearing a recovery override (null) reverts to scheduled — null is not coerced to 0", async () => {
  const mk = "2026-8";
  const emp = await (await api("/api/employees", { method: "POST", body: JSON.stringify({ name: "OverrideTest", salary: 20000, status: "Active" }) })).json();
  const eid = emp.id;
  await api("/api/advances", { method: "POST", body: JSON.stringify({ empId: eid, amount: 3000, installment: 1000, reason: "T", date: "01.09.2026" }) });
  const rec = async () => (await (await api(`/api/payroll/${mk}?basis=cal`)).json()).rows.find((x) => x.id === eid);

  assert.equal((await rec()).rec, 1000);        // scheduled recovery from the installment

  await api(`/api/payroll/${mk}/${eid}`, { method: "PUT", body: JSON.stringify({ adv: 0 }) });
  assert.equal((await rec()).rec, 0);           // overridden to zero

  // Emptying the box sends null. It must clear the override, not get coerced to 0.
  await api(`/api/payroll/${mk}/${eid}`, { method: "PUT", body: JSON.stringify({ adv: null }) });
  const r = await rec();
  assert.equal(r.advOverride, null);            // override actually cleared
  assert.equal(r.rec, 1000);                    // and recovery is back to scheduled
});
