/**
 * Adversarial test suite. Each test is an attack that MUST fail (or a control
 * that must succeed). Run: npm test
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.APP_ENC_KEY = crypto.randomBytes(32).toString("base64");
process.env.DB_FILE = ":memory:";
process.env.KYC_DIR = "./data/test-kyc";
process.env.NODE_ENV = "test";
process.env.LOGIN_RATE_MAX = "1000";
process.env.API_RATE_MAX = "100000";

const { createApp } = await import("../src/app.js");
const { openDb, getDb, closeDb } = await import("../src/db.js");
const { createUser } = await import("../src/auth.js");

let server, base;

before(async () => {
  openDb(":memory:");
  await createUser({ username: "admin", password: "Str0ngPass99", role: "admin" });
  await createUser({ username: "hruser", password: "Wq7mfPlz4821", role: "hr" });
  await createUser({ username: "viewer", password: "Zx4kLmn7391p", role: "viewer" });
  await new Promise((r) => { server = createApp().listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(() => { server?.close(); closeDb(); });
beforeEach(() => {
  // reset lockouts between tests
  try { getDb().prepare("UPDATE users SET failed_count=0, locked_until=NULL").run(); } catch {}
});

const H = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };

async function login(username, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: H, body: JSON.stringify({ username, password }),
  });
  const cookie = r.headers.get("set-cookie")?.split(";")[0];
  return { status: r.status, cookie, body: await r.json().catch(() => ({})) };
}

/* ---------------------------- authentication ---------------------------- */

test("valid login succeeds and returns role, not password", async () => {
  const r = await login("admin", "Str0ngPass99");
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, "admin");
  assert.ok(r.cookie.startsWith("yhr_session="));
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes("adminpass"));
});

test("session cookie is httpOnly, sameSite=strict", async () => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: H, body: JSON.stringify({ username: "admin", password: "Str0ngPass99" }),
  });
  const raw = r.headers.get("set-cookie");
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
});

test("wrong password is rejected", async () => {
  const r = await login("admin", "wrongpassword");
  assert.equal(r.status, 401);
});

test("unknown vs known username give an identical error (no user enumeration)", async () => {
  const a = await login("admin", "definitelywrong1");
  const b = await login("ghost", "definitelywrong1");
  assert.equal(a.body.error, b.body.error);
});

test("account locks after 5 failed attempts", async () => {
  for (let i = 0; i < 5; i++) await login("hruser", "badpassword" + i);
  const locked = await login("hruser", "Wq7mfPlz4821"); // correct pw, but locked
  assert.equal(locked.status, 401);
  assert.match(locked.body.error, /locked/i);
});

/* --------------------------- authorization ------------------------------ */

test("protected endpoint refuses anonymous access", async () => {
  const r = await fetch(`${base}/api/employees`, { headers: H });
  assert.equal(r.status, 401);
});

test("viewer CANNOT create an employee (RBAC)", async () => {
  const { cookie } = await login("viewer", "Zx4kLmn7391p");
  const r = await fetch(`${base}/api/employees`, {
    method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ name: "X" }),
  });
  assert.equal(r.status, 403);
});

test("hr CANNOT delete an employee (delete is admin-only)", async () => {
  const admin = await login("admin", "Str0ngPass99");
  const created = await fetch(`${base}/api/employees`, {
    method: "POST", headers: { ...H, cookie: admin.cookie }, body: JSON.stringify({ name: "Temp", salary: 1 }),
  });
  const { id } = await created.json();
  const hr = await login("hruser", "Wq7mfPlz4821");
  const del = await fetch(`${base}/api/employees/${id}`, { method: "DELETE", headers: { ...H, cookie: hr.cookie } });
  assert.equal(del.status, 403);
});

test("viewer does NOT receive decrypted bank account numbers", async () => {
  const admin = await login("admin", "Str0ngPass99");
  await fetch(`${base}/api/employees`, {
    method: "POST", headers: { ...H, cookie: admin.cookie },
    body: JSON.stringify({ name: "Bankty", salary: 5000, accNo: "123456789012", ifsc: "SBIN0001234" }),
  });
  const viewer = await login("viewer", "Zx4kLmn7391p");
  const list = await (await fetch(`${base}/api/employees`, { headers: { ...H, cookie: viewer.cookie } })).json();
  const row = list.employees.find((e) => e.name === "Bankty");
  assert.equal(row.accNo, undefined); // field omitted entirely
  const adminList = await (await fetch(`${base}/api/employees`, { headers: { ...H, cookie: admin.cookie } })).json();
  assert.equal(adminList.employees.find((e) => e.name === "Bankty").accNo, "123456789012");
});

/* ------------------------------- CSRF ----------------------------------- */

test("cross-origin POST is blocked", async () => {
  const { cookie } = await login("admin", "Str0ngPass99");
  const r = await fetch(`${base}/api/employees`, {
    method: "POST",
    headers: { ...H, cookie, Origin: "https://evil.example.com" },
    body: JSON.stringify({ name: "CSRF" }),
  });
  assert.equal(r.status, 403);
});

test("request without X-Requested-With is blocked", async () => {
  const { cookie } = await login("admin", "Str0ngPass99");
  const r = await fetch(`${base}/api/employees`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "NoHeader" }),
  });
  assert.equal(r.status, 403);
});

/* --------------------------- input validation --------------------------- */

test("invalid phone is rejected by schema", async () => {
  const { cookie } = await login("admin", "Str0ngPass99");
  const r = await fetch(`${base}/api/employees`, {
    method: "POST", headers: { ...H, cookie },
    body: JSON.stringify({ name: "Bad", phone: "<script>alert(1)</script>" }),
  });
  assert.equal(r.status, 400);
});

test("oversized JSON body is rejected", async () => {
  const { cookie } = await login("admin", "Str0ngPass99");
  const r = await fetch(`${base}/api/employees`, {
    method: "POST", headers: { ...H, cookie },
    body: JSON.stringify({ name: "A".repeat(300_000) }),
  });
  assert.ok(r.status === 400 || r.status === 413);
});

/* --------------------------- data at rest ------------------------------- */

test("bank account number is encrypted in the database, not plaintext", async () => {
  const { cookie } = await login("admin", "Str0ngPass99");
  await fetch(`${base}/api/employees`, {
    method: "POST", headers: { ...H, cookie },
    body: JSON.stringify({ name: "Secret", salary: 1, accNo: "999888777666", ifsc: "HDFC0000001" }),
  });
  const row = getDb().prepare("SELECT acc_no_enc FROM employees WHERE name='Secret'").get();
  assert.ok(row.acc_no_enc);
  assert.ok(!row.acc_no_enc.includes("999888777666")); // ciphertext, not the number
});

/* ------------------------------ headers --------------------------------- */

test("security headers are present", async () => {
  const r = await fetch(`${base}/api/health`, { headers: H });
  assert.ok(r.headers.get("content-security-policy"));
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-powered-by"), null);
});

test("server error does not leak internals", async () => {
  const r = await fetch(`${base}/api/employees/not-a-number`, { headers: H });
  const body = await r.json().catch(() => ({}));
  assert.ok(!JSON.stringify(body).match(/SQLITE|at Object|node:internal/));
});
