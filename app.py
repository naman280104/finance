#!/usr/bin/env python3
"""
Personal finance tracker — local, private, single-file backend.

Runs on Python's standard library only (no pip install). Stores everything in
finance.db (SQLite) next to this file. Nothing leaves your machine.

    python3 app.py            # serves http://localhost:8000
    python3 app.py --port 9000

Money convention: amount is +ve for money IN, -ve for money OUT.
Credit-card accounts hold a negative balance when you owe money.
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "finance.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'bank',          -- bank | credit_card | cash
    opening_balance REAL NOT NULL DEFAULT 0,
    opening_date TEXT,
    identifier TEXT,                            -- unique text in this account's statements (acct-no digits / IFSC)
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    date TEXT NOT NULL,                          -- YYYY-MM-DD
    amount REAL NOT NULL,                        -- +in / -out
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'Uncategorized',
    type TEXT NOT NULL DEFAULT 'expense',        -- income | expense | transfer
    source TEXT NOT NULL DEFAULT 'manual',       -- manual | import
    hash TEXT,
    rule_id INTEGER,                             -- rule that set this category (NULL = manual/none)
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_txn_hash ON transactions(hash);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,                        -- case-insensitive substring
    category TEXT NOT NULL,
    txn_type TEXT,                                -- optional override
    priority INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'fd',              -- fd | stock | mf | other
    name TEXT NOT NULL,
    invested_amount REAL NOT NULL DEFAULT 0,
    current_value REAL NOT NULL DEFAULT 0,
    quantity REAL,
    rate REAL,                                    -- FD interest %
    start_date TEXT,
    maturity_date TEXT,
    notes TEXT,
    as_of_date TEXT,
    source TEXT NOT NULL DEFAULT 'manual',        -- manual | groww
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payslips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,                          -- YYYY-MM
    employer TEXT,
    gross REAL NOT NULL DEFAULT 0,
    basic REAL DEFAULT 0,
    hra REAL DEFAULT 0,
    allowances REAL DEFAULT 0,
    pf REAL DEFAULT 0,
    professional_tax REAL DEFAULT 0,
    tds REAL DEFAULT 0,                           -- income tax deducted at source
    other_deductions REAL DEFAULT 0,
    net_pay REAL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capital_gains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    buy_date TEXT,
    sell_date TEXT,
    quantity REAL,
    buy_value REAL DEFAULT 0,
    sell_value REAL DEFAULT 0,
    gain REAL DEFAULT 0,
    term TEXT,                                    -- STCG | LTCG
    source TEXT DEFAULT 'groww',
    hash TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cg_hash ON capital_gains(hash);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = db()
    conn.executescript(SCHEMA)
    # migrations for pre-existing databases
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(investments)")}
    if "source" not in cols:
        conn.execute("ALTER TABLE investments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    if "quantity" not in cols:
        conn.execute("ALTER TABLE investments ADD COLUMN quantity REAL")
    tcols = {r["name"] for r in conn.execute("PRAGMA table_info(transactions)")}
    if "rule_id" not in tcols:
        conn.execute("ALTER TABLE transactions ADD COLUMN rule_id INTEGER")
    acols = {r["name"] for r in conn.execute("PRAGMA table_info(accounts)")}
    if "identifier" not in acols:
        conn.execute("ALTER TABLE accounts ADD COLUMN identifier TEXT")
    conn.commit()

    # one-time: tidy whitespace in existing descriptions + recompute hashes.
    # v2 also switches to newline-direct-join and whitespace-independent hashes.
    done = conn.execute("SELECT 1 FROM settings WHERE key='desc_cleaned_v2'").fetchone()
    if not done:
        for t in conn.execute(
                "SELECT id, account_id, date, amount, description FROM transactions").fetchall():
            cleaned = clean_desc(t["description"])
            h = txn_hash(t["account_id"], t["date"], t["amount"], cleaned)
            conn.execute("UPDATE transactions SET description=?, hash=? WHERE id=?",
                         (cleaned, h, t["id"]))
        conn.execute("INSERT INTO settings(key,value) VALUES('desc_cleaned_v2','true') "
                     "ON CONFLICT(key) DO NOTHING")
        conn.commit()
    conn.close()


def now():
    return datetime.utcnow().isoformat()


def rows_to_list(rows):
    return [dict(r) for r in rows]


def txn_hash(account_id, date, amount, description):
    # whitespace-independent so re-imports dedupe regardless of spacing/wrapping
    norm = re.sub(r"\s+", "", (description or "")).lower()
    key = f"{account_id}|{date}|{round(float(amount), 2)}|{norm}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


def clean_desc(s):
    """Tidy bank narration wrapping: join lines split by a newline DIRECTLY
    (no space), then collapse remaining space/tab runs to a single space."""
    s = re.sub(r"\s*[\r\n]+\s*", "", s or "")   # newline (+ adjacent spaces) -> nothing
    return re.sub(r"[ \t]+", " ", s).strip()     # collapse remaining runs


def _norm(s):
    """Lowercase and remove ALL whitespace (spaces, tabs, newlines, non-breaking
    spaces) so rule matching is fully whitespace-insensitive — a pattern typed
    with spaces still matches descriptions where the bank wrapped/stripped them."""
    return re.sub(r"\s+", "", (s or "")).lower()


def apply_rules(conn, description):
    """First matching rule (by priority, then id) wins.
    Returns (category, txn_type, rule_id) or (None, None, None)."""
    desc = _norm(description)
    for r in conn.execute("SELECT * FROM rules ORDER BY priority ASC, id ASC"):
        if _norm(r["pattern"]) in desc:
            return r["category"], r["txn_type"], r["id"]
    return None, None, None


def default_type(amount):
    return "income" if float(amount) > 0 else "expense"


# ---------------------------------------------------------------- API handlers

def respect_opening(conn):
    """Whether analysis should ignore transactions dated before an account's
    opening date (avoids double-counting the opening balance). Default: on."""
    v = get_setting(conn, "respect_opening_date", True)
    return bool(v)


def _opening_clause(conn, alias_t="t", alias_a="a"):
    """SQL fragment to keep only on/after-opening-date txns, or '' when disabled."""
    if not respect_opening(conn):
        return ""
    return f" AND ({alias_a}.opening_date IS NULL OR {alias_t}.date >= {alias_a}.opening_date)"


def api_accounts_list(conn):
    cond = _opening_clause(conn)
    rows = conn.execute(f"""
        SELECT a.*,
               a.opening_balance + COALESCE(
                   (SELECT SUM(t.amount) FROM transactions t
                    WHERE t.account_id = a.id{cond}), 0
               ) AS balance
        FROM accounts a ORDER BY a.type, a.name
    """)
    return rows_to_list(rows)


def api_accounts_create(conn, body):
    c = conn.execute(
        "INSERT INTO accounts (name, type, opening_balance, opening_date, identifier, created_at) VALUES (?,?,?,?,?,?)",
        (body["name"], body.get("type", "bank"),
         float(body.get("opening_balance", 0) or 0),
         body.get("opening_date"), (body.get("identifier") or "").strip() or None, now()),
    )
    conn.commit()
    return {"id": c.lastrowid}


def api_accounts_delete(conn, aid):
    conn.execute("DELETE FROM transactions WHERE account_id=?", (aid,))
    conn.execute("DELETE FROM accounts WHERE id=?", (aid,))
    conn.commit()
    return {"ok": True}


def api_txn_list(conn, qs):
    where, params = [], []
    if qs.get("month"):
        where.append("t.date LIKE ?"); params.append(qs["month"] + "%")
    if qs.get("account"):
        where.append("t.account_id=?"); params.append(int(qs["account"]))
    if qs.get("category"):
        where.append("t.category=?"); params.append(qs["category"])
    if qs.get("type"):
        where.append("t.type=?"); params.append(qs["type"])
    if qs.get("q"):
        where.append("t.description LIKE ?"); params.append("%" + qs["q"] + "%")
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    oc = _opening_clause(conn)   # hide pre-opening txns when the setting is on
    if oc:
        clause = (clause + oc) if clause else ("WHERE 1=1" + oc)
    sql = f"""SELECT t.*, a.name AS account_name
              FROM transactions t
              JOIN accounts a ON a.id=t.account_id {clause}
              ORDER BY t.date DESC, t.id DESC LIMIT 2000"""
    return rows_to_list(conn.execute(sql, params))


def api_txn_create(conn, body):
    amount = float(body["amount"])
    ttype = body.get("type") or default_type(amount)
    date = body["date"]
    desc = clean_desc(body.get("description", ""))
    h = txn_hash(body["account_id"], date, amount, desc)
    c = conn.execute(
        """INSERT INTO transactions
           (account_id, date, amount, description, category, type, source, hash, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (int(body["account_id"]), date, amount, desc,
         body.get("category") or "Uncategorized", ttype, "manual", h, now()),
    )
    conn.commit()
    return {"id": c.lastrowid}


def api_txn_patch(conn, tid, body):
    fields, params = [], []
    for f in ("category", "type", "description"):
        if f in body:
            fields.append(f"{f}=?"); params.append(body[f])
    if "category" in body:
        fields.append("rule_id=NULL")   # manual edit detaches from any rule
    if fields:
        params.append(tid)
        conn.execute(f"UPDATE transactions SET {', '.join(fields)} WHERE id=?", params)
        conn.commit()
    return {"ok": True}


def api_txn_delete(conn, tid):
    conn.execute("DELETE FROM transactions WHERE id=?", (tid,))
    conn.commit()
    return {"ok": True}


def _categorize_rows(conn, rows):
    out = []
    for r in rows:
        amount = float(r["amount"])
        cat, ttype, rid = apply_rules(conn, r.get("description", ""))
        out.append({
            "account_id": int(r["account_id"]),
            "date": r["date"],
            "amount": amount,
            "description": clean_desc(r.get("description", "")),
            "category": cat or "Uncategorized",
            "type": ttype or default_type(amount),
            "rule_id": rid,
        })
    return out


def api_preview(conn, body):
    """Categorize rows and flag which already exist (dupes), without inserting."""
    rows = _categorize_rows(conn, body["rows"])
    for r in rows:
        h = txn_hash(r["account_id"], r["date"], r["amount"], r["description"])
        exists = conn.execute(
            "SELECT 1 FROM transactions WHERE hash=? LIMIT 1", (h,)).fetchone()
        r["duplicate"] = bool(exists)
    return {"rows": rows}


def api_txn_bulk(conn, body):
    rows = _categorize_rows(conn, body["rows"])
    inserted = skipped = 0
    for r in rows:
        h = txn_hash(r["account_id"], r["date"], r["amount"], r["description"])
        if conn.execute("SELECT 1 FROM transactions WHERE hash=? LIMIT 1", (h,)).fetchone():
            skipped += 1
            continue
        conn.execute(
            """INSERT INTO transactions
               (account_id, date, amount, description, category, type, source, hash, rule_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (r["account_id"], r["date"], r["amount"], r["description"],
             r["category"], r["type"], "import", h, r.get("rule_id"), now()),
        )
        inserted += 1
    conn.commit()
    return {"inserted": inserted, "skipped": skipped}


def api_txn_reset_categories(conn):
    """Reset every transaction to Uncategorized, with type back to the sign
    default (income if +, expense if -). Rules themselves are left intact."""
    cur = conn.execute(
        "UPDATE transactions SET category='Uncategorized', "
        "type=CASE WHEN amount>0 THEN 'income' ELSE 'expense' END")
    conn.commit()
    return {"reset": cur.rowcount}


def api_rules_list(conn):
    return rows_to_list(conn.execute(
        """SELECT r.*, (SELECT COUNT(*) FROM transactions t WHERE t.rule_id=r.id) AS usage_count
           FROM rules r ORDER BY r.priority ASC, r.id ASC"""))


def api_rules_create(conn, body):
    c = conn.execute(
        "INSERT INTO rules (pattern, category, txn_type, priority, created_at) VALUES (?,?,?,?,?)",
        (body["pattern"], body["category"], body.get("txn_type") or None,
         int(body.get("priority", 100)), now()),
    )
    conn.commit()
    return {"id": c.lastrowid}


def api_rules_delete(conn, rid):
    # transactions this rule categorized fall back to Uncategorized
    cur = conn.execute(
        "UPDATE transactions SET category='Uncategorized', rule_id=NULL, "
        "type=CASE WHEN amount>0 THEN 'income' ELSE 'expense' END WHERE rule_id=?", (rid,))
    n = cur.rowcount
    conn.execute("DELETE FROM rules WHERE id=?", (rid,))
    conn.commit()
    return {"ok": True, "uncategorized": n}


def api_rules_reorder(conn, body):
    """Set rule precedence from a list of ids (index 0 = highest precedence)."""
    for i, rid in enumerate(body["order"]):
        conn.execute("UPDATE rules SET priority=? WHERE id=?", (i, int(rid)))
    conn.commit()
    return {"ok": True}


def api_rules_apply(conn):
    """Re-run rules over ALL existing transactions (retro-categorize)."""
    updated = 0
    for t in conn.execute("SELECT id, description FROM transactions").fetchall():
        cat, ttype, rid = apply_rules(conn, t["description"])
        if cat:
            if ttype:
                conn.execute("UPDATE transactions SET category=?, type=?, rule_id=? WHERE id=?",
                             (cat, ttype, rid, t["id"]))
            else:
                conn.execute("UPDATE transactions SET category=?, rule_id=? WHERE id=?",
                             (cat, rid, t["id"]))
            updated += 1
    conn.commit()
    return {"updated": updated}


def api_investments_list(conn):
    return rows_to_list(conn.execute("SELECT * FROM investments ORDER BY type, name"))


def api_investments_create(conn, body):
    c = conn.execute(
        """INSERT INTO investments
           (type, name, invested_amount, current_value, rate, start_date, maturity_date, notes, as_of_date, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (body.get("type", "fd"), body["name"],
         float(body.get("invested_amount", 0) or 0),
         float(body.get("current_value", 0) or 0),
         body.get("rate"), body.get("start_date"), body.get("maturity_date"),
         body.get("notes"), body.get("as_of_date"), now()),
    )
    conn.commit()
    return {"id": c.lastrowid}


def api_investments_update(conn, iid, body):
    fields, params = [], []
    for f in ("type", "name", "invested_amount", "current_value", "rate",
              "start_date", "maturity_date", "notes", "as_of_date"):
        if f in body:
            fields.append(f"{f}=?"); params.append(body[f])
    if fields:
        params.append(iid)
        conn.execute(f"UPDATE investments SET {', '.join(fields)} WHERE id=?", params)
        conn.commit()
    return {"ok": True}


def api_investments_delete(conn, iid):
    conn.execute("DELETE FROM investments WHERE id=?", (iid,))
    conn.commit()
    return {"ok": True}


def api_months(conn):
    rows = conn.execute(
        "SELECT DISTINCT substr(date,1,7) AS m FROM transactions ORDER BY m DESC")
    return [r["m"] for r in rows]


def api_categories(conn):
    rows = conn.execute(
        "SELECT DISTINCT category FROM transactions "
        "WHERE category IS NOT NULL AND category<>'' ORDER BY category")
    return [r["category"] for r in rows]


def api_dashboard(conn, qs):
    month = qs.get("month")
    oc = _opening_clause(conn)
    base = "FROM transactions t JOIN accounts a ON a.id=t.account_id"
    monthc, mparams = "", []
    if month:
        monthc = " AND t.date LIKE ?"; mparams = [month + "%"]

    INVEST = "Investment"   # treated as invested, not spending

    def scalar(sql, params):
        return float(conn.execute(sql, params).fetchone()[0] or 0)

    income = scalar(f"SELECT SUM(t.amount) {base} WHERE t.type='income'{oc}{monthc}", mparams)
    salary = scalar(f"SELECT SUM(t.amount) {base} WHERE t.type='income' AND t.category='Salary'{oc}{monthc}", mparams)
    # expenses EXCLUDING the Investment category
    expense = -scalar(
        f"SELECT SUM(t.amount) {base} WHERE t.type='expense' AND t.category<>?{oc}{monthc}",
        [INVEST] + mparams)
    transfer = scalar(f"SELECT SUM(t.amount) {base} WHERE t.type='transfer'{oc}{monthc}", mparams)
    # money put into the Investment category (any outflow), shown separately
    invested = -scalar(
        f"SELECT SUM(t.amount) {base} WHERE t.category=? AND t.amount<0 AND t.type<>'transfer'{oc}{monthc}",
        [INVEST] + mparams)

    by_cat = conn.execute(
        f"""SELECT t.category AS category, -SUM(t.amount) AS total
            {base} WHERE t.type='expense' AND t.category<>?{oc}{monthc}
            GROUP BY t.category ORDER BY total DESC""", [INVEST] + mparams)
    categories = [{"category": r["category"], "total": float(r["total"] or 0)}
                  for r in by_cat]

    by_inc = conn.execute(
        f"""SELECT t.category AS category, SUM(t.amount) AS total
            {base} WHERE t.type='income'{oc}{monthc}
            GROUP BY t.category ORDER BY total DESC""", mparams)
    income_categories = [{"category": r["category"], "total": float(r["total"] or 0)}
                         for r in by_inc]

    savings = income - expense
    return {
        "month": month,
        "income": income,
        "salary": salary,
        "savings_rate_salary": (savings / salary) if salary else 0,
        "expense": expense,
        "transfer": transfer,
        "invested": invested,
        "invested_moved": invested + abs(transfer),
        "savings": savings,
        "savings_rate": (savings / income) if income else 0,
        "categories": categories,
        "income_categories": income_categories,
    }


def api_trend(conn, qs):
    n = int(qs.get("months", 12))
    oc = _opening_clause(conn)
    rows = conn.execute(f"""
        SELECT substr(t.date,1,7) AS m,
               SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END) AS income,
               SUM(CASE WHEN t.type='expense' THEN -t.amount ELSE 0 END) AS expense
        FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE 1=1{oc}
        GROUP BY m ORDER BY m DESC LIMIT ?
    """, (n,))
    out = [{"month": r["m"], "income": float(r["income"] or 0),
            "expense": float(r["expense"] or 0),
            "savings": float((r["income"] or 0) - (r["expense"] or 0))} for r in rows]
    out.reverse()
    return out


def api_networth(conn):
    accts = api_accounts_list(conn)
    inv = api_investments_list(conn)
    acct_total = sum(a["balance"] for a in accts)
    inv_current = sum(i["current_value"] for i in inv)
    inv_invested = sum(i["invested_amount"] for i in inv)
    return {
        "accounts": accts,
        "investments": inv,
        "accounts_total": acct_total,
        "investments_current": inv_current,
        "investments_invested": inv_invested,
        "investments_gain": inv_current - inv_invested,
        "net_worth": acct_total + inv_current,
    }


# -------------------------------------------------------------- FY / payslips

def fy_of(date_str):
    """'2025-08-31' -> '2025-26' (India financial year, Apr-Mar)."""
    if not date_str:
        return None
    y, m = int(date_str[:4]), int(date_str[5:7])
    start = y if m >= 4 else y - 1
    return f"{start}-{str(start + 1)[2:]}"


def fy_month_range(fy):
    """'2025-26' -> ('2025-04', '2026-03')."""
    start = int(fy.split("-")[0])
    return f"{start}-04", f"{start + 1}-03"


def api_payslips_list(conn, qs):
    rows = conn.execute("SELECT * FROM payslips ORDER BY month DESC")
    return rows_to_list(rows)


def api_payslips_create(conn, body):
    gross = float(body.get("gross") or 0)
    if not gross:
        gross = sum(float(body.get(k) or 0) for k in ("basic", "hra", "allowances"))
    deductions = sum(float(body.get(k) or 0) for k in ("pf", "professional_tax", "tds", "other_deductions"))
    net = float(body["net_pay"]) if body.get("net_pay") not in (None, "") else gross - deductions
    c = conn.execute(
        """INSERT INTO payslips (month, employer, gross, basic, hra, allowances,
            pf, professional_tax, tds, other_deductions, net_pay, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (body["month"], body.get("employer"), gross,
         float(body.get("basic") or 0), float(body.get("hra") or 0), float(body.get("allowances") or 0),
         float(body.get("pf") or 0), float(body.get("professional_tax") or 0),
         float(body.get("tds") or 0), float(body.get("other_deductions") or 0), net, now()))
    conn.commit()
    return {"id": c.lastrowid, "gross": gross, "net_pay": net}


def api_payslips_delete(conn, pid):
    conn.execute("DELETE FROM payslips WHERE id=?", (pid,))
    conn.commit()
    return {"ok": True}


# --------------------------------------------------------- Groww / cap gains

def api_groww_holdings(conn, body):
    """Replace Groww-sourced holdings of the SAME type(s) being imported, so
    stocks and mutual funds (separate imports) coexist instead of overwriting."""
    types = {r.get("type", "stock") for r in body["rows"]}
    if types:
        placeholders = ",".join("?" * len(types))
        conn.execute(f"DELETE FROM investments WHERE source='groww' AND type IN ({placeholders})",
                     tuple(types))
    n = 0
    for r in body["rows"]:
        invested = float(r.get("invested_amount") or 0)
        current = float(r.get("current_value") or 0)
        conn.execute(
            """INSERT INTO investments (type, name, invested_amount, current_value,
                quantity, source, as_of_date, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (r.get("type", "stock"), r["name"], invested, current,
             r.get("quantity"), "groww", body.get("as_of_date"), now()))
        n += 1
    conn.commit()
    return {"imported": n}


def cg_hash(r):
    key = f"{r.get('symbol','')}|{r.get('buy_date','')}|{r.get('sell_date','')}|{r.get('quantity','')}|{round(float(r.get('sell_value') or 0),2)}"
    return hashlib.sha1(key.encode()).hexdigest()


def _days_between(a, b):
    try:
        d1 = datetime.strptime(a, "%Y-%m-%d")
        d2 = datetime.strptime(b, "%Y-%m-%d")
        return (d2 - d1).days
    except Exception:
        return None


def api_groww_gains(conn, body):
    inserted = skipped = 0
    for r in body["rows"]:
        buy_v = float(r.get("buy_value") or 0)
        sell_v = float(r.get("sell_value") or 0)
        gain = float(r["gain"]) if r.get("gain") not in (None, "") else sell_v - buy_v
        term = r.get("term")
        if not term:
            days = _days_between(r.get("buy_date"), r.get("sell_date"))
            term = "LTCG" if (days is not None and days > 365) else "STCG"
        h = cg_hash(r)
        if conn.execute("SELECT 1 FROM capital_gains WHERE hash=? LIMIT 1", (h,)).fetchone():
            skipped += 1
            continue
        conn.execute(
            """INSERT INTO capital_gains (symbol, buy_date, sell_date, quantity,
                buy_value, sell_value, gain, term, source, hash, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (r.get("symbol"), r.get("buy_date"), r.get("sell_date"), r.get("quantity"),
             buy_v, sell_v, gain, term, "groww", h, now()))
        inserted += 1
    conn.commit()
    return {"inserted": inserted, "skipped": skipped}


def api_capitalgains_list(conn, qs):
    rows = conn.execute("SELECT * FROM capital_gains ORDER BY sell_date DESC")
    out = rows_to_list(rows)
    if qs.get("fy"):
        out = [r for r in out if fy_of(r["sell_date"]) == qs["fy"]]
    return out


def api_capitalgains_delete(conn, cid):
    conn.execute("DELETE FROM capital_gains WHERE id=?", (cid,))
    conn.commit()
    return {"ok": True}


# ------------------------------------------------------------------ settings

def get_setting(conn, key, default=None):
    r = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(r["value"]) if r else default


def api_settings_get(conn, qs):
    return get_setting(conn, "tax_inputs", {}) if qs.get("key") == "tax_inputs" else \
        {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT * FROM settings")}


def api_settings_set(conn, body):
    conn.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (body["key"], json.dumps(body["value"])))
    conn.commit()
    return {"ok": True}


# ----------------------------------------------------- decrypt Excel (local)

def api_decrypt(conn, body):
    """Decrypt a password-protected Office file locally (never leaves this
    machine). Returns the decrypted bytes as base64 for the browser to parse."""
    import base64
    import io
    try:
        import msoffcrypto
    except ImportError:
        raise Exception("msoffcrypto-tool is not installed. Run: pip install msoffcrypto-tool")
    b64 = "".join(body["data"].split())          # strip any whitespace/newlines
    b64 += "=" * (-len(b64) % 4)                   # tolerate missing padding
    raw = base64.b64decode(b64)
    office = msoffcrypto.OfficeFile(io.BytesIO(raw))
    try:
        office.load_key(password=body.get("password", ""))
        out = io.BytesIO()
        office.decrypt(out)
    except Exception:
        raise Exception("incorrect password")
    return {"data": base64.b64encode(out.getvalue()).decode("ascii")}


# --------------------------------------------------------------- TAX ENGINE
# India FY 2025-26 (AY 2026-27), per Union Budget 2025. Estimate only —
# verify against the IT department before filing. Ignores marginal relief,
# 80CCD(2) employer NPS, and the LTCG-specific 15% surcharge cap.

NEW_SLABS_25_26 = [(400000, 0.0), (800000, 0.05), (1200000, 0.10),
                   (1600000, 0.15), (2000000, 0.20), (2400000, 0.25),
                   (float("inf"), 0.30)]
OLD_SLABS = [(250000, 0.0), (500000, 0.05), (1000000, 0.20), (float("inf"), 0.30)]


def slab_tax(income, slabs):
    tax, prev = 0.0, 0.0
    for cap, rate in slabs:
        if income > prev:
            tax += (min(income, cap) - prev) * rate
            prev = cap
        else:
            break
    return tax


def surcharge_rate(total_income):
    if total_income > 20000000: return 0.25
    if total_income > 10000000: return 0.15
    if total_income > 5000000:  return 0.10
    return 0.0


def compute_regime(regime, gross_salary, deductions, stcg, ltcg):
    if regime == "new":
        std_ded = 75000
        taxable = max(0, gross_salary - std_ded)
        normal_tax = slab_tax(taxable, NEW_SLABS_25_26)
        if taxable <= 1200000:            # 87A rebate (new regime FY25-26)
            normal_tax = 0.0
    else:
        std_ded = 50000
        allowed = std_ded + sum(deductions.values())
        taxable = max(0, gross_salary - allowed)
        normal_tax = slab_tax(taxable, OLD_SLABS)
        if taxable <= 500000:             # 87A rebate (old regime)
            normal_tax = 0.0

    stcg_tax = max(0, stcg) * 0.20                       # 111A (post 23-Jul-2024)
    ltcg_tax = max(0, ltcg - 125000) * 0.125             # 112A, 1.25L exemption
    base_tax = normal_tax + stcg_tax + ltcg_tax
    total_income = taxable + max(0, stcg) + max(0, ltcg)
    surcharge = base_tax * surcharge_rate(total_income)
    cess = (base_tax + surcharge) * 0.04
    total = base_tax + surcharge + cess
    return {
        "regime": regime, "taxable_salary": taxable, "std_deduction": std_ded,
        "normal_tax": round(normal_tax), "stcg_tax": round(stcg_tax),
        "ltcg_tax": round(ltcg_tax), "surcharge": round(surcharge),
        "cess": round(cess), "total_tax": round(total),
    }


def api_tax(conn, qs):
    fy = qs.get("fy") or fy_of(datetime.utcnow().strftime("%Y-%m-%d"))
    m_start, m_end = fy_month_range(fy)
    inputs = get_setting(conn, "tax_inputs", {}) or {}

    # salary: manual annual override, else sum of payslip gross for the FY
    ps = conn.execute(
        "SELECT COALESCE(SUM(gross),0) g, COALESCE(SUM(tds),0) t, COALESCE(SUM(professional_tax),0) pt "
        "FROM payslips WHERE month BETWEEN ? AND ?", (m_start, m_end)).fetchone()
    gross = float(inputs.get("annual_gross") or ps["g"] or 0)
    tds_paid = float(inputs.get("tds_override") or ps["t"] or 0)

    # deductions for OLD regime
    deductions = {
        "80C": min(float(inputs.get("d_80c") or 0), 150000),
        "80D": float(inputs.get("d_80d") or 0),
        "HRA_exempt": float(inputs.get("hra_exempt") or 0),
        "home_loan_interest": min(float(inputs.get("home_loan_interest") or 0), 200000),
        "professional_tax": float(ps["pt"] or 0),
        "other": float(inputs.get("other_deductions") or 0),
    }

    # capital gains for the FY
    stcg = ltcg = 0.0
    for r in conn.execute("SELECT sell_date, gain, term FROM capital_gains"):
        if fy_of(r["sell_date"]) != fy:
            continue
        if (r["term"] or "").upper() == "LTCG":
            ltcg += float(r["gain"] or 0)
        else:
            stcg += float(r["gain"] or 0)

    new = compute_regime("new", gross, deductions, stcg, ltcg)
    old = compute_regime("old", gross, deductions, stcg, ltcg)
    cheaper = "new" if new["total_tax"] <= old["total_tax"] else "old"
    chosen = new if cheaper == "new" else old
    return {
        "fy": fy, "gross_salary": gross, "tds_paid": round(tds_paid),
        "stcg": round(stcg), "ltcg": round(ltcg),
        "deductions": deductions,
        "new_regime": new, "old_regime": old,
        "recommended": cheaper,
        "balance_payable": round(chosen["total_tax"] - tds_paid),  # +owe / -refund
    }


# ------------------------------------------------------------------- HTTP glue

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/xlsx.full.min.js": ("xlsx.full.min.js", "application/javascript; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # quiet

    def _send(self, code, payload, ctype="application/json"):
        if ctype.startswith("application/json"):
            body = json.dumps(payload).encode("utf-8")
        else:
            body = payload if isinstance(payload, bytes) else payload.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _qs(self):
        if "?" not in self.path:
            return {}
        from urllib.parse import parse_qs
        raw = parse_qs(self.path.split("?", 1)[1])
        return {k: v[0] for k, v in raw.items()}

    def _path(self):
        return self.path.split("?", 1)[0]

    def _static(self, path):
        fname, ctype = STATIC[path]
        with open(os.path.join(HERE, fname), "rb") as f:
            self._send(200, f.read(), ctype)

    def route(self, method):
        path = self._path()
        if method == "GET" and path in STATIC:
            return self._static(path)

        conn = db()
        try:
            m = re.match
            qs = self._qs()

            if method == "GET":
                if path == "/api/accounts": return self._send(200, api_accounts_list(conn))
                if path == "/api/transactions": return self._send(200, api_txn_list(conn, qs))
                if path == "/api/rules": return self._send(200, api_rules_list(conn))
                if path == "/api/investments": return self._send(200, api_investments_list(conn))
                if path == "/api/months": return self._send(200, api_months(conn))
                if path == "/api/categories": return self._send(200, api_categories(conn))
                if path == "/api/dashboard": return self._send(200, api_dashboard(conn, qs))
                if path == "/api/trend": return self._send(200, api_trend(conn, qs))
                if path == "/api/networth": return self._send(200, api_networth(conn))
                if path == "/api/payslips": return self._send(200, api_payslips_list(conn, qs))
                if path == "/api/capitalgains": return self._send(200, api_capitalgains_list(conn, qs))
                if path == "/api/settings": return self._send(200, api_settings_get(conn, qs))
                if path == "/api/tax": return self._send(200, api_tax(conn, qs))

            if method == "POST":
                body = self._body()
                if path == "/api/accounts": return self._send(200, api_accounts_create(conn, body))
                if path == "/api/transactions": return self._send(200, api_txn_create(conn, body))
                if path == "/api/transactions/bulk": return self._send(200, api_txn_bulk(conn, body))
                if path == "/api/preview": return self._send(200, api_preview(conn, body))
                if path == "/api/rules": return self._send(200, api_rules_create(conn, body))
                if path == "/api/rules/apply": return self._send(200, api_rules_apply(conn))
                if path == "/api/rules/reorder": return self._send(200, api_rules_reorder(conn, body))
                if path == "/api/transactions/reset-categories": return self._send(200, api_txn_reset_categories(conn))
                if path == "/api/investments": return self._send(200, api_investments_create(conn, body))
                if path == "/api/payslips": return self._send(200, api_payslips_create(conn, body))
                if path == "/api/settings": return self._send(200, api_settings_set(conn, body))
                if path == "/api/import/groww/holdings": return self._send(200, api_groww_holdings(conn, body))
                if path == "/api/import/groww/gains": return self._send(200, api_groww_gains(conn, body))
                if path == "/api/decrypt": return self._send(200, api_decrypt(conn, body))

            if method == "PATCH":
                body = self._body()
                if (g := m(r"^/api/transactions/(\d+)$", path)):
                    return self._send(200, api_txn_patch(conn, int(g.group(1)), body))
                if (g := m(r"^/api/investments/(\d+)$", path)):
                    return self._send(200, api_investments_update(conn, int(g.group(1)), body))

            if method == "DELETE":
                if (g := m(r"^/api/accounts/(\d+)$", path)):
                    return self._send(200, api_accounts_delete(conn, int(g.group(1))))
                if (g := m(r"^/api/transactions/(\d+)$", path)):
                    return self._send(200, api_txn_delete(conn, int(g.group(1))))
                if (g := m(r"^/api/rules/(\d+)$", path)):
                    return self._send(200, api_rules_delete(conn, int(g.group(1))))
                if (g := m(r"^/api/investments/(\d+)$", path)):
                    return self._send(200, api_investments_delete(conn, int(g.group(1))))
                if (g := m(r"^/api/payslips/(\d+)$", path)):
                    return self._send(200, api_payslips_delete(conn, int(g.group(1))))
                if (g := m(r"^/api/capitalgains/(\d+)$", path)):
                    return self._send(200, api_capitalgains_delete(conn, int(g.group(1))))

            self._send(404, {"error": "not found", "path": path})
        except Exception as e:  # noqa
            self._send(400, {"error": str(e)})
        finally:
            conn.close()

    def do_GET(self):    self.route("GET")
    def do_POST(self):   self.route("POST")
    def do_PATCH(self):  self.route("PATCH")
    def do_DELETE(self): self.route("DELETE")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    init_db()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Personal finance running at  http://localhost:{args.port}")
    print(f"Data file: {DB_PATH}")
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
