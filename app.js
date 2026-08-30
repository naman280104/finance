// ---- helpers ---------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const fmt = (n) => inr.format(Math.round(n || 0));
const signed = (n) => (n >= 0 ? "+" : "") + inr.format(Math.round(n));

// Privacy: hide monetary amounts when the eye is off (persisted locally).
let HIDE_MONEY = localStorage.getItem("hideMoney") === "1";
const MASK = "••••••";
const money = (n) => (HIDE_MONEY ? MASK : fmt(n));            // masked when hidden
const moneySigned = (n) => (HIDE_MONEY ? MASK : signed(n));

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "request failed");
  return j;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

const CATEGORIES = ["Salary", "Food", "Groceries", "Rent", "Transport", "Shopping",
  "Bills & Utilities", "Entertainment", "Health", "Travel", "Investment",
  "Transfer", "EMI", "Cash", "Other", "Uncategorized"];

// ---- navigation ------------------------------------------------------------
$$("#nav button").forEach((b) => b.addEventListener("click", () => {
  $$("#nav button").forEach((x) => x.classList.remove("active"));
  $$(".view").forEach((v) => v.classList.remove("active"));
  b.classList.add("active");
  $("#" + b.dataset.view).classList.add("active");
  refreshView(b.dataset.view);
}));

function refreshView(v) {
  if (v === "dashboard") loadDashboard();
  if (v === "transactions") { loadAccountsInto(); loadTxns(); }
  if (v === "import") loadAccountsInto();
  if (v === "accounts") loadAccounts();
  if (v === "investments") loadInvestments();
  if (v === "payslips") loadPayslips();
  if (v === "tax") loadTax();
  if (v === "rules") loadRules();
}

// ---- shared account loading ------------------------------------------------
let ACCOUNTS = [];
async function loadAccountsInto() {
  ACCOUNTS = await api("GET", "/api/accounts");
  const opts = ACCOUNTS.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
  ["#t-account", "#imp-account"].forEach((id) => { if ($(id)) $(id).innerHTML = opts; });
  const optsAll = `<option value="">All</option>` + opts;
  if ($("#f-account")) $("#f-account").innerHTML = optsAll;
}

function fillCatlist() {
  $("#catlist").innerHTML = CATEGORIES.map((c) => `<option value="${c}">`).join("");
}

// ---- header net worth ------------------------------------------------------
async function refreshHeader() {
  const nw = await api("GET", "/api/networth");
  $("#hdr-networth").textContent = money(nw.net_worth);
}

function applyEye() { $("#eye-toggle").textContent = HIDE_MONEY ? "🙈" : "👁"; }
$("#eye-toggle").addEventListener("click", () => {
  HIDE_MONEY = !HIDE_MONEY;
  localStorage.setItem("hideMoney", HIDE_MONEY ? "1" : "0");
  applyEye();
  refreshHeader();
  const active = $("#nav button.active");
  if (active) refreshView(active.dataset.view);   // re-render current tab with/without amounts
});

// ---- months dropdowns ------------------------------------------------------
function monthLabel(m) {
  const [y, mo] = m.split("-");
  return new Date(y, mo - 1, 1).toLocaleString("en-IN", { month: "short", year: "numeric" });
}
async function loadMonths() {
  const months = await api("GET", "/api/months");
  const dash = $("#dash-month"), fm = $("#f-month");
  const dashVal = dash.value, fmVal = fm.value;   // preserve current selections
  dash.innerHTML = months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join("");
  fm.innerHTML = `<option value="">All time</option>` + months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join("");
  if (dashVal && months.includes(dashVal)) dash.value = dashVal;
  fm.value = fmVal;   // "" (All time) or a valid month both round-trip
  return months;
}

// ---- dashboard -------------------------------------------------------------
async function loadDashboard() {
  const months = await loadMonths();
  if (!$("#dash-month").value && months.length) $("#dash-month").value = months[0];
  const month = $("#dash-month").value;
  const d = await api("GET", "/api/dashboard" + (month ? "?month=" + month : ""));

  $("#dash-cards").innerHTML = `
    <div class="card"><div class="label">Income</div><div class="value pos">${fmt(d.income)}</div></div>
    <div class="card"><div class="label">Expenses</div><div class="value neg">${fmt(d.expense)}</div></div>
    <div class="card"><div class="label">Saved</div><div class="value ${d.savings >= 0 ? "pos" : "neg"}">${fmt(d.savings)}</div>
      <div class="sub">${d.salary ? (d.savings_rate_salary * 100).toFixed(0) + "% of salary" : (d.savings_rate * 100).toFixed(0) + "% of income"}</div></div>
    <div class="card"><div class="label">Invested</div><div class="value amber">${fmt(d.invested || 0)}</div></div>
    <div class="card"><div class="label">Moved / transfers</div><div class="value">${fmt(Math.abs(d.transfer))}</div></div>`;

  const max = Math.max(1, ...d.categories.map((c) => c.total));
  $("#dash-cats").innerHTML = d.categories.length
    ? d.categories.map((c) => `
      <div class="barrow"><div class="name">${c.category}</div>
      <div class="track"><div class="fill" style="width:${(c.total / max * 100).toFixed(1)}%"></div></div>
      <div class="amt">${fmt(c.total)}</div></div>`).join("")
    : `<p class="muted">No expenses recorded for this period.</p>`;

  const inc = d.income_categories || [];
  const imax = Math.max(1, ...inc.map((c) => c.total));
  $("#dash-income-cats").innerHTML = inc.length
    ? inc.map((c) => `
      <div class="barrow"><div class="name">${c.category}</div>
      <div class="track"><div class="fill" style="width:${(c.total / imax * 100).toFixed(1)}%; background:var(--green)"></div></div>
      <div class="amt">${fmt(c.total)}</div></div>`).join("")
    : `<p class="muted">No income recorded for this period.</p>`;

  const trend = await api("GET", "/api/trend?months=12");
  const tmax = Math.max(1, ...trend.map((t) => Math.max(t.income, t.expense)));
  $("#dash-trend").innerHTML = trend.map((t) => `
    <div class="col"><div class="bars">
      <div class="b inc" style="height:${(t.income / tmax * 100).toFixed(1)}%" title="Income ${fmt(t.income)}"></div>
      <div class="b exp" style="height:${(t.expense / tmax * 100).toFixed(1)}%" title="Expense ${fmt(t.expense)}"></div>
    </div><div class="m">${monthLabel(t.month).replace(" ", "'")}</div></div>`).join("")
    || `<p class="muted">No data yet.</p>`;
}
document.addEventListener("change", (e) => { if (e.target.id === "dash-month") loadDashboard(); });

// ---- transactions ----------------------------------------------------------
async function loadCategoryFilter() {
  const cats = await api("GET", "/api/categories");
  const fc = $("#f-category"), cur = fc.value;   // preserve selection
  fc.innerHTML = `<option value="">All</option>` + cats.map((c) => `<option value="${c}">${c}</option>`).join("");
  fc.value = cur;
}
async function loadTxns() {
  await loadMonths();
  await loadCategoryFilter();
  const qs = new URLSearchParams();
  if ($("#f-month").value) qs.set("month", $("#f-month").value);
  if ($("#f-account").value) qs.set("account", $("#f-account").value);
  if ($("#f-category").value) qs.set("category", $("#f-category").value);
  if ($("#f-type").value) qs.set("type", $("#f-type").value);
  if ($("#f-search").value.trim()) qs.set("q", $("#f-search").value.trim());
  const txns = await api("GET", "/api/transactions?" + qs.toString());
  const typeOpts = (sel) => ["income", "expense", "transfer"].map((t) => `<option ${t === sel ? "selected" : ""}>${t}</option>`).join("");
  $("#txn-body").innerHTML = txns.map((t) => `
    <tr data-id="${t.id}">
      <td>${t.date}</td>
      <td>${t.account_name}</td>
      <td>${t.description || ""}</td>
      <td><input class="mini edit-cat" list="catlist" value="${(t.category || "").replace(/"/g, "&quot;")}" style="width:120px"></td>
      <td><select class="mini edit-type">${typeOpts(t.type)}</select></td>
      <td class="num ${t.amount >= 0 ? "pos" : "neg"}">${signed(t.amount)}</td>
      <td><button class="btn danger del-txn">Del</button></td>
    </tr>`).join("") || `<tr><td colspan="7" class="muted">No transactions. Add one above or import a statement.</td></tr>`;
}
["#f-month", "#f-account", "#f-category", "#f-type"].forEach((id) =>
  document.addEventListener("change", (e) => { if (e.target.matches(id)) loadTxns(); }));
let searchTimer;
document.addEventListener("input", (e) => {
  if (e.target.matches("#f-search")) { clearTimeout(searchTimer); searchTimer = setTimeout(loadTxns, 250); }
});

$("#t-add").addEventListener("click", async () => {
  const amount = parseFloat($("#t-amount").value);
  if (!$("#t-date").value || isNaN(amount)) return toast("Date and amount required");
  await api("POST", "/api/transactions", {
    account_id: +$("#t-account").value, date: $("#t-date").value, amount,
    description: $("#t-desc").value, category: $("#t-cat").value, type: $("#t-type").value || undefined,
  });
  $("#t-amount").value = $("#t-desc").value = $("#t-cat").value = "";
  toast("Added"); loadTxns(); refreshHeader();
});

document.addEventListener("click", async (e) => {
  if (e.target.matches(".del-txn")) {
    const tr = e.target.closest("tr");
    const desc = tr.children[2].textContent.trim();
    const amt = tr.children[5].textContent.trim();
    if (!confirm(`Delete this transaction?\n\n${amt}  ${desc}`)) return;
    await api("DELETE", "/api/transactions/" + tr.dataset.id);
    loadTxns(); refreshHeader(); toast("Deleted");
  }
});
document.addEventListener("change", async (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  if (e.target.matches(".edit-cat") || e.target.matches(".edit-type")) {
    await api("PATCH", "/api/transactions/" + tr.dataset.id, {
      category: $(".edit-cat", tr).value, type: $(".edit-type", tr).value,
    });
    toast("Updated"); refreshHeader();
  }
});

// ---- CSV parsing -----------------------------------------------------------
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function parseNum(s) {
  if (s == null) return NaN;
  const cleaned = String(s).replace(/[₹,\s]/g, "").replace(/(cr|dr)$/i, "").trim();
  if (cleaned === "" || cleaned === "-") return NaN;
  return parseFloat(cleaned);
}

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function pad(n) { return String(n).padStart(2, "0"); }
function iso(y, m, d) {
  y = +y; if (y < 100) y += 2000;
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
function parseDate(str, fmt) {
  if (!str) return null;
  str = str.trim();
  // strip a trailing time like "04/12/2025 / 21:50" or "04-12-2025 21:50"
  str = str.replace(/\s*\/?\s*\d{1,2}:\d{2}(:\d{2})?.*$/, "").trim();
  const monMatch = str.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{2,4})/);
  const num = str.match(/^(\d{1,4})[-\/](\d{1,2})[-\/](\d{1,4})/);
  const tryMon = () => monMatch && iso(monMatch[3], MONTHS[monMatch[2].slice(0,3).toLowerCase()], monMatch[1]);
  if (fmt === "dMonY") return tryMon();
  if (!num) return tryMon();
  const [_, a, b, c] = num;
  switch (fmt) {
    case "dmy": case "dmy2": return iso(c, b, a);
    case "ymd": return iso(a, b, c);
    case "mdy": return iso(c, a, b);
    default: // auto
      if (tryMon()) return tryMon();
      if (a.length === 4) return iso(a, b, c);        // YYYY-MM-DD
      if (+a > 12) return iso(c, b, a);               // DD/MM/YYYY
      return iso(c, b, a);                            // assume DD/MM (India)
  }
}

// ---- import flow -----------------------------------------------------------
let CSV = { headers: [], rows: [] };
let RAW = [];
let RAW_TEXT = "";     // whitespace-stripped, lowercased blob of the file for identifier checks
let PREVIEW = [];

// Warn if the loaded file doesn't look like the selected account's statement.
function checkAccountMatch() {
  const warn = $("#imp-account-warn");
  warn.style.display = "none"; warn.textContent = "";
  if (!RAW_TEXT) return;
  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, "");
  const accId = +$("#imp-account").value;
  const sel = ACCOUNTS.find((a) => a.id === accId);
  const other = ACCOUNTS.find((a) => a.id !== accId && a.identifier && RAW_TEXT.includes(norm(a.identifier)));
  let msg = "";
  if (sel && sel.identifier && !RAW_TEXT.includes(norm(sel.identifier))) {
    msg = `⚠️ This file doesn't contain "${sel.identifier}" (the identifier for ${sel.name}) — check you picked the right account.`;
    if (other) msg += ` It looks like a ${other.name} statement.`;
  } else if (other && !(sel && sel.identifier)) {
    msg = `⚠️ This file looks like a ${other.name} statement, but you selected ${sel ? sel.name : "another account"}.`;
  }
  if (msg) { warn.textContent = msg; warn.style.display = ""; }
}

// Bank CSVs often have preamble rows (name/address/period) before the header.
// Score each of the first rows by how many bank-ish keywords it contains.
const HEADER_KW = /date|narrat|descrip|particular|details|debit|credit|withdraw|deposit|amount|balance|txn|transaction|remark|chq|cheque|ref\b|reference|reward|stock\s*name|scheme|isin|quantity|\bqty\b|units|invested|current\s*value|buy\s*value|sell\s*value|avg|gain/i;
function detectHeaderRow(rows) {
  let best = 0, bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const score = rows[i].filter((c) => HEADER_KW.test(c)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}
function renderRawPreview() {
  const rows = RAW.slice(0, 12);
  const hr = (parseInt($("#map-headerrow").value) || 1) - 1;
  $("#imp-raw").innerHTML = rows.map((r, i) =>
    `<tr style="${i === hr ? "background:var(--panel2);font-weight:600" : ""}">
      <td class="muted" style="width:40px">${i + 1}</td>` +
    r.map((c) => `<td>${(c || "").slice(0, 30)}</td>`).join("") + `</tr>`).join("");
}

// Read a bank/statement file into a 2D array of strings, from CSV/TXT or
// Excel (.xls/.xlsx via vendored SheetJS). All parsing is local/offline. cb(rows).
function readRows(file, cb) {
  const name = file.name.toLowerCase();
  const isXls = /\.xlsx?$/.test(name);
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      let rows;
      if (isXls && window.XLSX) {
        let data = new Uint8Array(reader.result);
        let wb;
        try {
          wb = XLSX.read(data, { type: "array" });
        } catch (err) {
          if (!/password/i.test(err.message || "")) throw err;
          // Password-protected: decrypt locally on the server (msoffcrypto),
          // then parse the decrypted bytes here. File + password never leave this machine.
          const pw = prompt("This Excel file is password-protected. Enter the password to unlock it:");
          if (pw == null) return;   // cancelled
          try {
            const res = await api("POST", "/api/decrypt", { data: u8ToB64(data), password: pw });
            data = b64ToU8(res.data);
            wb = XLSX.read(data, { type: "array" });
          } catch (e2) {
            toast(/incorrect password/i.test(e2.message || "")
              ? "Incorrect password — try again."
              : "Couldn't unlock file: " + e2.message);
            return;
          }
        }
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" })
          .map((r) => r.map((c) => (c == null ? "" : String(c))))
          .filter((r) => r.some((c) => c.trim() !== ""));
      } else {
        rows = parseCSV(reader.result);
      }
      if (!rows || rows.length < 2) return toast("Couldn't read rows from that file");
      cb(rows);
    } catch (err) { toast("Could not read file: " + err.message); }
  };
  if (isXls) reader.readAsArrayBuffer(file); else reader.readAsText(file);
}

// base64 <-> Uint8Array (chunked, safe for large files)
function u8ToB64(u8) {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}
function b64ToU8(b64) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

$("#imp-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  readRows(file, (rows) => {
    RAW = rows;
    RAW_TEXT = rows.flat().join(" ").toLowerCase().replace(/\s+/g, "");
    checkAccountMatch();
    $("#map-headerrow").value = detectHeaderRow(RAW) + 1;
    renderRawPreview();
    applyHeaderRow();
    $("#imp-map-panel").style.display = "";
    $("#imp-preview-panel").style.display = "none";
  });
});
$("#imp-account").addEventListener("change", checkAccountMatch);

function applyHeaderRow() {
  const hr = Math.max(1, parseInt($("#map-headerrow").value) || 1) - 1;
  CSV.headers = (RAW[hr] || []).map((h, i) => h.trim() || `Column ${i + 1}`);
  CSV.rows = RAW.slice(hr + 1);
  const opts = CSV.headers.map((h, i) => `<option value="${i}">${h}</option>`).join("");
  ["#map-date", "#map-desc", "#map-debit", "#map-credit", "#map-amount", "#map-drcr"].forEach((id) => $(id).innerHTML = opts);
  guess("#map-date", /date|txn date|value date|date\s*&?\s*time/i);
  // description: prefer explicit description-y names; avoid "Transaction type" which merely contains the word "transaction"
  const descIdx = guess("#map-desc", /^description$|narration|particular|^details?$|remark/i);
  if (descIdx < 0) guess("#map-desc", /desc|detail|transaction(?!\s*type)/i);
  const debitIdx = guess("#map-debit", /^debit$|withdraw|debit\s*amt|dr\s*amt/i);
  const creditIdx = guess("#map-credit", /^credit$|deposit|credit\s*amt|cr\s*amt/i);
  guess("#map-amount", /^amt\b|amount|txn\s*amt/i);   // matches "Amount (INR)"
  // Dr/Cr indicator column (NOT "Transaction type" which is a category like Domestic/International)
  const drcrIdx = guess("#map-drcr", /debit\s*\/\s*credit|dr\s*\/\s*cr|cr\s*\/\s*dr|^dr\/cr$|indicator/i);
  // auto-pick amount style. Split (separate Debit+Credit) wins when both exist —
  // credit-card single-amount styles only apply when there are NO split columns.
  const amtIdx = +$("#map-amount").value;
  const amtHead = CSV.headers[amtIdx] || "";
  const hasSplit = debitIdx >= 0 && creditIdx >= 0;
  const sampleHasInlineDrCr = amtIdx >= 0 && CSV.rows.slice(0, 20)
    .some((r) => /\b(dr|cr)\b|debit|credit/i.test(r[amtIdx] || ""));
  let style = "split";
  if (!hasSplit && amtIdx >= 0 && /amount|^amt$/i.test(amtHead) && sampleHasInlineDrCr) {
    style = "single_inline";                        // "999 Dr." style
  } else if (!hasSplit && drcrIdx >= 0 && /^amt$|amount/i.test(amtHead)) {
    style = "single_drcr";                          // separate Dr/Cr indicator column
  }
  $("#map-style").value = style;
  $("#map-style").dispatchEvent(new Event("change"));
  if (style !== "split") $("#map-drcr-default").value = "dr";
  renderRawPreview();
  $("#imp-rawinfo").textContent = `${CSV.rows.length} data rows · columns: ${CSV.headers.join(", ")}`;
}
$("#map-headerrow").addEventListener("change", applyHeaderRow);
$("#map-headerrow").addEventListener("input", renderRawPreview);

function guess(sel, re) {
  const i = CSV.headers.findIndex((h) => re.test(h));
  if (i >= 0) $(sel).value = i;
  return i;
}
$("#map-style").addEventListener("change", () => {
  const style = $("#map-style").value;
  document.querySelectorAll("[data-style]").forEach((el) => {
    const styles = el.getAttribute("data-style").split(/\s+/);
    el.style.display = styles.includes(style) ? "" : "none";
  });
});

function buildRows() {
  const acc = +$("#imp-account").value;
  const dCol = +$("#map-date").value, descCol = +$("#map-desc").value;
  const fmt = $("#map-datefmt").value, style = $("#map-style").value;
  const out = [];
  for (const r of CSV.rows) {
    const date = parseDate(r[dCol], fmt);
    if (!date) continue;
    let amount;
    if (style === "single") {
      amount = parseNum(r[+$("#map-amount").value]);
      if ($("#map-sign").value === "flip") amount = -amount;
    } else if (style === "single_drcr") {
      amount = parseNum(r[+$("#map-amount").value]);
      if (isNaN(amount) || amount === 0) continue;
      // strip ALL whitespace (incl. nbsp/tabs) then normalize to lowercase word
      const marker = (r[+$("#map-drcr").value] || "").replace(/[\s\W_]+/g, "").toLowerCase();
      const isCr = /^cr$|^credit$|^\+$/.test(marker);
      const isDr = /^dr$|^debit$|^\-$/.test(marker);
      const defaultCr = $("#map-drcr-default").value === "cr";
      const finallyCr = isCr || (!isDr && defaultCr);
      amount = finallyCr ? Math.abs(amount) : -Math.abs(amount);
    } else if (style === "single_inline") {
      const cell = r[+$("#map-amount").value] || "";
      amount = parseNum(cell);
      if (isNaN(amount) || amount === 0) continue;
      const low = cell.toLowerCase();
      const isCr = /\bcr\b|credit/.test(low);   // "899 Cr."
      const isDr = /\bdr\b|debit/.test(low);    // "999 Dr."
      const defaultCr = $("#map-drcr-default").value === "cr";
      const finallyCr = isCr || (!isDr && defaultCr);
      amount = finallyCr ? Math.abs(amount) : -Math.abs(amount);
    } else {
      const dr = parseNum(r[+$("#map-debit").value]);
      const cr = parseNum(r[+$("#map-credit").value]);
      if (!isNaN(cr) && cr !== 0) amount = Math.abs(cr);
      else if (!isNaN(dr) && dr !== 0) amount = -Math.abs(dr);
      else continue;
    }
    if (isNaN(amount) || amount === 0) continue;
    out.push({ account_id: acc, date, amount, description: (r[descCol] || "").trim() });
  }
  return out;
}

$("#imp-preview").addEventListener("click", async () => {
  const rows = buildRows();
  if (!rows.length) return toast("No valid rows — check your column/date mapping");
  const res = await api("POST", "/api/preview", { rows });
  PREVIEW = res.rows;
  const dupes = PREVIEW.filter((r) => r.duplicate).length;
  $("#imp-summary").textContent = `${PREVIEW.length} transactions parsed · ${dupes} already imported (will be skipped) · ${PREVIEW.length - dupes} new`;
  $("#imp-body").innerHTML = PREVIEW.map((r) => `
    <tr class="${r.duplicate ? "dupe" : ""}">
      <td>${r.date}</td><td>${r.description}</td><td>${r.category}</td>
      <td><span class="tag ${r.type}">${r.type}</span></td>
      <td class="num ${r.amount >= 0 ? "pos" : "neg"}">${signed(r.amount)}</td>
      <td>${r.duplicate ? "duplicate" : "new"}</td></tr>`).join("");
  $("#imp-preview-panel").style.display = "";
});

$("#imp-commit").addEventListener("click", async () => {
  const acc = ACCOUNTS.find((a) => a.id === +$("#imp-account").value);
  const dates = PREVIEW.map((r) => r.date).sort();
  const range = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "";
  const newCount = PREVIEW.filter((r) => !r.duplicate).length;
  let msg = `Import ${newCount} new transaction(s)${range ? " (" + range + ")" : ""} into "${acc ? acc.name : "?"}"?`;
  if ($("#imp-account-warn").style.display !== "none" && $("#imp-account-warn").textContent) {
    msg += "\n\n" + $("#imp-account-warn").textContent;
  }
  if (!confirm(msg)) return;
  let rows = PREVIEW.map(({ account_id, date, amount, description }) => ({ account_id, date, amount, description }));
  const res = await api("POST", "/api/transactions/bulk", { rows });
  toast(`Imported ${res.inserted}, skipped ${res.skipped} duplicates`);
  $("#imp-preview-panel").style.display = "none";
  $("#imp-map-panel").style.display = "none";
  $("#imp-file").value = "";
  refreshHeader();
});

// ---- accounts --------------------------------------------------------------
const ACCT_TYPE = { bank: "Bank", credit_card: "Credit card", cash: "Cash" };
async function loadAccounts() {
  const settings = await api("GET", "/api/settings");
  $("#opt-respect-open").checked = settings.respect_opening_date !== false;  // default on
  const accts = await api("GET", "/api/accounts");
  $("#acct-body").innerHTML = accts.map((a) => `
    <tr data-id="${a.id}">
      <td>${a.name}</td><td>${ACCT_TYPE[a.type] || a.type}</td>
      <td>${a.identifier || "<span class='muted'>—</span>"}</td>
      <td class="num">${money(a.opening_balance)}</td>
      <td class="num ${HIDE_MONEY ? "" : (a.balance >= 0 ? "pos" : "neg")}">${money(a.balance)}</td>
      <td><button class="btn danger del-acct">Delete</button></td></tr>`).join("")
    || `<tr><td colspan="6" class="muted">No accounts yet. Add your banks and cards above.</td></tr>`;
}
$("#a-add").addEventListener("click", async () => {
  if (!$("#a-name").value) return toast("Name required");
  await api("POST", "/api/accounts", {
    name: $("#a-name").value, type: $("#a-type").value,
    opening_balance: parseFloat($("#a-open").value) || 0, opening_date: $("#a-date").value,
    identifier: $("#a-id").value,
  });
  $("#a-name").value = $("#a-open").value = $("#a-id").value = "";
  toast("Account added"); loadAccounts(); refreshHeader();
});
document.addEventListener("click", async (e) => {
  if (e.target.matches(".del-acct")) {
    const id = e.target.closest("tr").dataset.id;
    if (!confirm("Delete this account AND all its transactions?")) return;
    await api("DELETE", "/api/accounts/" + id);
    loadAccounts(); refreshHeader(); toast("Deleted");
  }
});
$("#opt-respect-open").addEventListener("change", async (e) => {
  await api("POST", "/api/settings", { key: "respect_opening_date", value: e.target.checked });
  toast(e.target.checked ? "Opening dates now respected" : "Counting all transactions");
  refreshHeader();
  const active = $("#nav button.active");
  if (active) refreshView(active.dataset.view);
});

// ---- investments -----------------------------------------------------------
const INV_TYPE = { fd: "FD", stock: "Stocks", mf: "Mutual Fund", other: "Other" };
async function loadInvestments() {
  const inv = await api("GET", "/api/investments");
  $("#inv-body").innerHTML = inv.map((i) => {
    const gain = i.current_value - i.invested_amount;
    return `<tr data-id="${i.id}">
      <td>${i.name}</td><td>${INV_TYPE[i.type] || i.type}</td>
      <td class="num">${fmt(i.invested_amount)}</td>
      <td class="num"><input class="mini edit-cur" type="number" value="${i.current_value}" style="width:110px"></td>
      <td class="num ${gain >= 0 ? "pos" : "neg"}">${signed(gain)}</td>
      <td>${i.maturity_date || "—"}</td>
      <td><button class="btn danger del-inv">Del</button></td></tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">No investments yet. Add your FDs and stock/MF holdings above.</td></tr>`;
}
$("#i-add").addEventListener("click", async () => {
  if (!$("#i-name").value) return toast("Name required");
  await api("POST", "/api/investments", {
    type: $("#i-type").value, name: $("#i-name").value,
    invested_amount: parseFloat($("#i-invested").value) || 0,
    current_value: parseFloat($("#i-current").value) || parseFloat($("#i-invested").value) || 0,
    rate: parseFloat($("#i-rate").value) || null, maturity_date: $("#i-maturity").value || null,
  });
  ["#i-name", "#i-invested", "#i-current", "#i-rate"].forEach((id) => $(id).value = "");
  toast("Investment added"); loadInvestments(); refreshHeader();
});
document.addEventListener("click", async (e) => {
  if (e.target.matches(".del-inv")) {
    if (!confirm("Delete this investment?")) return;
    await api("DELETE", "/api/investments/" + e.target.closest("tr").dataset.id);
    loadInvestments(); refreshHeader(); toast("Deleted");
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.matches(".edit-cur")) {
    const id = e.target.closest("tr").dataset.id;
    await api("PATCH", "/api/investments/" + id, { current_value: parseFloat(e.target.value) || 0 });
    loadInvestments(); refreshHeader(); toast("Updated");
  }
});

// ---- rules -----------------------------------------------------------------
let RULES = [];
async function loadRules() {
  RULES = await api("GET", "/api/rules");
  $("#rule-body").innerHTML = RULES.map((r, i) => `
    <tr data-id="${r.id}">
      <td style="white-space:nowrap">
        <button class="btn mini rule-up" ${i === 0 ? "disabled" : ""}>▲</button>
        <button class="btn mini rule-down" ${i === RULES.length - 1 ? "disabled" : ""}>▼</button>
      </td>
      <td>${r.pattern}</td><td>${r.category}</td>
      <td>${r.txn_type || "<span class='muted'>auto</span>"}</td>
      <td class="num">${r.usage_count}</td>
      <td><button class="btn danger del-rule">Del</button></td></tr>`).join("")
    || `<tr><td colspan="6" class="muted">No rules yet.</td></tr>`;
}
$("#r-add").addEventListener("click", async () => {
  if (!$("#r-pattern").value || !$("#r-cat").value) return toast("Pattern and category required");
  await api("POST", "/api/rules", {
    pattern: $("#r-pattern").value, category: $("#r-cat").value, txn_type: $("#r-type").value || undefined,
  });
  $("#r-pattern").value = $("#r-cat").value = "";
  toast("Rule added"); loadRules();
});
$("#r-reset").addEventListener("click", async () => {
  if (!confirm("Reset ALL transactions to Uncategorized?\n\nThis clears every category and transfer tag (type goes back to income/expense by amount sign). Your rules are kept — you can re-apply them after.")) return;
  const res = await api("POST", "/api/transactions/reset-categories");
  toast(`Reset ${res.reset} transactions to Uncategorized`);
  refreshHeader();
  loadTxns();
  if ($("#dashboard").classList.contains("active")) loadDashboard();
});
$("#r-apply").addEventListener("click", async () => {
  const res = await api("POST", "/api/rules/apply");
  toast(res.updated
    ? `Re-categorized ${res.updated} transaction(s). Check the Transactions tab.`
    : "No transactions matched any rule. Check your patterns (use a short substring like BILLPAY, not the full text).");
  refreshHeader();
  loadTxns();            // refresh the list so updated categories show
  if ($("#dashboard").classList.contains("active")) loadDashboard();
});
document.addEventListener("click", async (e) => {
  if (e.target.matches(".del-rule")) {
    const id = e.target.closest("tr").dataset.id;
    const r = RULES.find((x) => String(x.id) === id);
    const n = r ? r.usage_count : 0;
    if (!confirm(n
      ? `Delete this rule?\n${n} transaction(s) it categorized will be reset to Uncategorized.`
      : "Delete this rule?")) return;
    const res = await api("DELETE", "/api/rules/" + id);
    loadRules(); loadTxns(); refreshHeader();
    toast(res.uncategorized ? `Rule deleted · ${res.uncategorized} reset to Uncategorized` : "Rule deleted");
  }
  // reorder precedence
  if (e.target.matches(".rule-up") || e.target.matches(".rule-down")) {
    const id = +e.target.closest("tr").dataset.id;
    const idx = RULES.findIndex((x) => x.id === id);
    const swap = e.target.matches(".rule-up") ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= RULES.length) return;
    [RULES[idx], RULES[swap]] = [RULES[swap], RULES[idx]];
    await api("POST", "/api/rules/reorder", { order: RULES.map((x) => x.id) });
    loadRules();
  }
});

// ---- generic CSV file → column mapping -------------------------------------
// Generic multi-section importer with a raw preview + adjustable header row.
function loadCsvFile(inputSel, selectSels, mapPanelSel, infoSel, guesses, previewSel, headerSel) {
  const file = $(inputSel).files[0];
  if (!file) return;
  readRows(file, (all) => {
    const panel = $(mapPanelSel);
    panel._all = all;
    panel._cfg = { selectSels, infoSel, guesses, previewSel, headerSel };
    if (headerSel) $(headerSel).value = detectHeaderRow(all) + 1;
    applyGenericHeader(mapPanelSel);
    panel.style.display = "";
  });
}
function renderGenericPreview(panelSel) {
  const panel = $(panelSel), { previewSel, headerSel } = panel._cfg;
  if (!previewSel) return;
  const hr = (parseInt($(headerSel).value) || 1) - 1;
  $(previewSel).innerHTML = panel._all.slice(0, 12).map((r, i) =>
    `<tr style="${i === hr ? "background:var(--panel2);font-weight:600" : ""}"><td class="muted" style="width:36px">${i + 1}</td>` +
    r.map((c) => `<td>${(c || "").slice(0, 26)}</td>`).join("") + `</tr>`).join("");
}
function applyGenericHeader(panelSel) {
  const panel = $(panelSel), { selectSels, infoSel, guesses, headerSel } = panel._cfg;
  const hr = headerSel ? Math.max(1, parseInt($(headerSel).value) || 1) - 1 : detectHeaderRow(panel._all);
  const headers = (panel._all[hr] || []).map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows = panel._all.slice(hr + 1);
  const opts = `<option value="-1">— none —</option>` +
    headers.map((h, i) => `<option value="${i}">${h}</option>`).join("");
  selectSels.forEach((s) => { $(s).innerHTML = opts; });
  (guesses || []).forEach(([sel, re]) => {
    const i = headers.findIndex((h) => re.test(h));
    if (i >= 0) $(sel).value = i;
  });
  panel._csv = { headers, rows };
  renderGenericPreview(panelSel);
  if (infoSel) $(infoSel).textContent = `${rows.length} rows · columns: ${headers.join(", ")}`;
}
// re-map when the header row is changed on a Groww panel
["#gh-headerrow", "#cg-headerrow"].forEach((id) =>
  document.addEventListener("input", (e) => {
    if (!e.target.matches(id)) return;
    applyGenericHeader(id === "#gh-headerrow" ? "#gh-map" : "#cg-map");
    const pv = id === "#gh-headerrow" ? "#gh-preview-panel" : "#cg-preview-panel";
    $(pv).style.display = "none";   // header changed → stale preview
  }));
const col = (rows, r, sel) => { const i = +$(sel).value; return i < 0 ? "" : (r[i] || "").trim(); };

// ---- payslips --------------------------------------------------------------
async function loadPayslips() {
  const ps = await api("GET", "/api/payslips");
  $("#ps-body").innerHTML = ps.map((p) => `
    <tr data-id="${p.id}"><td>${monthLabel(p.month)}</td><td>${p.employer || ""}</td>
    <td class="num">${fmt(p.gross)}</td><td class="num">${fmt(p.tds)}</td>
    <td class="num">${fmt(p.net_pay)}</td>
    <td><button class="btn danger del-ps">Del</button></td></tr>`).join("")
    || `<tr><td colspan="6" class="muted">No payslips yet.</td></tr>`;
}
$("#ps-add").addEventListener("click", async () => {
  if (!$("#ps-month").value) return toast("Month required");
  const num = (id) => parseFloat($(id).value) || 0;
  await api("POST", "/api/payslips", {
    month: $("#ps-month").value, employer: $("#ps-employer").value,
    basic: num("#ps-basic"), hra: num("#ps-hra"), allowances: num("#ps-allow"),
    gross: $("#ps-gross").value ? num("#ps-gross") : undefined,
    pf: num("#ps-pf"), professional_tax: num("#ps-pt"),
    tds: num("#ps-tds"), other_deductions: num("#ps-other"),
  });
  ["#ps-basic","#ps-hra","#ps-allow","#ps-gross","#ps-pf","#ps-pt","#ps-tds","#ps-other","#ps-paste"].forEach((id)=>$(id).value="");
  toast("Payslip saved"); loadPayslips();
});
document.addEventListener("click", async (e) => {
  if (e.target.matches(".del-ps")) {
    if (!confirm("Delete this payslip?")) return;
    await api("DELETE", "/api/payslips/" + e.target.closest("tr").dataset.id);
    loadPayslips(); toast("Deleted");
  }
});
$("#ps-autofill").addEventListener("click", () => {
  const t = $("#ps-paste").value;
  const grab = (re) => { const m = t.match(re); return m ? parseNum(m[1]) : null; };
  const set = (id, v) => { if (v != null && !isNaN(v)) $(id).value = v; };
  set("#ps-basic", grab(/basic[^0-9]*([\d,]+\.?\d*)/i));
  set("#ps-hra", grab(/h\.?r\.?a[^0-9]*([\d,]+\.?\d*)/i));
  set("#ps-gross", grab(/gross[^0-9]*([\d,]+\.?\d*)/i));
  set("#ps-pf", grab(/(?:provident fund|pf)[^0-9]*([\d,]+\.?\d*)/i));
  set("#ps-pt", grab(/prof(?:essional)?\.?\s*tax[^0-9]*([\d,]+\.?\d*)/i));
  set("#ps-tds", grab(/(?:tds|income tax|tax deducted)[^0-9]*([\d,]+\.?\d*)/i));
  const mo = t.match(/(\d{4})[-\/](\d{2})/) || t.match(/([A-Za-z]{3,})\s*(\d{4})/);
  if (mo && mo[1].length === 4) $("#ps-month").value = `${mo[1]}-${mo[2]}`;
  toast("Auto-filled — please verify the numbers");
});

// ---- groww holdings import -------------------------------------------------
$("#gh-file").addEventListener("change", () =>
  loadCsvFile("#gh-file", ["#gh-name","#gh-invested","#gh-current","#gh-qty"], "#gh-map", "#gh-info",
    [["#gh-name", /stock\s*name|scheme\s*name|company|scrip|^name$|symbol|isin/i],
     ["#gh-invested", /invested|buy\s*value|buy\s*avg|avg.*(price|cost)|purchase|cost\s*value|amount\s*invested/i],
     ["#gh-current", /current\s*value|market\s*value|closing\s*value|ltp|current\s*price/i],
     ["#gh-qty", /qty|quantity|units|shares/i]],
    "#gh-raw", "#gh-headerrow"));
let GH_ROWS = [];
$("#gh-preview").addEventListener("click", () => {
  const { rows } = $("#gh-map")._csv;
  const type = $("#gh-type").value;
  GH_ROWS = [];
  for (const r of rows) {
    const name = col(rows, r, "#gh-name");
    if (!name) continue;
    GH_ROWS.push({ name, type,
      invested_amount: parseNum(col(rows, r, "#gh-invested")) || 0,
      current_value: parseNum(col(rows, r, "#gh-current")) || 0,
      quantity: parseNum(col(rows, r, "#gh-qty")) || null });
  }
  if (!GH_ROWS.length) return toast("No rows parsed — check the Name column & header row");
  $("#gh-summary").textContent = `${GH_ROWS.length} holdings parsed. Importing replaces all current Groww holdings.`;
  $("#gh-preview-body").innerHTML = GH_ROWS.map((h) => {
    const gain = h.current_value - h.invested_amount;
    return `<tr><td>${h.name}</td><td>${INV_TYPE[h.type] || h.type}</td>
      <td class="num">${fmt(h.invested_amount)}</td><td class="num">${fmt(h.current_value)}</td>
      <td class="num ${gain >= 0 ? "pos" : "neg"}">${signed(gain)}</td></tr>`;
  }).join("");
  $("#gh-preview-panel").style.display = "";
});
$("#gh-commit").addEventListener("click", async () => {
  if (!GH_ROWS.length) return;
  const res = await api("POST", "/api/import/groww/holdings", { rows: GH_ROWS, as_of_date: new Date().toISOString().slice(0, 10) });
  toast(`Imported ${res.imported} holdings`);
  $("#gh-map").style.display = "none"; $("#gh-preview-panel").style.display = "none"; $("#gh-file").value = "";
  loadInvestments(); refreshHeader();
});

// ---- tax -------------------------------------------------------------------
const TX_FIELDS = { d_80c:"#tx-80c", d_80d:"#tx-80d", hra_exempt:"#tx-hra",
  home_loan_interest:"#tx-hli", other_deductions:"#tx-other",
  annual_gross:"#tx-gross", tds_override:"#tx-tds" };
async function loadTax() {
  const inputs = await api("GET", "/api/settings?key=tax_inputs");
  Object.entries(TX_FIELDS).forEach(([k, sel]) => { if (inputs[k]) $(sel).value = inputs[k]; });
  await renderTax();
  await loadCapitalGains();
}
async function renderTax() {
  const fy = $("#tax-fy").value;
  const t = await api("GET", "/api/tax?fy=" + fy);
  const rec = t.recommended;
  $("#tax-cards").innerHTML = `
    <div class="card"><div class="label">Gross salary (${fy})</div><div class="value">${fmt(t.gross_salary)}</div></div>
    <div class="card"><div class="label">Recommended regime</div><div class="value ${rec==="new"?"pos":"amber"}">${rec.toUpperCase()}</div>
      <div class="sub">tax ${fmt(t[rec+"_regime"].total_tax)}</div></div>
    <div class="card"><div class="label">TDS already paid</div><div class="value">${fmt(t.tds_paid)}</div></div>
    <div class="card"><div class="label">${t.balance_payable>=0?"Still payable":"Refund due"}</div>
      <div class="value ${t.balance_payable>=0?"neg":"pos"}">${fmt(Math.abs(t.balance_payable))}</div></div>`;
  const row = (label, a, b, bold) => `<tr${bold?' style="font-weight:700"':''}><td>${label}</td><td class="num">${a}</td><td class="num">${b}</td></tr>`;
  const n = t.new_regime, o = t.old_regime;
  $("#tax-compare-body").innerHTML =
    row("Taxable salary", fmt(n.taxable_salary), fmt(o.taxable_salary)) +
    row("Tax on salary", fmt(n.normal_tax), fmt(o.normal_tax)) +
    row("STCG tax (20%)", fmt(n.stcg_tax), fmt(o.stcg_tax)) +
    row("LTCG tax (12.5%)", fmt(n.ltcg_tax), fmt(o.ltcg_tax)) +
    row("Surcharge", fmt(n.surcharge), fmt(o.surcharge)) +
    row("Cess (4%)", fmt(n.cess), fmt(o.cess)) +
    row("Total tax", fmt(n.total_tax), fmt(o.total_tax), true);
  $("#tax-note").textContent = `STCG ${fmt(t.stcg)} · LTCG ${fmt(t.ltcg)} (₹1.25L LTCG exempt). New regime: income up to ₹12L pays no salary tax after 87A rebate.`;
}
$("#tax-fy").addEventListener("change", () => { renderTax(); loadCapitalGains(); });
$("#tx-save").addEventListener("click", async () => {
  const value = {};
  Object.entries(TX_FIELDS).forEach(([k, sel]) => { if ($(sel).value) value[k] = parseFloat($(sel).value); });
  await api("POST", "/api/settings", { key: "tax_inputs", value });
  toast("Saved"); renderTax();
});

// ---- groww capital gains import --------------------------------------------
$("#cg-file").addEventListener("change", () =>
  loadCsvFile("#cg-file", ["#cg-symbol","#cg-buydate","#cg-selldate","#cg-buyval","#cg-sellval","#cg-gain"], "#cg-map", "#cg-info",
    [["#cg-symbol", /symbol|stock\s*name|scheme|scrip|^name$|isin/i],
     ["#cg-buydate", /buy.*date|purchase.*date|acquis/i],
     ["#cg-selldate", /sell.*date|sale.*date|redem/i],
     ["#cg-buyval", /buy.*(value|amount|cost)|purchase.*value|cost/i],
     ["#cg-sellval", /sell.*(value|amount)|sale.*value|realis/i],
     ["#cg-gain", /gain|profit|p&?l/i]],
    "#cg-raw", "#cg-headerrow"));
let CG_ROWS = [];
function daysBetween(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  return (isNaN(d1) || isNaN(d2)) ? null : Math.round((d2 - d1) / 86400000);
}
$("#cg-preview").addEventListener("click", () => {
  const { rows } = $("#cg-map")._csv;
  const dfmt = $("#cg-datefmt").value;
  CG_ROWS = [];
  for (const r of rows) {
    const bd = parseDate(col(rows, r, "#cg-buydate"), dfmt);
    const sd = parseDate(col(rows, r, "#cg-selldate"), dfmt);
    if (!sd) continue;
    const buy = parseNum(col(rows, r, "#cg-buyval")) || 0;
    const sell = parseNum(col(rows, r, "#cg-sellval")) || 0;
    const gainCol = $("#cg-gain").value >= 0 ? parseNum(col(rows, r, "#cg-gain")) : NaN;
    const gain = isNaN(gainCol) ? sell - buy : gainCol;
    const days = daysBetween(bd, sd);
    const term = (days != null && days > 365) ? "LTCG" : "STCG";
    CG_ROWS.push({ symbol: col(rows, r, "#cg-symbol"), buy_date: bd, sell_date: sd,
      buy_value: buy, sell_value: sell,
      gain: isNaN(gainCol) ? undefined : gainCol, _gain: gain, _term: term });
  }
  if (!CG_ROWS.length) return toast("No rows parsed — check sell-date mapping & header row");
  const st = CG_ROWS.filter((x) => x._term === "STCG").reduce((s, x) => s + x._gain, 0);
  const lt = CG_ROWS.filter((x) => x._term === "LTCG").reduce((s, x) => s + x._gain, 0);
  $("#cg-summary").textContent = `${CG_ROWS.length} rows · STCG ${fmt(st)} · LTCG ${fmt(lt)}`;
  $("#cg-preview-body").innerHTML = CG_ROWS.map((x) => `
    <tr><td>${x.symbol || ""}</td><td>${x.buy_date || "—"}</td><td>${x.sell_date}</td>
    <td><span class="tag">${x._term}</span></td>
    <td class="num ${x._gain >= 0 ? "pos" : "neg"}">${signed(x._gain)}</td></tr>`).join("");
  $("#cg-preview-panel").style.display = "";
});
$("#cg-commit").addEventListener("click", async () => {
  if (!CG_ROWS.length) return;
  const out = CG_ROWS.map(({ symbol, buy_date, sell_date, buy_value, sell_value, gain }) =>
    ({ symbol, buy_date, sell_date, buy_value, sell_value, gain }));
  const res = await api("POST", "/api/import/groww/gains", { rows: out });
  toast(`Imported ${res.inserted}, skipped ${res.skipped}`);
  $("#cg-map").style.display = "none"; $("#cg-preview-panel").style.display = "none"; $("#cg-file").value = "";
  loadCapitalGains(); renderTax();
});
async function loadCapitalGains() {
  const cg = await api("GET", "/api/capitalgains?fy=" + $("#tax-fy").value);
  $("#cg-body").innerHTML = cg.map((r) => `
    <tr data-id="${r.id}"><td>${r.symbol || ""}</td><td>${r.buy_date || "—"}</td>
    <td>${r.sell_date || "—"}</td><td><span class="tag">${r.term}</span></td>
    <td class="num ${r.gain>=0?"pos":"neg"}">${signed(r.gain)}</td>
    <td><button class="btn danger del-cg">Del</button></td></tr>`).join("")
    || `<tr><td colspan="6" class="muted">No capital gains for this FY.</td></tr>`;
}
document.addEventListener("click", async (e) => {
  if (e.target.matches(".del-cg")) {
    if (!confirm("Delete this capital-gains entry?")) return;
    await api("DELETE", "/api/capitalgains/" + e.target.closest("tr").dataset.id);
    loadCapitalGains(); renderTax(); toast("Deleted");
  }
});

// ---- boot ------------------------------------------------------------------
(async function init() {
  $("#t-date").value = new Date().toISOString().slice(0, 10);
  fillCatlist();
  applyEye();
  const settings = await api("GET", "/api/settings");
  $("#opt-respect-open").checked = settings.respect_opening_date !== false;  // default on
  await refreshHeader();
  await loadDashboard();
})();
