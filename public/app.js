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

const state = { user: null, employees: [], advances: [], company: {}, kycCounts: {}, users: [],
  empSort: { k: "name", d: 1 }, empExtra: null, basis: "cal",
  paySort: { k: null, d: 0 }, advSort: { k: null, d: 0 }, usrSort: { k: null, d: 0 } };

/* ---------------- generic table search / sort helpers ---------------- */
/** Sort a copy of `list` by sort.k (asc/desc via sort.d). `valOf(row,key)` reads
 *  the value; keys in `numericKeys` compare as numbers, the rest as text. */
function applySort(list, sort, valOf, numericKeys = []) {
  if (!sort.k) return list;
  const num = numericKeys.includes(sort.k);
  return [...list].sort((a, b) => {
    const va = valOf(a, sort.k), vb = valOf(b, sort.k);
    if (num) return ((Number(va) || 0) - (Number(vb) || 0)) * sort.d;
    return String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true }) * sort.d;
  });
}
/** Highlight the active sort column header. */
function markSorted(viewSel, sort) {
  document.querySelectorAll(viewSel + " thead th").forEach((th) =>
    th.classList.toggle("sorted", !!sort.k && th.dataset.sort === sort.k));
}
/** Make a table's headers clickable: same column toggles direction, new column
 *  starts ascending. Calls `rerender()` (no refetch) after updating the state. */
function wireSortHeader(viewSel, sort, rerender) {
  const thead = document.querySelector(viewSel + " thead");
  if (!thead) return;
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]"); if (!th) return;
    const k = th.dataset.sort;
    if (sort.k === k) sort.d *= -1; else { sort.k = k; sort.d = 1; }
    rerender();
  });
}

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
  ["dash","emp","pay","adv","cmp","apr","usr"].forEach((v) => ($("view-" + v).hidden = v !== tab));
  ({ dash: renderDashboard, emp: loadEmployees, pay: renderPayroll, adv: loadAdvances, cmp: loadCompany, apr: loadApprovals, usr: loadUsers }[tab] || (() => {}))();
}
const canWrite = () => state.user && (state.user.role === "admin" || state.user.role === "hr");
const isAdmin = () => state.user && state.user.role === "admin";

/* ---------------- Modal ---------------- */
// `protect:true` guards data-entry forms: clicking the backdrop or pressing
// Escape won't discard what you typed — you must use Cancel or Save.
let modalProtected = false;
function openModal(html, opts = {}) { $("modalCard").innerHTML = html; $("modal").classList.add("show"); modalProtected = !!opts.protect; }
function closeModal() { $("modal").classList.remove("show"); $("modalCard").innerHTML = ""; modalProtected = false; }
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal" && !modalProtected) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modalProtected) closeModal(); });

/* ================= EMPLOYEES ================= */
async function loadEmployees() {
  try {
    const [{ employees }, { counts }] = await Promise.all([api("/api/employees"), api("/api/kyc/counts/all")]);
    state.employees = employees; state.kycCounts = counts || {};
    fillEmpFilters();
    // A dashboard tile can request a pre-set filter (status / location / designation).
    if (state.empPending) {
      const f = state.empPending; state.empPending = null;
      const set = (id, val) => { const s = $(id); if (val && [...s.options].some((o) => o.value === val)) s.value = val; else s.value = ""; };
      $("empSearch").value = "";
      set("empStatus", f.status); set("empLoc", f.loc); set("empDesig", f.desig);
    }
    renderEmp();
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
        <button class="icon-btn" data-act="offer" data-id="${e.id}" title="Offer Letter (Word)">📃</button>
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
     offer: () => downloadOfferFor(id), togglestatus: () => toggleStatus(id) }[b.dataset.act] || (() => {}))();
});
$("btnAddEmp").addEventListener("click", () => empModal(null));

const EMP_FIELDS = [
  ["name","Name *","full"],["desig","Designation"],["loc","Location"],["joining","Joining (dd.mm.yyyy)"],
  ["leaving","Leaving (dd.mm.yyyy)"],
  ["salary","Monthly Salary (₹)","","number"],["phone","Phone"],["status","Status","","status"],
  ["effectiveFrom","Change Effective From (dd.mm.yyyy)"],
  ["__s1","Report details","sechead"],
  ["fatherName","Father's Name"],["dob","Date of Birth"],["address","Full Address","full"],
  ["qualGen","Qualification — General"],["qualTech","Qualification — Technical"],["experience","Experience","full"],
  ["langRead","Read"],["langWrite","Write"],["langSpeak","Speak"],["reportTime","Report Time (A.M.)"],
  ["hobbies","Hobbies","full"],["documents","List of Documents","full"],
  ["__s2","Bank / Payment details","sechead"],
  ["bankName","Bank Name"],["accName","Account Holder"],["accNo","Account Number","","digits"],
  ["ifsc","IFSC Code"],["branch","Branch"],["upi","UPI ID"],
];
function empModal(id) {
  const e = id ? state.employees.find((x) => x.id === id) : {};
  const fields = EMP_FIELDS.map((f) => {
    const [k, label, cls, type] = f;
    if (cls === "sechead") return `<div class="sechead">${label}</div>`;
    if (type === "status") return `<div class="fld"><label>Status</label><select id="f_status"><option ${e.status !== "Inactive" ? "selected" : ""}>Active</option><option ${e.status === "Inactive" ? "selected" : ""}>Inactive</option></select></div>`;
    // effectiveFrom isn't stored on the employee — it dates a salary/designation
    // change for the history log; default it to today.
    const v = k === "effectiveFrom" ? todayStr() : e[k] != null ? esc(e[k]) : "";
    // accNo is "digits": a text input (not number) so long account numbers keep
    // every digit and are sent as a string — the server validates a digit string.
    const attr = type === "number" ? 'type="number" min="0"' : type === "digits" ? 'inputmode="numeric" autocomplete="off"' : "";
    return `<div class="fld ${cls === "full" ? "full" : ""}"><label>${esc(label)}</label><input id="f_${k}" ${attr} value="${v}"></div>`;
  }).join("");
  openModal(`<h3>${id ? "Edit" : "Add"} Employee</h3><div class="body">${fields}</div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mSave">Save</button></div>`, { protect: true });
  wireClose();
  $("mSave").addEventListener("click", async () => {
    const payload = {}; EMP_FIELDS.forEach(([k, , cls, type]) => {
      if (cls === "sechead") return;
      if (type === "status") { payload.status = $("f_status").value; return; }
      payload[k] = type === "number" ? Number($("f_" + k).value || 0) : $("f_" + k).value.trim();
    });
    if (!payload.name.trim()) return toast("Name is required", true);
    try {
      const r = id ? await api("/api/employees/" + id, { method: "PUT", body: payload })
                   : await api("/api/employees", { method: "POST", body: payload });
      closeModal(); toast(r && r.queued ? "✋ Sent for admin approval" : "Saved"); loadEmployees();
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
  try {
    const r = await api("/api/employees/" + id, { method: "PUT", body: { ...e, status: next } });
    if (r && r.queued) toast("✋ Sent for admin approval");
    loadEmployees();
  } catch (err) { toast(err.error, true); }
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
$("btnOfferAll").addEventListener("click", downloadAllOfferLetters);

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
    <button class="btn primary" id="rOffer">📃 Download Offer Letter (Word)</button>
    <button class="btn" id="rHist">📜 CTC / Designation History</button>
    <div class="hint">Files open in MS Word with the company letterhead.</div></div>
    <div class="foot"><button class="btn ghost" data-close>Close</button></div>`); wireClose();
  const e = await (await api("/api/employees/" + empId)).employee;
  const c = await ensureCompany();
  $("rBio").addEventListener("click", () => downloadDoc("BioData_" + safe(e.name), bioHtml(e, c)));
  $("rJoin").addEventListener("click", () => downloadDoc("JoiningReport_" + safe(e.name), joinHtml(e, c)));
  $("rOffer").addEventListener("click", () => downloadDoc("OfferLetter_" + safe(e.name), offerHtml(e, c)));
  $("rHist").addEventListener("click", () => historyModal(e));
}
/** Timeline of salary (CTC) and designation changes for one employee. */
async function historyModal(e) {
  let rows = [];
  try { rows = (await api(`/api/employees/${e.id}/history`)).history; } catch (err) { return toast(err.error, true); }
  const isoToDmy = (iso) => { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}.${m[2]}.${m[1]}` : iso; };
  const line = (h) => {
    const what = h.field === "salary" ? `Salary ${fmt(h.old_value)} → <b>${fmt(h.new_value)}</b>`
      : `Designation "${esc(h.old_value || "—")}" → <b>"${esc(h.new_value)}"</b>`;
    return `<div class="mini"><span>${what}<br><span class="hint">effective ${esc(isoToDmy(h.effective))} · by ${esc(h.changed_by || "—")} · recorded ${esc((h.changed_at || "").slice(0, 10))}</span></span></div>`;
  };
  openModal(`<h3>📜 History — ${esc(e.name)}</h3>
    <div style="padding:14px 20px;max-height:60vh;overflow:auto">
      ${rows.length ? rows.map(line).join("") : '<div class="hint">No salary or designation changes recorded yet. Changes made from now on (with their effective date) will appear here.</div>'}
    </div>
    <div class="foot"><button class="btn ghost" data-close>Close</button></div>`);
  wireClose();
}
const safe = (n) => String(n).replace(/[^\w]+/g, "_");
/** The letterhead needs the company profile; it may not be loaded yet if the
 *  Company tab was never opened, so fetch it on demand and cache it. */
async function ensureCompany() {
  if (!state.company || !Object.keys(state.company).length) {
    try { state.company = (await api("/api/company")).company || {}; } catch { state.company = state.company || {}; }
  }
  return state.company;
}
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
function docShell(bodyInner) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8">
    <style>@page{margin:2cm}body{font-family:'Times New Roman',serif;font-size:13pt}table{border-collapse:collapse;width:100%}td{border:1px solid #000;padding:6px 9px}h2{text-align:center;letter-spacing:2px}.lbl{width:40%;font-weight:bold}</style></head>
    <body>${bodyInner}</body></html>`;
}
function docWrap(inner, c) { return docShell(`${letterhead(c)}${inner}`); }
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
/** Offer-letter body (no letterhead/shell) — reused for single and bulk output. */
function offerBody(e, c) {
  const company = c.name || "the Company";
  const addr = [c.addr1, c.addr2, [c.city, c.state].filter(Boolean).join(", "), c.pincode].filter(Boolean).join(", ");
  const salary = (Number(e.salary) || 0).toLocaleString("en-IN");
  const P = (t) => `<p style="text-align:justify;margin:7px 0">${t}</p>`;
  const S = (n, title, body) => `<p style="margin:12px 0 2px 0"><b>${n}. ${title}</b></p>${P(body)}`;
  return `<h2>OFFER LETTER</h2>
    ${P("Date: ___________")}
    ${P(`To,<br>Mr./Ms. <b>${esc(e.name)}</b>`)}
    ${P("<b>Subject: Offer of Employment</b>")}
    ${P(`Dear Mr./Ms. ${esc(e.name)},`)}
    ${P(`We are pleased to offer you employment with <b>${esc(company)}</b> as <b>${esc(e.desig || "____________")}</b>, subject to the terms and conditions mentioned below.`)}
    ${S(1, "Date of Joining", `Your date of joining will be <b>${esc(e.joining || "____________")}</b>.`)}
    ${S(2, "Place of Work", `Your primary place of work will be our restaurant located at: ${esc(addr || "__________________________________________")}`)}
    ${S(3, "Salary", `Your monthly gross salary will be <b>₹${salary}</b>, payable on or before the ___ day of the following month after applicable statutory deductions.`)}
    ${S(4, "Working Hours", "Your working hours, weekly off, and shift timings will be as scheduled by the management from time to time. You may be required to work in shifts, on weekends, or public holidays depending on business requirements.")}
    ${S(5, "Duties", "You shall perform your assigned duties diligently and follow all operational, hygiene, food safety, customer service, and workplace policies of the restaurant.")}
    ${S(6, "Probation", "You will be on probation for 3 months from the date of joining. Based on your performance, your services may be confirmed or the probation period may be extended.")}
    ${S(7, "Notice Period", "Either party may terminate the employment by giving one (1) week's written notice or salary in lieu of such notice, unless otherwise required under applicable law.")}
    ${P("The management reserves the right to terminate employment without notice in cases of misconduct, fraud, theft, violence, breach of confidentiality, or any serious violation of company policies.")}
    ${S(8, "Leave", "You shall be entitled to leave and holidays as per the applicable laws and the restaurant's leave policy.")}
    ${S(9, "Confidentiality", "You shall maintain confidentiality regarding the restaurant's recipes, customer information, pricing, business operations, and other confidential information during and after your employment.")}
    ${S(10, "Company Property", "Any uniform, keys, ID card, equipment, or other property provided by the restaurant shall remain the property of the employer and must be returned upon cessation of employment.")}
    ${S(11, "General", "Your employment is governed by the policies of the restaurant and applicable laws. Any false information provided during recruitment may result in termination of employment.")}
    ${P("If you accept the above terms and conditions, kindly sign and return a copy of this letter.")}
    ${P("We welcome you to our team and wish you success with us.")}
    ${P(`For <b>${esc(company)}</b>`)}
    ${P("<br><br>Authorized Signatory")}
    <h2 style="margin-top:22px">Acceptance</h2>
    ${P(`I, Mr./Ms. <b>${esc(e.name)}</b>, accept the terms and conditions of employment stated above.`)}
    ${P("<br>Employee Signature: ___________________")}
    ${P(`Name: ${esc(e.name)}`)}
    ${P("Date: ___________________")}`;
}
function offerHtml(e, c) { return docWrap(offerBody(e, c), c); }
/** One-click offer letter for an employee row (uses already-loaded list data). */
async function downloadOfferFor(id) {
  const e = state.employees.find((x) => x.id === id);
  if (!e) return toast("Employee not found", true);
  const c = await ensureCompany();
  downloadDoc("OfferLetter_" + safe(e.name), offerHtml(e, c));
}
/** One Word file with an offer letter per employee, each on its own page. */
function offerLettersAllHtml(list, c) {
  return docShell(list.map((e, i) =>
    `<div${i < list.length - 1 ? ' style="page-break-after:always"' : ""}>${letterhead(c)}${offerBody(e, c)}</div>`
  ).join(""));
}
async function downloadAllOfferLetters() {
  const list = filteredEmp();
  if (!list.length) return toast("No employees to generate", true);
  if (!confirm(`Generate offer letters for ${list.length} employee(s) into one Word file?`)) return;
  const c = await ensureCompany();
  downloadDoc("Offer_Letters_All", offerLettersAllHtml(list, c));
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
  ["paySearch", "payLoc", "payDesig"].forEach((id) => $(id).addEventListener("input", renderPayTable));
  wireSortHeader("#view-pay", state.paySort, renderPayTable);
}
let payData = null;
const mk = () => `${$("payYear").value}-${$("payMonth").value}`;
async function renderPayroll() {
  initPayControls();
  try {
    // Load employees alongside payroll (fresh, so the export's bank details are
    // current). Account number is role-gated: absent from the list for viewers.
    const [pd, emps] = await Promise.all([
      api(`/api/payroll/${mk()}?basis=${state.basis}`),
      api("/api/employees"),
    ]);
    payData = pd; state.employees = emps.employees;
  } catch (e) { return toast(e.error, true); }
  fillPayFilters();
  renderPayTable();
}
function fillPayFilters() {
  if (!payData) return;
  const setOpts = (id, arr, all) => { const s = $(id), cur = s.value;
    s.innerHTML = `<option value="">${all}</option>` + arr.map((v) => `<option>${esc(v)}</option>`).join("");
    if ([...s.options].some((o) => o.value === cur)) s.value = cur; };
  setOpts("payLoc", [...new Set(payData.rows.map((r) => r.loc).filter(Boolean))].sort(), "All Locations");
  setOpts("payDesig", [...new Set(payData.rows.map((r) => r.desig).filter(Boolean))].sort(), "All Designations");
}
/** Rows for display: apply the search box + location/designation filters + sort. */
function filteredSortedPayRows() {
  if (!payData) return [];
  const q = $("paySearch").value.trim().toLowerCase(), loc = $("payLoc").value, des = $("payDesig").value;
  const list = payData.rows.filter((r) => {
    if (loc && r.loc !== loc) return false;
    if (des && r.desig !== des) return false;
    if (q && !(`${r.name} ${r.desig} ${r.loc}`.toLowerCase().includes(q))) return false;
    return true;
  });
  return applySort(list, state.paySort, (r, k) => r[k], ["salary", "wd", "earned", "bonus", "ded", "rec", "net"]);
}
/** Render the payroll table body/footer from the current filter+sort state
 *  (no refetch — reuses the last payData). Totals reflect the shown rows. */
function renderPayTable() {
  if (!payData) return;
  const w = canWrite();
  $("basisNote").innerHTML = `Earned = Salary ÷ <b>${payData.baseDays}</b> × Working Days. Shows employees on this month's payroll (joining/leaving dates respected); salary is as it was that month.`;
  $("recBanner").innerHTML = payData.pending && w
    ? `<div style="background:rgba(255,176,61,.1);border:1px solid #4a3a20;color:var(--brand2);padding:9px 13px;border-radius:8px;margin-bottom:12px">⚠ ${payData.pending} recovery(ies) not yet posted. <button class="btn sm" id="bannerPost">Post Recoveries</button></div>` : "";
  if ($("bannerPost")) $("bannerPost").addEventListener("click", postRecoveries);
  const rows = filteredSortedPayRows();
  $("payBody").innerHTML = rows.map((r) => {
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
  }).join("") || `<tr><td colspan="10" class="empty">No employees match.</td></tr>`;
  const t = rows.reduce((t, r) => ({ earned: t.earned + r.earned, bonus: t.bonus + r.bonus, ded: t.ded + r.ded, rec: t.rec + r.rec, net: t.net + r.net }), { earned: 0, bonus: 0, ded: 0, rec: 0, net: 0 });
  $("payFoot").innerHTML = rows.length ? `<tr><td colspan="5">TOTAL — ${rows.length} employees</td>
    <td class="num">${fmt(t.earned)}</td><td class="num">${fmt(t.bonus)}</td><td class="num">${fmt(t.ded)}</td><td class="num">${fmt(t.rec)}</td><td class="num net">${fmt(t.net)}</td></tr>` : "";
  markSorted("#view-pay", state.paySort);
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
  try { const r = await api(`/api/payroll/${mk()}/unpost/${b.dataset.unpost}`, { method: "POST", body: { mode } });
    toast(r && r.queued ? "✋ Sent for admin approval" : "Done"); renderPayroll(); }
  catch (err) { toast(err.error, true); }
});
async function postRecoveries() {
  try { const r = await api(`/api/payroll/${mk()}/post-recoveries`, { method: "POST", body: {} });
    toast(r.queued ? "✋ Sent for admin approval" : r.posted ? `Posted for ${r.posted} employee(s)` : "Nothing to post — set installments"); renderPayroll(); }
  catch (e) { toast(e.error, true); }
}
function payExportRows() {
  const bankOf = (id) => state.employees.find((e) => e.id === id) || {};
  const rows = [["Name","Designation","Loc","Salary","Work Days","Earned","Bonus","Other Ded.","Adv. Recovery","Net",
    "Bank Name","Account Holder","Account Number","IFSC","UPI"]];
  filteredSortedPayRows().forEach((r) => {
    const b = bankOf(r.id);
    rows.push([r.name, r.desig, r.loc, r.salary, r.wd, r.earned, r.bonus, r.ded, r.rec, r.net,
      b.bankName || "", b.accName || "", b.accNo || "", b.ifsc || "", b.upi || ""]);
  });
  return rows;
}
function payFileBase() { return `Payroll_${MONTHS[+$("payMonth").value]}_${$("payYear").value}`; }

/* ================= ADVANCES ================= */
async function loadAdvances() {
  try { state.advances = (await api("/api/advances")).advances; if (!state.employees.length) state.employees = (await api("/api/employees")).employees; fillAdvFilters(); renderAdv(); }
  catch (e) { toast(e.error, true); }
}
["advSearch","advStatus","advLoc"].forEach((id) => $(id).addEventListener("input", renderAdv));
wireSortHeader("#view-adv", state.advSort, renderAdv);
function empName(id) { const e = state.employees.find((x) => x.id === id); return e ? e.name : "(deleted)"; }
function empLocOf(id) { const e = state.employees.find((x) => x.id === id); return e ? e.loc : ""; }
function fillAdvFilters() {
  const s = $("advLoc"), cur = s.value;
  const locs = [...new Set(state.employees.map((e) => e.loc).filter(Boolean))].sort();
  s.innerHTML = `<option value="">All Locations</option>` + locs.map((v) => `<option>${esc(v)}</option>`).join("");
  if ([...s.options].some((o) => o.value === cur)) s.value = cur;
}
/** Read a sortable value off an advance row for the given column key. */
function advSortVal(a, k) {
  if (k === "emp") return empName(a.empId);
  if (k === "status") return a.open ? "Open" : "Closed";
  return a[k];
}
function renderAdv() {
  const q = $("advSearch").value.trim().toLowerCase(), st = $("advStatus").value, loc = $("advLoc").value, w = canWrite();
  let list = state.advances.filter((a) => {
    if (st === "open" && !a.open) return false; if (st === "closed" && a.open) return false;
    if (loc && empLocOf(a.empId) !== loc) return false;
    if (q && !(`${empName(a.empId)} ${a.reason}`.toLowerCase().includes(q))) return false; return true;
  });
  list = applySort(list, state.advSort, advSortVal, ["amount", "installment", "recovered", "balance"]);
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
  markSorted("#view-adv", state.advSort);
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
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mSave">Save</button></div>`, { protect: true }); wireClose();
  $("mSave").addEventListener("click", async () => {
    const body = { empId: Number($("a_emp").value), date: $("a_date").value, amount: Number($("a_amount").value || 0), reason: $("a_reason").value, installment: Number($("a_inst").value || 0) };
    if (body.amount <= 0) return toast("Enter an amount", true);
    try { const r = id ? await api("/api/advances/" + id, { method: "PUT", body }) : await api("/api/advances", { method: "POST", body });
      closeModal(); toast(r && r.queued ? "✋ Sent for admin approval" : "Saved"); loadAdvances(); } catch (err) { toast(err.error, true); }
  });
}
async function delAdv(id) { if (!confirm("Delete this advance and its history?")) return;
  try { const r = await api("/api/advances/" + id, { method: "DELETE" }); toast(r && r.queued ? "✋ Sent for admin approval" : "Deleted"); loadAdvances(); } catch (e) { toast(e.error, true); } }
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
      try { const r = await api(`/api/advances/${id}/payments`, { method: "POST", body: { amount: amt, date: $("rDate").value, note: $("rNote").value } });
        renderLedger(id, w); loadAdvances(); toast(r && r.queued ? "✋ Sent for admin approval" : "Added"); } catch (e) { toast(e.error, true); }
    });
    $("ledgerArea").querySelectorAll("[data-delpay]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this entry? The amount returns to the balance.")) return;
      try { const r = await api(`/api/advances/${id}/payments/${b.dataset.delpay}`, { method: "DELETE" });
        if (r && r.queued) toast("✋ Sent for admin approval");
        renderLedger(id, w); loadAdvances(); } catch (e) { toast(e.error, true); }
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
  try { state.users = (await api("/api/users")).users; } catch (e) { return toast(e.error, true); }
  renderUsers();
  try { const s = await api("/api/admin/stats"); $("dbStats").innerHTML = `Currently in database: <b>${s.employees}</b> employees · <b>${s.advances}</b> advances · <b>${s.kyc}</b> KYC files · <b>${s.users}</b> users.`; } catch {}
}
function usrSortVal(u, k) {
  if (k === "status") return u.locked ? "Locked" : "OK";
  if (k === "last_login") return u.last_login || "";
  return u[k];
}
function renderUsers() {
  const q = $("usrSearch").value.trim().toLowerCase(), role = $("usrRole").value, stt = $("usrStatus").value;
  let list = state.users.filter((u) => {
    if (role && u.role !== role) return false;
    if (stt === "locked" && !u.locked) return false;
    if (stt === "ok" && u.locked) return false;
    if (q && !String(u.username).toLowerCase().includes(q)) return false;
    return true;
  });
  list = applySort(list, state.usrSort, usrSortVal, []);
  $("usrBody").innerHTML = list.length ? list.map((u) => `<tr>
    <td><strong>${esc(u.username)}</strong>${u.must_change ? ' <span class="chip">must change pw</span>' : ""}</td>
    <td><select data-role="${u.id}" ${u.id === state.user.id ? "disabled" : ""}>${["admin","hr","viewer"].map((r) => `<option ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
    <td>${esc((u.last_login || "—"))}</td><td>${u.locked ? '<span class="badge inactive">Locked</span>' : '<span class="badge active">OK</span>'}</td>
    <td><div class="rowbtns"><button class="icon-btn" data-reset="${u.id}" title="Reset password">🔑</button>
      ${u.id !== state.user.id ? `<button class="icon-btn del" data-deluser="${u.id}" title="Delete">🗑</button>` : ""}</div></td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No users match.</td></tr>`;
  $("usrBody").querySelectorAll("[data-role]").forEach((s) => s.addEventListener("change", async () => {
    try { await api(`/api/users/${s.dataset.role}/role`, { method: "PUT", body: { role: s.value } }); toast("Role updated");
      const u = state.users.find((x) => x.id === Number(s.dataset.role)); if (u) u.role = s.value; }
    catch (e) { toast(e.error, true); loadUsers(); }
  }));
  $("usrBody").querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => resetPwModal(b.dataset.reset)));
  $("usrBody").querySelectorAll("[data-deluser]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this user?")) return;
    try { await api("/api/users/" + b.dataset.deluser, { method: "DELETE" }); toast("Deleted"); loadUsers(); } catch (e) { toast(e.error, true); }
  }));
  markSorted("#view-usr", state.usrSort);
}
["usrSearch", "usrRole", "usrStatus"].forEach((id) => $(id).addEventListener("input", renderUsers));
wireSortHeader("#view-usr", state.usrSort, renderUsers);
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

/* ============ BANK DETAILS IMPORT (admin) ============ */
const BANK_NAMES = {
  SBIN: "State Bank of India", HDFC: "HDFC Bank", ICIC: "ICICI Bank", KKBK: "Kotak Mahindra Bank",
  FDRL: "Federal Bank", KARB: "Karnataka Bank", UBIN: "Union Bank of India", CNRB: "Canara Bank",
  PUNB: "Punjab National Bank", BARB: "Bank of Baroda", YESB: "Yes Bank", UTIB: "Axis Bank",
  AXIS: "Axis Bank", IDIB: "Indian Bank", IOBA: "Indian Overseas Bank", MAHB: "Bank of Maharashtra",
  IBKL: "IDBI Bank", NESF: "North East Small Finance Bank", PKGB: "Paschim Banga Gramin Bank",
};
function bankFromIfsc(ifsc) {
  const code = String(ifsc || "").trim().slice(0, 4).toUpperCase();
  return BANK_NAMES[code] || (code ? code + " Bank" : "");
}
/** Minimal CSV parser (handles quoted fields, commas, CRLF, BOM). */
function parseCSV(text) {
  const out = []; let field = "", row = [], inq = false;
  text = String(text).replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inq) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; }
      else field += ch;
    } else if (ch === '"') inq = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((c) => String(c).trim() !== ""));
}
const normName = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
/** Best-guess employee for a sheet name + location. */
function matchEmployee(name, loc) {
  const nn = normName(name), nl = normName(loc);
  const inLoc = state.employees.filter((e) => normName(e.loc) === nl);
  const pool = inLoc.length ? inLoc : state.employees;
  const exacts = pool.filter((e) => normName(e.name) === nn);
  if (exacts.length === 1) return { id: exacts[0].id, conf: "exact" };
  if (exacts.length > 1) return { id: null, conf: "ambiguous" }; // duplicate names → must pick
  const nt = nn.split(" ").filter(Boolean);
  const scored = pool.map((e) => {
    const et = new Set(normName(e.name).split(" ").filter(Boolean));
    return { e, ov: nt.filter((t) => et.has(t)).length };
  }).filter((x) => x.ov > 0).sort((a, b) => b.ov - a.ov);
  if (scored.length === 1 || (scored.length > 1 && scored[0].ov > scored[1].ov))
    return { id: scored[0].e.id, conf: "guess" };
  return { id: null, conf: scored.length ? "ambiguous" : "none" };
}
$("btnBankImport").addEventListener("click", async () => {
  const f = $("bankFile").files[0];
  if (!f) return toast("Choose the bank details CSV file", true);
  let text; try { text = await f.text(); } catch { return toast("Could not read that file", true); }
  const rows = parseCSV(text);
  if (rows.length < 2) return toast("No rows found in the CSV", true);
  const hdr = rows[0].map((h) => normName(h));
  const col = (...names) => { for (const n of names) { const i = hdr.indexOf(normName(n)); if (i >= 0) return i; } return -1; };
  const ci = { loc: col("Location", "Loc"), name: col("Name", "Employee Name"),
    holder: col("Account Holder", "Beneficiary Name", "Beneficiary", "Acc Holder"),
    acc: col("Account No", "Bank Account No", "Account Number", "Acc No"), ifsc: col("IFSC") };
  if (ci.name < 0 || ci.acc < 0) return toast("CSV needs at least Name and Account No columns", true);
  if (!state.employees.length) { try { state.employees = (await api("/api/employees")).employees; } catch (e) { return toast(e.error, true); } }
  const data = rows.slice(1).map((r) => ({
    loc: ci.loc >= 0 ? (r[ci.loc] || "").trim() : "",
    name: (r[ci.name] || "").trim(),
    holder: ci.holder >= 0 ? (r[ci.holder] || "").trim() : "",
    acc: (ci.acc >= 0 ? (r[ci.acc] || "") : "").replace(/\s/g, ""),
    ifsc: ci.ifsc >= 0 ? (r[ci.ifsc] || "").trim() : "",
  })).filter((d) => d.name && d.acc);
  if (!data.length) return toast("No usable rows (need Name + Account No)", true);
  data.forEach((d) => { const m = matchEmployee(d.name, d.loc); d.matchId = m.id; d.conf = m.conf; });
  bankImportPreview(data);
});
function bankImportPreview(data) {
  const emps = [...state.employees].sort((a, b) => a.name.localeCompare(b.name));
  const opts = (sel) => `<option value="">— skip —</option>` +
    emps.map((e) => `<option value="${e.id}" ${e.id === sel ? "selected" : ""}>${esc(e.name)} · ${esc(e.loc || "")}</option>`).join("");
  const flagOf = (c) => ({ exact: "✅", guess: "🟡", ambiguous: "⚠️", none: "❓" }[c] || "");
  const body = data.map((d, i) => {
    const cur = d.matchId ? state.employees.find((e) => e.id === d.matchId) : null;
    const curHas = cur && cur.accNo ? `<span class="hint">now: ****${esc(String(cur.accNo).slice(-4))}</span>` : (cur ? '<span class="hint">now: —</span>' : "");
    return `<tr>
      <td>${flagOf(d.conf)} <b>${esc(d.name)}</b><br><span class="hint">${esc(d.loc)}</span></td>
      <td>${esc(d.acc)}<br><span class="hint">${esc(bankFromIfsc(d.ifsc))} · ${esc(d.ifsc)}</span></td>
      <td>${esc(d.holder || "—")}</td>
      <td><select class="bank-emp" data-i="${i}" style="min-width:190px">${opts(d.matchId)}</select><br>${curHas}</td>
    </tr>`;
  }).join("");
  const needs = data.filter((d) => !d.matchId || d.conf !== "exact").length;
  openModal(`<h3>Review bank details — ${data.length} rows</h3>
    <div style="padding:12px 20px;max-height:62vh;overflow:auto">
      <div class="hint" style="margin-bottom:10px">✅ exact match · 🟡 best guess · ⚠️ ambiguous · ❓ no match. <b>${needs}</b> row(s) worth checking. Pick the correct employee (or <b>— skip —</b>). Applying <b>overwrites</b> that employee's bank details; "now:" shows their current account.</div>
      <table><thead><tr><th>Sheet name</th><th>Account / Bank</th><th>Holder</th><th>Update employee</th></tr></thead><tbody id="bankPrevBody">${body}</tbody></table>
    </div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="btnBankApply">Apply</button></div>`, { protect: true });
  wireClose();
  $("bankPrevBody").addEventListener("change", (e) => {
    const s = e.target.closest(".bank-emp"); if (!s) return;
    data[Number(s.dataset.i)].matchId = s.value ? Number(s.value) : null;
  });
  $("btnBankApply").addEventListener("click", () => applyBankImport(data));
}
async function applyBankImport(data) {
  const toApply = data.filter((d) => d.matchId);
  if (!toApply.length) return toast("Nothing selected to apply", true);
  const dupes = toApply.length - new Set(toApply.map((d) => d.matchId)).size;
  if (!confirm(`Update bank details for ${new Set(toApply.map((d) => d.matchId)).size} employee(s)? This overwrites their existing bank details.` + (dupes ? `\n(${dupes} row(s) point at an already-chosen employee — the last one wins.)` : ""))) return;
  const btn = $("btnBankApply"); if (btn) { btn.disabled = true; btn.textContent = "Applying…"; }
  let ok = 0, fail = 0;
  for (const d of toApply) {
    const e = state.employees.find((x) => x.id === d.matchId);
    if (!e) { fail++; continue; }
    const body = { ...e, bankName: bankFromIfsc(d.ifsc) || e.bankName, accName: d.holder || e.accName, accNo: d.acc, ifsc: d.ifsc };
    delete body.id;
    try { await api("/api/employees/" + d.matchId, { method: "PUT", body }); ok++; }
    catch { fail++; }
  }
  closeModal();
  toast(`Bank details updated for ${ok} employee(s)${fail ? `, ${fail} failed` : ""}`);
  state.employees = []; loadEmployees();
}
$("btnAddUser").addEventListener("click", () => {
  openModal(`<h3>Add User</h3><div class="body">
    <div class="fld full"><label>Username</label><input id="u_name"></div>
    <div class="fld"><label>Role</label><select id="u_role"><option>hr</option><option>viewer</option><option>admin</option></select></div>
    <div class="fld"><label>Temporary Password</label><input id="u_pw" type="text" placeholder="Min 10, letters+numbers"></div></div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mSave">Create</button></div>`, { protect: true }); wireClose();
  $("mSave").addEventListener("click", async () => {
    try { await api("/api/users", { method: "POST", body: { username: $("u_name").value.trim(), role: $("u_role").value, password: $("u_pw").value } });
      closeModal(); toast("User created — they must change the password at first login"); loadUsers(); } catch (e) { toast(e.error, true); }
  });
});
function resetPwModal(id) {
  openModal(`<h3>Reset Password</h3><div class="body"><div class="fld full"><label>New Temporary Password</label><input id="rp_pw" type="text" placeholder="Min 10, letters+numbers"></div></div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mSave">Reset</button></div>`, { protect: true }); wireClose();
  $("mSave").addEventListener("click", async () => {
    try { await api(`/api/users/${id}/reset-password`, { method: "POST", body: { password: $("rp_pw").value } }); closeModal(); toast("Password reset"); } catch (e) { toast(e.error, true); }
  });
}

/* ================= APPROVALS (admin checker) ================= */
async function loadApprovals() {
  if (!isAdmin()) return;
  let d; try { d = await api("/api/approvals"); } catch (e) { return toast(e.error, true); }
  const card = (a) => `<div class="cmp-card" style="margin-bottom:12px">
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:240px">
        <b>${esc(a.summary)}</b>
        ${a.detail ? `<div class="hint" style="white-space:pre-line;margin-top:6px">${esc(a.detail)}</div>` : ""}
        <div class="hint" style="margin-top:6px">Requested by <b>${esc(a.requested_by_name)}</b> · ${esc((a.requested_at || "").slice(0, 16))}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" data-approve="${a.id}">✔ Approve</button>
        <button class="btn danger" data-rejectid="${a.id}">✖ Reject</button>
      </div>
    </div></div>`;
  $("aprPending").innerHTML = d.pending.length ? d.pending.map(card).join("")
    : '<div class="hint">Nothing waiting for approval. Changes made by HR users to salaries, bank details, advances or recoveries will appear here.</div>';
  $("aprDecided").innerHTML = d.decided.length ? d.decided.map((a) =>
    `<div class="mini"><span>${a.status === "approved" ? "✅" : "🚫"} ${esc(a.summary)}<br>
      <span class="hint">by ${esc(a.requested_by_name)} · ${esc(a.status)} by ${esc(a.decided_by || "—")} ${esc((a.decided_at || "").slice(0, 16))}${a.note ? " · " + esc(a.note) : ""}</span></span></div>`
  ).join("") : '<div class="hint">No decisions yet.</div>';
  $("aprPending").querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Approve and apply this change?")) return;
    try { await api(`/api/approvals/${b.dataset.approve}/approve`, { method: "POST", body: {} }); toast("Approved & applied"); loadApprovals(); }
    catch (e) { toast(e.error, true); }
  }));
  $("aprPending").querySelectorAll("[data-rejectid]").forEach((b) => b.addEventListener("click", async () => {
    const note = prompt("Reason for rejecting (optional):");
    if (note === null) return;
    try { await api(`/api/approvals/${b.dataset.rejectid}/reject`, { method: "POST", body: { note } }); toast("Rejected"); loadApprovals(); }
    catch (e) { toast(e.error, true); }
  }));
}
$("btnAprRefresh").addEventListener("click", () => loadApprovals());

/* ================= DASHBOARD ================= */
async function renderDashboard() {
  try { if (!state.employees.length) state.employees = (await api("/api/employees")).employees;
    state.advances = (await api("/api/advances")).advances; } catch (e) { return toast(e.error, true); }
  const all = state.employees, active = all.filter((e) => (e.status || "Active") !== "Inactive");
  const totWage = all.reduce((s, e) => s + (e.salary || 0), 0), actWage = active.reduce((s, e) => s + (e.salary || 0), 0);
  const locs = uniq("loc");
  $("dashKpis").innerHTML = `
    <div class="card clickable" data-goto="emp"><div class="k">Total Employees</div><div class="v">${all.length}</div></div>
    <div class="card clickable" data-goto="emp" data-fstatus="Active"><div class="k">Active</div><div class="v" style="color:var(--green)">${active.length}</div></div>
    <div class="card clickable" data-goto="emp" data-fstatus="Inactive"><div class="k">Inactive</div><div class="v" style="color:var(--red)">${all.length - active.length}</div></div>
    <div class="card clickable" data-goto="emp"><div class="k">Locations</div><div class="v">${locs.length}</div></div>
    <div class="card clickable" data-goto="pay"><div class="k">Monthly Wage (Active)</div><div class="v small">${fmt(actWage)}</div></div>
    <div class="card clickable" data-goto="emp"><div class="k">Avg Salary</div><div class="v small">${fmt(all.length ? totWage / all.length : 0)}</div></div>`;
  const byLoc = locs.map((l) => ({ k: l, v: all.filter((e) => e.loc === l).length, w: all.filter((e) => e.loc === l).reduce((s, e) => s + (e.salary || 0), 0) })).sort((a, b) => b.v - a.v);
  const dm = {}; all.forEach((e) => (dm[e.desig || "—"] = (dm[e.desig || "—"] || 0) + 1));
  const byDesig = Object.entries(dm).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 8);
  const out = state.advances.reduce((s, a) => s + a.balance, 0);
  $("dashGrid").innerHTML = `
    <div class="panel"><h4>Headcount by Location</h4>${bars(byLoc.map((x) => ({ k: x.k, v: x.v })), "b", false, "loc")}</div>
    <div class="panel"><h4>Monthly Wage by Location</h4>${bars(byLoc.map((x) => ({ k: x.k, v: x.w })), "", true, "loc")}</div>
    <div class="panel"><h4>Top Designations</h4>${bars(byDesig, "g", false, "desig")}</div>
    <div class="panel"><h4>Summary</h4>
      <div class="mini clickable" data-goto="emp"><span class="r">Total monthly wage</span><span>${fmt(totWage)}</span></div>
      <div class="mini clickable" data-goto="pay"><span class="r">Active wage bill</span><span>${fmt(actWage)}</span></div>
      <div class="mini clickable" data-goto="adv"><span class="r">Advances outstanding</span><span style="color:var(--brand2)">${fmt(out)}</span></div></div>`;
}
/** Bar chart. When `flt` ("loc" | "desig") is given, each bar links to the
 *  Employees tab filtered by that value. */
function bars(items, cls, cur, flt) {
  const max = Math.max(1, ...items.map((i) => i.v));
  return items.length ? items.map((i) => {
    const link = flt && i.k && i.k !== "—" ? ` clickable" data-goto="emp" data-f${flt}="${esc(i.k)}"` : '"';
    return `<div class="bar-row${link}><div class="bar-lbl">${esc(i.k)}</div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.max(3, Math.round(i.v / max * 100))}%"></div></div>
    <div class="bar-val">${cur ? fmt(i.v) : i.v}</div></div>`;
  }).join("") : '<div class="hint">No data.</div>';
}
$("dashKpis").addEventListener("click", onDashGoto);
$("dashGrid").addEventListener("click", onDashGoto);
function onDashGoto(e) {
  const c = e.target.closest("[data-goto]"); if (!c) return;
  const tab = c.dataset.goto;
  if (tab === "emp") {
    state.empPending = { status: c.dataset.fstatus || "", loc: c.dataset.floc || "", desig: c.dataset.fdesig || "" };
    switchTab("emp");
  } else switchTab(tab);
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

  const nCols = Math.max(1, ...rows.map((r) => r.length));
  const nRows = rows.length;
  const lastRef = `${col(nCols - 1)}${Math.max(1, nRows)}`;

  // Auto column widths from the longest value in each column (clamped).
  let cols = "<cols>";
  for (let c = 0; c < nCols; c++) {
    let w = 9;
    rows.forEach((r) => { const v = r[c]; if (v != null) w = Math.max(w, String(v).length + 2); });
    cols += `<col min="${c + 1}" max="${c + 1}" width="${Math.min(46, w).toFixed(1)}" customWidth="1"/>`;
  }
  cols += "</cols>";

  // Cell styles: 1 header, 2/3 text (plain/banded), 4/5 number (plain/banded).
  let sd = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' + cols + "<sheetData>";
  rows.forEach((row, r) => {
    const isHeader = r === 0, banded = !isHeader && r % 2 === 1;
    sd += `<row r="${r + 1}"${isHeader ? ' ht="18" customHeight="1"' : ""}>`;
    for (let c = 0; c < nCols; c++) {
      const cell = row[c], ref = col(c) + (r + 1);
      if (isHeader) sd += `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${xe(cell == null ? "" : cell)}</t></is></c>`;
      else if (typeof cell === "number" && isFinite(cell)) sd += `<c r="${ref}" s="${banded ? 5 : 4}"><v>${cell}</v></c>`;
      else sd += `<c r="${ref}" s="${banded ? 3 : 2}" t="inlineStr"><is><t xml:space="preserve">${xe(cell == null ? "" : cell)}</t></is></c>`;
    }
    sd += "</row>";
  });
  sd += `</sheetData><autoFilter ref="A1:${lastRef}"/></worksheet>`;

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="4">' +
    '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF2F6B1E"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F0"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FFD9DEE0"/></left><right style="thin"><color rgb="FFD9DEE0"/></right>' +
    '<top style="thin"><color rgb="FFD9DEE0"/></top><bottom style="thin"><color rgb="FFD9DEE0"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/></styleSheet>';

  const parts = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", styles],
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
["empSearch", "advSearch", "paySearch", "usrSearch"].forEach((id) => {
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
