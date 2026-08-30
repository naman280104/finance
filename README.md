# My Finances

A private, local personal-finance tracker. Runs on your Mac with only Python's
standard library — no `pip install`, no cloud, no account. All data lives in one
file, `finance.db`, next to the app. Nothing ever leaves your machine.

## Run it

```bash
cd /Users/goynamak/Personal/finance
python3 app.py
```

**Optional dependency:** to open **password-protected Excel** statements, install
once: `pip install msoffcrypto-tool`. Everything else uses only Python's standard
library. Decryption runs locally on your machine — the file and password never
leave it. (Without it, unlock the file in Excel and re-save without a password.)

Then open **http://localhost:8000** in your browser. Stop with `Ctrl+C`.
Use a different port with `python3 app.py --port 9000`.

## First-time setup (do once)

1. **Accounts** tab → add your 2 banks, 2–3 credit cards, and cash.
   - Set each account's **opening balance** as of the date you'll start importing
     from (e.g. 1 Aug 2025). For a credit card, enter what you *owed* as a
     **negative** number (e.g. `-15000`).
2. **Rules** tab → add a few auto-categorization rules. Examples:
   - `SALARY` → Salary, type **income**
   - `SWIGGY` / `ZOMATO` → Food
   - `RENT` → Rent
   - `SIP` / `ZERODHA` / `GROWW` → Investment, type **transfer**
   - Credit-card bill payment description → Transfer (so it's not double-counted)

## Backfill Aug 2025 → now

For each bank/card, download a statement from net-banking as **CSV, XLS, or
XLSX** (most banks offer one of these even when the default is PDF). Excel files
are parsed locally by the bundled `xlsx.full.min.js` — still fully offline. Then:

1. **Import** tab → pick the account → choose the file.
2. Map the columns (Date, Description, and either a single Amount column or
   separate Debit/Credit columns). Pick the date format if auto-detect is wrong.
3. **Preview** → check categories and that duplicates are flagged → **Import**.

Re-importing the same statement is safe: duplicates are detected and skipped.
Add cash spends and anything without a statement via the **Transactions** tab.

After importing, go to **Rules → Apply to all existing** to categorize
everything you imported before you had the rules.

## Every month (~10 min)

1. Import the new month's statements (same as above).
2. Update **Investments** → current value of stocks/MF, and FD values.
3. Check the **Dashboard** for that month.

## Payslips (Payslips tab)

Add each month's salary components (basic, HRA, PF, professional tax, TDS). Paste
the payslip text and hit **Auto-fill** for a best-effort first pass — then verify
the numbers. Payslips feed your annual salary and TDS into the Tax estimator.

## Stocks from Groww (no login — via export)

Groww has no official API, so you export files from Groww and this reads them
locally:

- **Holdings** → Investments tab → *Import Groww holdings*. Export your holdings
  CSV from Groww, map the columns, import. This refreshes your stock/MF portfolio
  (your manually-added FDs are left alone).
- **Capital gains** → Tax tab → *Import Groww capital gains statement*. Feeds
  realized STCG/LTCG into the tax estimate. Term is auto-classified (equity held
  > 12 months = LTCG) when the file doesn't state it.

## Tax estimator (Tax tab)

Estimates FY 2025-26 tax under **both old and new regimes** and tells you which is
cheaper, using your payslip salary + realized capital gains. Enter deductions
(80C, 80D, HRA, home-loan interest) once — they're saved. Shows TDS paid vs tax
owed, so you see your likely **refund or balance payable**.

> ⚠️ **Estimate only**, based on Union Budget 2025 rules (new-regime slabs, 87A
> rebate up to ₹12L, STCG @20%, LTCG @12.5% over ₹1.25L). It ignores marginal
> relief, employer-NPS 80CCD(2), and the LTCG surcharge cap. Verify on the
> income-tax portal before filing — this is not tax advice.

## Concepts

- **Amount sign**: `+` money in, `−` money out. On import, Debit → out, Credit → in.
- **Type**: `income`, `expense`, or `transfer`. Transfers (moving money to an FD,
  paying a credit-card bill) are excluded from income/expense so your savings rate
  stays honest.
- **Net worth** = all account balances (credit-card debt counts as negative)
  \+ current value of all investments.
- **Job switch** needs nothing special — it's just salary income from a new source.

## Back up your data

Your entire financial history is the single file `finance.db`. Copy it somewhere
safe (or into a private, encrypted backup) periodically. To start over, delete it
and restart the app.

## Files

- `app.py` — backend server + SQLite (standard library only)
- `index.html`, `style.css`, `app.js` — the UI
- `finance.db` — your data (created on first run)
