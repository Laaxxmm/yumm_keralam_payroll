"use strict";
/* Yumm HR — API-driven frontend. No inline scripts/handlers (strict CSP). */

const $ = (id) => document.getElementById(id);
const el = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function toast(msg, isErr) {
  const t = $("toast"); t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = "toast"), 2200);
}

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const headers = { "X-Requested-With": "XMLHttpRequest" };
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  const res = await fetch(path, { method: opts.method || "GET", headers, body, credentials: "same-origin" });
  if (res.status === 401 && !path.includes("/auth/")) { showLogin(); throw { status: 401, error: "Session expired." }; }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => ({})) : await res.blob();
  if (!res.ok) throw { status: res.status, error: (data && data.error) || "Request failed." };
  return data;
}

const state = { user: null, employees: [], advances: [], company: {}, kycCounts: {},
  empSort: { k: "name", d: 1 }, empExtra: null, basis: "cal" };

/* ---------------- Auth ---------------- */
function showLogin() { $("appRoot").hidden = true; $("authScreen").style.display = "flex"; setTimeout(() => $("auUser").focus(), 50); }
function showApp() {
  $("authScreen").style.display = "none"; $("appRoot").hidden = false;
  $("whoami").textContent = state.user.username;
  $("roleChip").textContent = state.user.role;
  document.body.className = "role-" + state.user.role;
  switchTab("dash");
}

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("authErr").textContent = "";
  try {
    const r = await api("/api/auth/login", { method: "POST",
      body: { username: $("auUser").value.trim(), password: $("auPass").value, remember: $("auRemember").checked } });
    state.user = r.user; $("auPass").value = ""; showApp();
  } catch (err) { $("authErr").textContent = err.error || "Login failed."; }
});
$("btnLock").addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch {} state.user = null; showLogin(); });

/* ---------------- Tabs ---------------- */
$("tabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) switchTab(t.dataset.tab); });
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  ["dash","emp","pay","adv","cmp","usr"].forEach((v) => ($("view-" + v).hidden = v !== tab));
  ({ dash: renderDashboard, emp: loadEmployees, pay: renderPayroll, adv: loadAdvances, cmp: loadCompany, usr: loadUsers }[tab] || (() => {}))();
}
const canWrite = () => state.user && (state.user.role === "admin" || state.user.role === "hr");
const isAdmin = () => state.user && state.user.role === "admin";

/* ---------------- Modal ---------------- */
function openModal(html) { $("modalCard").innerHTML = html; $("modal").classList.add("show"); }
function closeModal() { $("modal").classList.remove("show"); $("modalCard").innerHTML = ""; }
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

/* ================= EMPLOYEES ================= */
async function loadEmployees() {
  try {
    const [{ employees }, { counts }] = await Promise.all([api("/api/employees"), api("/api/kyc/counts/all")]);
    state.employees = employees; state.kycCounts = counts || {};
    fillEmpFilters(); renderEmp();
  } catch (e) { toast(e.error, true); }
}
function uniq(key) { return [...new Set(state.employees.map((e) => e[key]).filter(Boolean))].sort(); }
function fillEmpFilters() {
  const setOpts = (id, arr, all) => { const s = $(id), cur = s.value;
    s.innerHTML = `<option value="">${all}</option>` + arr.map((v) => `<option>${esc(v)}</option>`).join("");
    if ([...s.options].some((o) => o.value === cur)) s.value = cur; };
  setOpts("empLoc", uniq("loc"), "All Locations");
  setOpts("empDesig", uniq("desig"), "All Designations");
}
["empSearch","empLoc","empDesig","empStatus"].forEach((id) => $(id).addEventListener("input", renderEmp));
document.querySelector("#view-emp thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]"); if (!th) return;
  const k = th.dataset.sort; if (state.empSort.k === k) state.empSort.d *= -1; else state.empSort = { k, d: 1 };
  renderEmp();
});
function filteredEmp() {
  const q = $("empSearch").value.trim().toLowerCase(), loc = $("empLoc").value, des = $("empDesig").value, st = $("empStatus").value;
  let list = state.employees.filter((e) => {
    if (loc && e.loc !== loc) return false; if (des && e.desig !== des) return false;
    if (st && (e.status || "Active") !== st) return false;
    if (state.empExtra && !state.empExtra.test(e)) return false;
    if (q && !(`${e.name} ${e.desig} ${e.loc} ${e.phone || ""}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const { k, d } = state.empSort;
  list.sort((a, b) => k === "salary" ? (a.salary - b.salary) * d
    : String(a[k]).localeCompare(String(b[k]), undefined, { numeric: true }) * d);
  return list;
}
function renderEmp() {
  const list = filteredEmp(), body = $("empBody"), w = canWrite(), del = isAdmin();
  body.innerHTML = list.length ? list.map((e) => {
    const inactive = (e.status || "Active") === "Inactive";
    const cnt = state.kycCounts[e.id];
    return `<tr>
      <td><strong>${esc(e.name)}</strong>${cnt ? ` <span class="chip">📎${cnt}</span>` : ""}</td>
      <td><span class="chip">${esc(e.desig || "—")}</span></td>
      <td><span class="chip loc">${esc(e.loc || "—")}</span></td>
      <td>${esc(e.joining || "—")}</td><td class="num">${fmt(e.salary)}</td><td>${esc(e.phone || "—")}</td>
      <td><span class="badge ${inactive ? "inactive" : "active"}" ${w ? `data-act="togglestatus" data-id="${e.id}"` : ""}>${inactive ? "Inactive" : "Active"}</span></td>
      <td><div class="rowbtns">
        <button class="icon-btn" data-act="kyc" data-id="${e.id}" title="KYC documents">📎</button>
        <button class="icon-btn" data-act="report" data-id="${e.id}" title="Reports">📄</button>
        ${w ? `<button class="icon-btn" data-act="edit" data-id="${e.id}" title="Edit">✎</button>` : ""}
        ${del ? `<button class="icon-btn del" data-act="del" data-id="${e.id}" title="Delete">🗑</button>` : ""}
      </div></td></tr>`;
  }).join("") : `<tr><td colspan="8" class="empty">No employees match.</td></tr>`;
  document.querySelectorAll("#view-emp thead th").forEach((th) =>
    th.classList.toggle("sorted", th.dataset.sort === state.empSort.k));
}
$("empBody").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const id = Number(b.dataset.id);
  ({ edit: () => empModal(id), del: () => delEmp(id), kyc: () => kycModal(id), report: () => reportModal(id),
     togglestatus: () => toggleStatus(id) }[b.dataset.act] || (() => {}))();
});
$("btnAddEmp").addEventListener("click", () => empModal(null));

const EMP_FIELDS = [
  ["name","Name *","full"],["desig","Designation"],["loc","Location"],["joining","Joining (dd.mm.yyyy)"],
  ["salary","Monthly Salary (₹)","","number"],["phone","Phone"],["status","Status","","status"],
  ["__s1","Report details","sechead"],
  ["fatherName","Father's Name"],["dob","Date of Birth"],["address","Full Address","full"],
  ["qualGen","Qualification — General"],["qualTech","Qualification — Technical"],["experience","Experience","full"],
  ["langRead","Read"],["langWrite","Write"],["langSpeak","Speak"],["reportTime","Report Time (A.M.)"],
  ["hobbies","Hobbies","full"],["documents","List of Documents","full"],
  ["__s2","Bank / Payment details","sechead"],
  ["bankName","Bank Name"],["accName","Account Holder"],["accNo","Account Number","","number"],
  ["ifsc","IFSC Code"],["branch","Branch"],["upi","UPI ID"],
];
function empModal(id) {
  const e = id ? state.employees.find((x) => x.id === id) : {};
  const fields = EMP_FIELDS.map((f) => {
    const [k, label, cls, type] = f;
    if (cls === "sechead") return `<div class="sechead">${label}</div>`;
    if (type === "status") return `<div class="fld"><label>Status</label><select id="f_status"><option ${e.status !== "Inactive" ? "selected" : ""}>Active</option><option ${e.status === "Inactive" ? "selected" : ""}>Inactive</option></select></div>`;
    const v = e[k] != null ? esc(e[k]) : "";
    return `<div class="fld ${cls === "full" ? "full" : ""}"><label>${esc(label)}</label><input id="f_${k}" ${type === "number" ? 'type="number" min="0"' : ""} value="${v}"></div>`;
  }).join("");
  openModal(`<h3>${id ? "Edit" : "Add"} Employee</h3><div class="body">${fields}</div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mSave">Save</button></div>`);
  wireClose();
  $("mSave").addEventListener("click", async () => {
    const payload = {}; EMP_FIELDS.forEach(([k, , cls, type]) => {
      if (cls === "sechead") return;
      if (type === "status") { payload.status = $("f_status").value; return; }
      payload[k] = type === "number" ? Number($("f_" + k).value || 0) : $("f_" + k).value;
    });
    if (!payload.name.trim()) return toast("Name is required", true);
    try {
      if (id) await api("/api/employees/" + id, { method: "PUT", body: payload });
      else await api("/api/employees", { method: "POST", body: payload });
      closeModal(); toast("Saved"); loadEmployees();
    } catch (err) { toast(err.error, true); }
  });
}
async function delEmp(id) {
  const e = state.employees.find((x) => x.id === id);
  if (!confirm(`Delete ${e.name}? This also removes their advances and KYC files.`)) return;
  try { await api("/api/employees/" + id, { method: "DELETE" }); toast("Deleted"); loadEmployees(); }
  catch (err) { toast(err.error, true); }
}
async function toggleStatus(id) {
  const e = state.employees.find((x) => x.id === id);
  const next = (e.status || "Active") === "Inactive" ? "Active" : "Inactive";
  try { await api("/api/employees/" + id, { method: "PUT", body: { ...e, status: next } }); loadEmployees(); }
  catch (err) { toast(err.error, true); }
}
function empExportRows() {
  const cols = [["name","Name"],["desig","Designation"],["loc","Location"],["status","Status"],["joining","Joining"],
    ["salary","Salary"],["phone","Phone"],["bankName","Bank"],["accName","Acc Holder"],["accNo","Account No"],["ifsc","IFSC"],["upi","UPI"]];
  const rows = [cols.map((c) => c[1])];
  filteredEmp().forEach((e) => rows.push(cols.map((c) => (e[c[0]] == null ? "" : e[c[0]]))));
  return rows;
}
$("btnExportEmp").addEventListener("click", () => downloadCSV("Employees.csv", empExportRows()));
$("btnExportEmpXlsx").addEventListener("click", () => downloadXLSX("Employees.xlsx", "Employees", empExportRows()));

/* ================= KYC ================= */
async function kycModal(empId) {
  const e = state.employees.find((x) => x.id === empId);
  openModal(`<h3>KYC Documents — ${esc(e.name)}</h3><div style="padding:16px 20px" id="kycArea">Loading…</div>
    <div class="foot"><button class="btn ghost" data-close>Close</button></div>`); wireClose();
  renderKyc(empId);
}
async function renderKyc(empId) {
  const area = $("kycArea"); if (!area) return;
  const { files } = await api("/api/kyc/" + empId);
  const w = canWrite();
  const types = ["PAN Card","Aadhaar Card","Voter ID","Driving License","Passport","Bank Passbook / Cheque","Photo","Appointment Letter","Other"];
  area.innerHTML = `${w ? `<div class="toolbar"><select id="kType" style="min-width:150px">${types.map((t) => `<option>${t}</option>`).join("")}</select>
      <input type="file" id="kFile" accept="image/*,application/pdf" style="flex:1"><button class="btn primary" id="kUp">⬆ Upload</button></div>` : ""}
    <div id="kList">${files.length ? files.map((f) => `<div class="kyc-item"><div style="font-size:20px">${f.mime.includes("pdf") ? "📄" : "🖼️"}</div>
      <div class="kt"><b>${esc(f.doc_type)}</b><span>${esc(f.file_name)} · ${(f.size / 1024).toFixed(0)} KB · ${esc((f.uploaded_at || "").slice(0, 10))}</span></div>
      <button class="icon-btn" data-view="${f.id}" title="Download">⬇</button>${w ? `<button class="icon-btn del" data-del="${f.id}" title="Delete">🗑</button>` : ""}</div>`).join("") : '<div class="hint">No documents yet.</div>'}</div>`;
  if (w) {
    $("kUp").addEventListener("click", async () => {
      const file = $("kFile").files[0]; if (!file) return toast("Choose a file", true);
      const fd = new FormData(); fd.append("docType", $("kType").value); fd.append("file", file);
      try { await api("/api/kyc/" + empId, { method: "POST", body: fd }); toast("Uploaded"); renderKyc(empId); loadCounts(); }
      catch (err) { toast(err.error, true); }
    });
  }
  area.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => downloadKyc(b.dataset.view)));
  area.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this document?")) return;
    try { await api("/api/kyc/file/" + b.dataset.del, { method: "DELETE" }); renderKyc(empId); loadCounts(); } catch (e) { toast(e.error, true); }
  }));
}
async function downloadKyc(id) {
  try {
    const blob = await api("/api/kyc/file/" + id);
    const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = "kyc-document"; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  } catch (e) { toast(e.error, true); }
}
async function loadCounts() { try { const { counts } = await api("/api/kyc/counts/all"); state.kycCounts = counts || {}; renderEmp(); } catch {} }

/* ================= REPORTS ================= */
async function reportModal(empId) {
  openModal(`<h3>Reports</h3><div style="padding:16px 20px;display:flex;flex-direction:column;gap:10px">
    <button class="btn primary" id="rBio">📄 Download Bio-Data (Word)</button>
    <button class="btn primary" id="rJoin">📝 Download Joining Report (Word)</button>
    <div class="hint">Files open in MS Word with the company letterhead.</div></div>
    <div class="foot"><button class="btn ghost" data-close>Close</button></div>`); wireClose();
  const e = await (await api("/api/employees/" + empId)).employee;
  const c = state.company;
  $("rBio").addEventListener("click", () => downloadDoc("BioData_" + safe(e.name), bioHtml(e, c)));
  $("rJoin").addEventListener("click", () => downloadDoc("JoiningReport_" + safe(e.name), joinHtml(e, c)));
}
const safe = (n) => String(n).replace(/[^\w]+/g, "_");
function letterhead(c) {
  const logo = c.logo ? `<img src="${c.logo}" width="92" height="92" style="border-radius:10px">` : "";
  const line = [c.addr1, c.addr2].filter(Boolean).join(", ");
  const place = [c.city, c.state].filter(Boolean).join(", ") + (c.pincode ? " – " + c.pincode : "");
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:6px"><tr>
    <td style="border:none;width:108px">${logo}</td>
    <td style="border:none;text-align:right">
      <div style="font-size:22pt;font-weight:bold;color:#2f6b1e">${esc(c.name || "")}</div>
      ${c.tagline ? `<div style="font-size:9pt;letter-spacing:2px;color:#c8791a;font-weight:bold">${esc(c.tagline)}</div>` : ""}
      ${line ? `<div style="font-size:10.5pt">${esc(line)}</div>` : ""}
      <div style="font-size:10.5pt">${esc(place)}</div>
      <div style="font-size:10pt">${c.mobile ? "Mobile: " + esc(c.mobile) : ""} ${c.email ? " | Email: " + esc(c.email) : ""}</div>
      <div style="font-size:10pt">${c.gstin ? "GSTIN: " + esc(c.gstin) : ""} ${c.pan ? " | PAN: " + esc(c.pan) : ""}</div>
    </td></tr></table><hr style="border:none;border-top:2.5px solid #2f6b1e;margin:0 0 14px">`;
}
function docWrap(inner, c) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8">
    <style>@page{margin:2cm}body{font-family:'Times New Roman',serif;font-size:13pt}table{border-collapse:collapse;width:100%}td{border:1px solid #000;padding:6px 9px}h2{text-align:center;letter-spacing:2px}.lbl{width:40%;font-weight:bold}</style></head>
    <body>${letterhead(c)}${inner}</body></html>`;
}
function bioHtml(e, c) {
  const row = (l, v) => `<tr><td class="lbl">${l}</td><td>${esc(v || "")}</td></tr>`;
  return docWrap(`<p>To,</p><p>&nbsp;</p><p>Respected Sir,</p>
    <p><b>SUB: APPLICATION FOR THE POST OF ${esc((e.desig || "").toUpperCase())}</b></p>
    <p>I offer myself as a candidate for a suitable job and furnish the following Bio-data for your consideration.</p>
    <h2>BIO-DATA</h2><table>
    ${row("Name", e.name)}${row("Father's Name", e.fatherName)}${row("Full Address", e.address)}${row("Phone Number", e.phone)}
    ${row("Date Of Birth", e.dob)}${row("Qualification (General / Technical)", (e.qualGen || "") + " / " + (e.qualTech || ""))}
    ${row("Experience", e.experience)}${row("Languages (R/W/S)", [e.langRead, e.langWrite, e.langSpeak].filter(Boolean).join(" / "))}
    ${row("Hobbies", e.hobbies)}${row("Date Of Joining", e.joining)}${row("List of Documents", e.documents)}</table>
    <p>Kindly consider my application sympathetically.</p><p>Thanking you,</p>
    <p style="margin-top:26px">Yours faithfully,</p><p><b>${esc(e.name)}</b></p>`, c);
}
function joinHtml(e, c) {
  const org = c.name || "the Company", place = [c.name, c.city].filter(Boolean).join(", ");
  return docWrap(`<h2>Joining Report</h2><p>Date: ${esc(e.joining || "____________")}</p>
    <p style="margin-top:20px">I, <b>${esc(e.name)}</b> have joined <b>${esc(org)}</b> as <b>${esc(e.desig || "____________")}</b>
    and have reported for duty at ${esc(place)} at ${esc(e.reportTime || "________")} A.M.</p>
    <p style="margin-top:60px">Signature</p><p style="margin-top:24px">Name : ${esc(e.name)}</p><p>Address: ${esc(e.address || "")}</p>`, c);
}
function downloadDoc(name, html) {
  const bnd = "----=_YHR";
  const mht = ["MIME-Version: 1.0", `Content-Type: multipart/related; boundary="${bnd}"`, "", "--" + bnd,
    'Content-Type: text/html; charset="utf-8"', "Content-Transfer-Encoding: base64", "", btoa(unescape(encodeURIComponent(html))).replace(/(.{76})/g, "$1\r\n"), "--" + bnd + "--", ""].join("\r\n");
  const u = URL.createObjectURL(new Blob([mht], { type: "application/msword" }));
  const a = document.createElement("a"); a.href = u; a.download = name + ".doc"; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000);
  toast("Downloaded");
}

/* ================= PAYROLL ================= */
function initPayControls() {
  if ($("payMonth").options.length) return;
  const now = new Date();
  $("payMonth").innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("");
  let y = "", y0 = now.getFullYear(); for (let i = y0 + 1; i >= y0 - 3; i--) y += `<option>${i}</option>`;
  $("payYear").innerHTML = y; $("payMonth").value = now.getMonth(); $("payYear").value = y0;
  $("payMonth").addEventListener("change", renderPayroll);
  $("payYear").addEventListener("change", renderPayroll);
  $("basisGroup").addEventListener("click", (e) => { const p = e.target.closest(".pill"); if (!p) return;
    state.basis = p.dataset.b; document.querySelectorAll("#basisGroup .pill").forEach((x) => x.classList.toggle("active", x === p)); renderPayroll(); });
  $("btnPostRec").addEventListener("click", postRecoveries);
  $("btnExportPay").addEventListener("click", () => { if (payData) downloadCSV(payFileBase() + ".csv", payExportRows()); });
  $("btnExportPayXlsx").addEventListener("click", () => { if (payData) downloadXLSX(payFileBase() + ".xlsx", "Payroll", payExportRows()); });
}
let payData = null;
const mk = () => `${$("payYear").value}-${$("payMonth").value}`;
async function renderPayroll() {
  initPayControls();
  try {
    payData = await api(`/api/payroll/${mk()}?basis=${state.basis}`);
  } catch (e) { return toast(e.error, true); }
  const w = canWrite();
  $("basisNote").innerHTML = `Earned = Salary ÷ <b>${payData.baseDays}</b> × Working Days. Only Active employees shown.`;
  $("recBanner").innerHTML = payData.pending && w
    ? `<div style="background:rgba(255,176,61,.1);border:1px solid #4a3a20;color:var(--brand2);padding:9px 13px;border-radius:8px;margin-bottom:12px">⚠ ${payData.pending} recovery(ies) not yet posted. <button class="btn sm" id="bannerPost">Post Recoveries</button></div>` : "";
  if ($("bannerPost")) $("bannerPost").addEventListener("click", postRecoveries);
  $("payBody").innerHTML = payData.rows.map((r) => {
    const recCell = r.advPosted
      ? `<span style="color:var(--green)">${fmt(r.rec)} ✓</span>${w ? ` <button class="icon-btn rec-btn" data-unpost="${r.id}" data-mode="edit" title="Edit">✎</button><button class="icon-btn del rec-btn" data-unpost="${r.id}" data-mode="delete" title="Delete">🗑</button>` : ""}`
      : w ? `<input class="adj-input" type="number" min="0" value="${r.advOverride != null ? r.advOverride : ""}" placeholder="${r.rec}" data-adj="adv" data-id="${r.id}">` : fmt(r.rec);
    return `<tr>
      <td><strong>${esc(r.name)}</strong></td><td><span class="chip">${esc(r.desig || "—")}</span></td><td><span class="chip loc">${esc(r.loc || "—")}</span></td>
      <td class="num">${fmt(r.salary)}</td>
      <td class="num">${w ? `<input class="wd-input" type="number" min="0" value="${r.wd}" data-adj="wd" data-id="${r.id}">` : r.wd}</td>
      <td class="num">${fmt(r.earned)}</td>
      <td class="num">${w ? `<input class="adj-input" type="number" min="0" value="${r.bonus || ""}" placeholder="0" data-adj="bonus" data-id="${r.id}">` : fmt(r.bonus)}</td>
      <td class="num">${w ? `<input class="adj-input" type="number" min="0" value="${r.ded || ""}" placeholder="0" data-adj="ded" data-id="${r.id}">` : fmt(r.ded)}</td>
      <td class="num">${recCell}</td><td class="num net">${fmt(r.net)}</td></tr>`;
  }).join("") || `<tr><td colspan="10" class="empty">No active employees.</td></tr>`;
  const t = payData.totals;
  $("payFoot").innerHTML = payData.rows.length ? `<tr><td colspan="5">TOTAL — ${payData.rows.length} employees</td>
    <td class="num">${fmt(t.earned)}</td><td class="num">${fmt(t.bonus)}</td><td class="num">${fmt(t.ded)}</td><td class="num">${fmt(t.rec)}</td><td class="num net">${fmt(t.net)}</td></tr>` : "";
}
$("payBody").addEventListener("change", async (e) => {
  const inp = e.target.closest("[data-adj]"); if (!inp) return;
  const field = inp.dataset.adj, id = Number(inp.dataset.id);
  const val = inp.value === "" ? (field === "wd" || field === "adv" ? null : 0) : Math.max(0, Number(inp.value));
  try { await api(`/api/payroll/${mk()}/${id}`, { method: "PUT", body: { [field]: val } }); renderPayroll(); }
  catch (err) { toast(err.error, true); }
});
$("payBody").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-unpost]"); if (!b) return;
  const mode = b.dataset.mode;
  if (!confirm(mode === "delete" ? "Delete this recovery? The amount returns to the balance." : "Un-post to edit? The amount returns to the balance.")) return;
  try { await api(`/api/payroll/${mk()}/unpost/${b.dataset.unpost}`, { method: "POST", body: { mode } }); toast("Done"); renderPayroll(); }
  catch (err) { toast(err.error, true); }
});
async function postRecoveries() {
  try { const r = await api(`/api/payroll/${mk()}/post-recoveries`, { method: "POST", body: {} });
    toast(r.posted ? `Posted for ${r.posted} employee(s)` : "Nothing to post — set installments"); renderPayroll(); }
  catch (e) { toast(e.error, true); }
}
function payExportRows() {
  const rows = [["Name","Designation","Loc","Salary","Work Days","Earned","Bonus","Other Ded.","Adv. Recovery","Net"]];
  if (payData) payData.rows.forEach((r) => rows.push([r.name, r.desig, r.loc, r.salary, r.wd, r.earned, r.bonus, r.ded, r.rec, r.net]));
  return rows;
}
function payFileBase() { return `Payroll_${MONTHS[+$("payMonth").value]}_${$("payYear").value}`; }

/* ================= ADVANCES ================= */
async function loadAdvances() {
  try { state.advances = (await api("/api/advances")).advances; if (!state.employees.length) state.employees = (await api("/api/employees")).employees; renderAdv(); }
  catch (e) { toast(e.error, true); }
}
["advSearch","advStatus"].forEach((id) => $(id).addEventListener("input", renderAdv));
function empName(id) { const e = state.employees.find((x) => x.id === id); return e ? e.name : "(deleted)"; }
function empLocOf(id) { const e = state.employees.find((x) => x.id === id); return e ? e.loc : ""; }
function renderAdv() {
  const q = $("advSearch").value.trim().toLowerCase(), st = $("advStatus").value, w = canWrite();
  const list = state.advances.filter((a) => {
    if (st === "open" && !a.open) return false; if (st === "closed" && a.open) return false;
    if (q && !(`${empName(a.empId)} ${a.reason}`.toLowerCase().includes(q))) return false; return true;
  });
  $("advBody").innerHTML = list.length ? list.map((a) => `<tr>
    <td><strong>${esc(empName(a.empId))}</strong> <span class="chip loc">${esc(empLocOf(a.empId) || "—")}</span></td>
    <td>${esc(a.date || "—")}</td><td class="num">${fmt(a.amount)}</td><td>${esc(a.reason || "—")}</td>
    <td class="num">${a.installment ? fmt(a.installment) : "—"}</td><td class="num">${fmt(a.recovered)}</td>
    <td class="num" style="font-weight:700;color:${a.open ? "var(--brand2)" : "var(--green)"}">${fmt(a.balance)}</td>
    <td><span class="badge ${a.open ? "inactive" : "active"}">${a.open ? "Open" : "Closed"}</span></td>
    <td><div class="rowbtns"><button class="icon-btn" data-ledger="${a.id}" title="Ledger">📒</button>
      ${w ? `<button class="icon-btn" data-edit="${a.id}" title="Edit">✎</button><button class="icon-btn del" data-del="${a.id}" title="Delete">🗑</button>` : ""}</div></td></tr>`).join("")
    : `<tr><td colspan="9" class="empty">No advances.</td></tr>`;
  const out = state.advances.reduce((s, a) => s + a.balance, 0);
  document.querySelector("#view-adv .cards").innerHTML = `
    <div class="card"><div class="k">Outstanding</div><div class="v small" style="color:var(--brand2)">${fmt(out)}</div></div>
    <div class="card"><div class="k">Open Advances</div><div class="v">${state.advances.filter((a) => a.open).length}</div></div>
    <div class="card"><div class="k">Total Issued</div><div class="v small">${fmt(state.advances.reduce((s, a) => s + a.amount, 0))}</div></div>
    <div class="card"><div class="k">Recovered</div><div class="v small" style="color:var(--green)">${fmt(state.advances.reduce((s, a) => s + a.recovered, 0))}</div></div>`;
}
$("advBody").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ledger],[data-edit],[data-del]"); if (!b) return;
  if (b.dataset.ledger) ledgerModal(Number(b.dataset.ledger));
  else if (b.dataset.edit) advModal(Number(b.dataset.edit));
  else if (b.dataset.del) delAdv(Number(b.dataset.del));
});
function advExportRows() {
  const rows = [["Employee","Location","Date","Amount","Reason","Installment/mo","Recovered","Balance","Status"]];
  state.advances.forEach((a) => rows.push([empName(a.empId), empLocOf(a.empId), a.date, a.amount, a.reason, a.installment, a.recovered, a.balance, a.open ? "Open" : "Closed"]));
  return rows;
}
$("btnExportAdv").addEventListener("click", () => downloadCSV("Advances.csv", advExportRows()));
$("btnExportAdvXlsx").addEventListener("click", () => downloadXLSX("Advances.xlsx", "Advances", advExportRows()));
$("btnAddAdv").addEventListener("click", () => advModal(null));
function advModal(id) {
  const a = id ? state.advances.find((x) => x.id === id) : {};
  const emps = [...state.employees].sort((x, y) => x.name.localeCompare(y.name));
  openModal(`<h3>${id ? "Edit" : "Issue"} Advance</h3><div class="body">
    <div class="fld full"><label>Employee *</label><select id="a_emp">${emps.map((e) => `<option value="${e.id}" ${a.empId === e.id ? "selected" : ""}>${esc(e.name)} — ${esc(e.desig || "")} (${esc(e.loc || "")})</option>`).join("")}</select></div>
    <div class="fld"><label>Date</label><input id="a_date" value="${esc(a.date || todayStr())}"></div>
    <div class="fld"><label>Amount (₹) *</label><input id="a_amount" type="number" min="0" value="${a.amount || ""}"></div>
    <div class="fld full"><label>Reason</label><input id="a_reason" value="${esc(a.reason || "")}"></div>
    <div class="fld"><label>Monthly Installment (₹)</label><input id="a_inst" type="number" min="0" value="${a.installment || ""}"></div></div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mSave">Save</button></div>`); wireClose();
  $("mSave").addEventListener("click", async () => {
    const body = { empId: Number($("a_emp").value), date: $("a_date").value, amount: Number($("a_amount").value || 0), reason: $("a_reason").value, installment: Number($("a_inst").value || 0) };
    if (body.amount <= 0) return toast("Enter an amount", true);
    try { if (id) await api("/api/advances/" + id, { method: "PUT", body }); else await api("/api/advances", { method: "POST", body });
      closeModal(); toast("Saved"); loadAdvances(); } catch (err) { toast(err.error, true); }
  });
}
async function delAdv(id) { if (!confirm("Delete this advance and its history?")) return;
  try { await api("/api/advances/" + id, { method: "DELETE" }); toast("Deleted"); loadAdvances(); } catch (e) { toast(e.error, true); } }
async function ledgerModal(id) {
  const w = canWrite();
  openModal(`<h3>Advance Ledger</h3><div style="padding:16px 20px" id="ledgerArea">Loading…</div><div class="foot"><button class="btn ghost" data-close>Close</button></div>`); wireClose();
  await renderLedger(id, w);
}
async function renderLedger(id, w) {
  const { advance, payments } = await api("/api/advances/" + id + "/ledger");
  $("ledgerArea").innerHTML = `<div class="cards">
      <div class="card"><div class="k">Advance</div><div class="v small">${fmt(advance.amount)}</div></div>
      <div class="card"><div class="k">Recovered</div><div class="v small" style="color:var(--green)">${fmt(advance.recovered)}</div></div>
      <div class="card"><div class="k">Balance</div><div class="v small" style="color:var(--brand2)">${fmt(advance.balance)}</div></div></div>
    <div style="margin:12px 0"><b>Reason:</b> ${esc(advance.reason || "—")} · <b>Installment:</b> ${fmt(advance.installment)}/mo</div>
    <div class="sechead" style="border:none">Repayments</div>
    ${payments.length ? payments.map((p) => `<div class="mini"><span>${esc(p.date || "—")} <span class="r">· ${p.kind === "auto" ? "Auto" : "Manual"}${p.note ? " · " + esc(p.note) : ""}</span></span>
      <span>${fmt(p.amount)} ${w ? `<button class="icon-btn del" data-delpay="${p.id}" style="width:22px;height:22px">✕</button>` : ""}</span></div>`).join("") : '<div class="hint">No repayments yet.</div>'}
    ${w ? `<div class="sechead" style="border:none;margin-top:14px">Add manual repayment</div>
      <div class="toolbar"><input id="rDate" value="${todayStr()}" style="width:120px"><input id="rAmt" type="number" min="0" placeholder="Amount" style="width:110px"><input id="rNote" placeholder="Note"><button class="btn primary" id="rAdd">Add</button></div>` : ""}`;
  if (w) {
    $("rAdd").addEventListener("click", async () => {
      const amt = Number($("rAmt").value || 0); if (amt <= 0) return toast("Enter amount", true);
      try { await api(`/api/advances/${id}/payments`, { method: "POST", body: { amount: amt, date: $("rDate").value, note: $("rNote").value } });
        renderLedger(id, w); loadAdvances(); toast("Added"); } catch (e) { toast(e.error, true); }
    });
    $("ledgerArea").querySelectorAll("[data-delpay]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this entry? The amount returns to the balance.")) return;
      try { await api(`/api/advances/${id}/payments/${b.dataset.delpay}`, { method: "DELETE" }); renderLedger(id, w); loadAdvances(); } catch (e) { toast(e.error, true); }
    }));
  }
}

/* ================= COMPANY ================= */
const CMP_FIELDS = [["name","Business Name","full"],["entityType","Entity Type"],["contact","Contact Person"],
  ["mobile","Mobile"],["email","Email"],["addr1","Address Line 1","full"],["addr2","Address Line 2","full"],
  ["city","City"],["state","State"],["pincode","Pincode"],["country","Country"],
  ["gstin","GSTIN"],["pan","PAN"],["uid","Unique ID"],["tagline","Tagline"]];
async function loadCompany() {
  try { state.company = (await api("/api/company")).company; } catch (e) { return toast(e.error, true); }
  const c = state.company, w = canWrite();
  $("cmpGrid").innerHTML = CMP_FIELDS.map(([k, l, cls]) =>
    `<div class="fld ${cls === "full" ? "full" : ""}"><label>${esc(l)}</label><input id="c_${k}" value="${esc(c[k] || "")}" ${w ? "" : "disabled"}></div>`).join("");
}
$("btnSaveCmp").addEventListener("click", async () => {
  const body = {}; CMP_FIELDS.forEach(([k]) => (body[k] = $("c_" + k).value));
  try { await api("/api/company", { method: "PUT", body }); $("cmpSaved").textContent = "✓ Saved"; toast("Company saved"); state.company = { ...state.company, ...body }; }
  catch (e) { toast(e.error, true); }
});
$("btnChangePw").addEventListener("click", async () => {
  const cur = $("cpCur").value, np = $("cpNew").value, nc = $("cpNew2").value;
  if (np !== nc) return toast("New passwords do not match", true);
  try { await api("/api/auth/change-password", { method: "POST", body: { currentPassword: cur, newPassword: np } });
    toast("Password updated — sign in again"); setTimeout(() => { state.user = null; showLogin(); }, 1200); }
  catch (e) { toast(e.error, true); }
});

/* ================= USERS ================= */
async function loadUsers() {
  if (!isAdmin()) return;
  let users; try { users = (await api("/api/users")).users; } catch (e) { return toast(e.error, true); }
  $("usrBody").innerHTML = users.map((u) => `<tr>
    <td><strong>${esc(u.username)}</strong>${u.must_change ? ' <span class="chip">must change pw</span>' : ""}</td>
    <td><select data-role="${u.id}" ${u.id === state.user.id ? "disabled" : ""}>${["admin","hr","viewer"].map((r) => `<option ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
    <td>${esc((u.last_login || "—"))}</td><td>${u.locked ? '<span class="badge inactive">Locked</span>' : '<span class="badge active">OK</span>'}</td>
    <td><div class="rowbtns"><button class="icon-btn" data-reset="${u.id}" title="Reset password">🔑</button>
      ${u.id !== state.user.id ? `<button class="icon-btn del" data-deluser="${u.id}" title="Delete">🗑</button>` : ""}</div></td></tr>`).join("");
  $("usrBody").querySelectorAll("[data-role]").forEach((s) => s.addEventListener("change", async () => {
    try { await api(`/api/users/${s.dataset.role}/role`, { method: "PUT", body: { role: s.value } }); toast("Role updated"); } catch (e) { toast(e.error, true); loadUsers(); }
  }));
  $("usrBody").querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => resetPwModal(b.dataset.reset)));
  $("usrBody").querySelectorAll("[data-deluser]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this user?")) return;
    try { await api("/api/users/" + b.dataset.deluser, { method: "DELETE" }); toast("Deleted"); loadUsers(); } catch (e) { toast(e.error, true); }
  }));
  try { const s = await api("/api/admin/stats"); $("dbStats").innerHTML = `Currently in database: <b>${s.employees}</b> employees · <b>${s.advances}</b> advances · <b>${s.kyc}</b> KYC files · <b>${s.users}</b> users.`; } catch {}
}
$("btnImport").addEventListener("click", async () => {
  const f = $("impFile").files[0];
  if (!f) return toast("Choose your backup JSON file", true);
  const replace = $("impReplace").checked;
  if (replace && !confirm("Replace ALL existing employees, advances and KYC files with the backup? This cannot be undone.")) return;
  let backup;
  try { backup = JSON.parse(await f.text()); } catch { return toast("That file is not valid JSON", true); }
  const n = Array.isArray(backup.employees) ? backup.employees.length : Array.isArray(backup) ? backup.length : 0;
  if (!n) return toast("No employees found in that backup", true);
  if (!confirm(`Import ${n} employees` + (replace ? " (replacing existing data)" : "") + "?")) return;
  try {
    const r = await api("/api/admin/import-legacy", { method: "POST", body: { backup: Array.isArray(backup) ? { employees: backup } : backup, replace } });
    toast(`Imported ${r.employees} employees, ${r.advances} advances`);
    state.employees = []; loadUsers();
  } catch (e) { toast(e.error, true); }
});
$("btnAddUser").addEventListener("click", () => {
  openModal(`<h3>Add User</h3><div class="body">
    <div class="fld full"><label>Username</label><input id="u_name"></div>
    <div class="fld"><label>Role</label><select id="u_role"><option>hr</option><option>viewer</option><option>admin</option></select></div>
    <div class="fld"><label>Temporary Password</label><input id="u_pw" type="text" placeholder="Min 10, letters+numbers"></div></div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mSave">Create</button></div>`); wireClose();
  $("mSave").addEventListener("click", async () => {
    try { await api("/api/users", { method: "POST", body: { username: $("u_name").value.trim(), role: $("u_role").value, password: $("u_pw").value } });
      closeModal(); toast("User created — they must change the password at first login"); loadUsers(); } catch (e) { toast(e.error, true); }
  });
});
function resetPwModal(id) {
  openModal(`<h3>Reset Password</h3><div class="body"><div class="fld full"><label>New Temporary Password</label><input id="rp_pw" type="text" placeholder="Min 10, letters+numbers"></div></div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mSave">Reset</button></div>`); wireClose();
  $("mSave").addEventListener("click", async () => {
    try { await api(`/api/users/${id}/reset-password`, { method: "POST", body: { password: $("rp_pw").value } }); closeModal(); toast("Password reset"); } catch (e) { toast(e.error, true); }
  });
}

/* ================= DASHBOARD ================= */
async function renderDashboard() {
  try { if (!state.employees.length) state.employees = (await api("/api/employees")).employees;
    state.advances = (await api("/api/advances")).advances; } catch (e) { return toast(e.error, true); }
  const all = state.employees, active = all.filter((e) => (e.status || "Active") !== "Inactive");
  const totWage = all.reduce((s, e) => s + (e.salary || 0), 0), actWage = active.reduce((s, e) => s + (e.salary || 0), 0);
  const locs = uniq("loc");
  $("dashKpis").innerHTML = `
    <div class="card clickable" data-goto="emp"><div class="k">Total Employees</div><div class="v">${all.length}</div></div>
    <div class="card clickable" data-goto="emp:Active"><div class="k">Active</div><div class="v" style="color:var(--green)">${active.length}</div></div>
    <div class="card clickable" data-goto="emp:Inactive"><div class="k">Inactive</div><div class="v" style="color:var(--red)">${all.length - active.length}</div></div>
    <div class="card"><div class="k">Locations</div><div class="v">${locs.length}</div></div>
    <div class="card clickable" data-goto="pay"><div class="k">Monthly Wage (Active)</div><div class="v small">${fmt(actWage)}</div></div>
    <div class="card"><div class="k">Avg Salary</div><div class="v small">${fmt(all.length ? totWage / all.length : 0)}</div></div>`;
  const byLoc = locs.map((l) => ({ k: l, v: all.filter((e) => e.loc === l).length, w: all.filter((e) => e.loc === l).reduce((s, e) => s + (e.salary || 0), 0) })).sort((a, b) => b.v - a.v);
  const dm = {}; all.forEach((e) => (dm[e.desig || "—"] = (dm[e.desig || "—"] || 0) + 1));
  const byDesig = Object.entries(dm).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 8);
  const out = state.advances.reduce((s, a) => s + a.balance, 0);
  $("dashGrid").innerHTML = `
    <div class="panel"><h4>Headcount by Location</h4>${bars(byLoc.map((x) => ({ k: x.k, v: x.v })), "b")}</div>
    <div class="panel"><h4>Monthly Wage by Location</h4>${bars(byLoc.map((x) => ({ k: x.k, v: x.w })), "", true)}</div>
    <div class="panel"><h4>Top Designations</h4>${bars(byDesig, "g")}</div>
    <div class="panel"><h4>Summary</h4>
      <div class="mini"><span class="r">Total monthly wage</span><span>${fmt(totWage)}</span></div>
      <div class="mini"><span class="r">Active wage bill</span><span>${fmt(actWage)}</span></div>
      <div class="mini clickable" data-goto="adv"><span class="r">Advances outstanding</span><span style="color:var(--brand2)">${fmt(out)}</span></div></div>`;
}
function bars(items, cls, cur) {
  const max = Math.max(1, ...items.map((i) => i.v));
  return items.length ? items.map((i) => `<div class="bar-row"><div class="bar-lbl">${esc(i.k)}</div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.max(3, Math.round(i.v / max * 100))}%"></div></div>
    <div class="bar-val">${cur ? fmt(i.v) : i.v}</div></div>`).join("") : '<div class="hint">No data.</div>';
}
$("dashKpis").addEventListener("click", onDashGoto);
$("dashGrid").addEventListener("click", onDashGoto);
function onDashGoto(e) {
  const c = e.target.closest("[data-goto]"); if (!c) return;
  const [tab, arg] = c.dataset.goto.split(":");
  if (tab === "emp") { switchTab("emp"); if (arg) setTimeout(() => { $("empStatus").value = arg; renderEmp(); }, 100); }
  else switchTab(tab);
}

/* ---------------- utils ---------------- */
function wireClose() { document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal)); }
function todayStr() { const d = new Date(); return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`; }
function downloadCSV(name, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const u = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  const a = document.createElement("a"); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000);
}

/* XLSX-ENGINE-START — minimal pure-JS .xlsx writer (no libraries, CSP-safe).
   Builds a real Office Open XML workbook: a ZIP (store method) of XML parts. */
function xlsxBlob(sheetName, rows) {
  const enc = new TextEncoder();
  const xe = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const col = (n) => { let s = ""; n++; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; };
  const safeSheet = xe(String(sheetName || "Sheet1").slice(0, 31).replace(/[\\/?*[\]:]/g, " ")) || "Sheet1";

  let sd = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  rows.forEach((row, r) => {
    sd += `<row r="${r + 1}">`;
    row.forEach((cell, c) => {
      const ref = col(c) + (r + 1);
      if (typeof cell === "number" && isFinite(cell)) sd += `<c r="${ref}"><v>${cell}</v></c>`;
      else sd += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xe(cell == null ? "" : cell)}</t></is></c>`;
    });
    sd += "</row>";
  });
  sd += "</sheetData></worksheet>";

  const parts = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml", sd],
  ].map(([name, xml]) => ({ name, data: enc.encode(xml) }));

  return zipStore(parts);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    let c = (crc ^ bytes[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const chunks = [], central = []; let offset = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(sz), ...u32(sz), ...u16(nm.length), ...u16(0)];
    chunks.push(new Uint8Array(local), nm, f.data);
    central.push({ crc, sz, nm, offset });
    offset += local.length + nm.length + sz;
  }
  const cdStart = offset;
  for (const c of central) {
    const rec = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(c.crc), ...u32(c.sz), ...u32(c.sz), ...u16(c.nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)];
    chunks.push(new Uint8Array(rec), c.nm);
    offset += rec.length + c.nm.length;
  }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(offset - cdStart), ...u32(cdStart), ...u16(0)];
  chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
function downloadXLSX(name, sheetName, rows) {
  const u = URL.createObjectURL(xlsxBlob(sheetName, rows));
  const a = document.createElement("a"); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000);
}
/* XLSX-ENGINE-END */

/* Defeat browser autofill of the logged-in username into the search boxes.
   Chromium ignores autocomplete="off" for fields it classifies as a username
   (the login form is still in the DOM), but it will NOT autofill a readonly
   field. Keep them readonly until the user actually focuses to type. */
["empSearch", "advSearch"].forEach((id) => {
  const inp = $(id);
  if (!inp) return;
  inp.value = "";
  inp.setAttribute("readonly", "readonly");
  const unlock = () => inp.removeAttribute("readonly");
  inp.addEventListener("focus", unlock);
  inp.addEventListener("pointerdown", unlock);
});

/* ---------------- boot ---------------- */
(async function boot() {
  try { const me = await api("/api/auth/me"); state.user = me.user; showApp(); }
  catch { showLogin(); }
})();
