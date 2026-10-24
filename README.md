# Freshroots Demand Planner

Built from the Case 01 components map: Cron → Data from SAP → Data cleaning and structuring → Forecast logic rules (rubric) → Gemini forecasting → Neon → Dashboard (Raghav's review, Approve / Reject) → Status → PO in Zoho, with a kill switch.

## How a run works

1. **Cron** (`vercel.json`): Monday and Thursday 01:30 UTC = 7:00am IST. "Run now" on the Review page does the same.
2. **Data from SAP**: the CSV exports loaded on the Data page (same columns as the sample files in `data/`). Open POs come from a Zoho CSV export.
3. **Data cleaning and structuring** (`src/lib/rules.ts`, plain code): 4- and 12-week averages (missing weeks left out, never counted as zero), festival uplift from the calendar, weeks of cover including open POs, and the rule result as a check.
4. **Gemini** (`src/lib/gemini.ts`): decides flag, high demand, and action for every SKU from Raghav's rubric, with a one-line reason. The quantity comes from the action (standard or 1.5×), never from Gemini.
5. If Gemini's decision differs from the rule result, or the case is a close call, the line is marked as an exception for Raghav.
6. **Neon** saves every run and every decision.
7. **Review** page: Raghav approves, changes the quantity, or rejects with a reason. Routine lines can be bulk-approved; exceptions and fresh SKUs can't.
8. **Status** page: every SKU's state, reject rate, sales-week-to-PO days, stockout reports, recent runs.
9. **PO in Zoho** (`src/lib/zoho.ts`, `src/lib/procure.ts`): the moment Raghav approves a line with a quantity, the app raises a purchase order in Zoho Inventory (`POST /purchaseorders`) to the vendor mapped to the SKU's distributor, for the Zoho item with that SKU, at Zoho's purchase rate. The Zoho PO number is saved on the line. Each line is claimed before the call, so a double click can't raise two POs. If Zoho fails, the line shows the error and a Retry button; procurement can also record a PO they raised by hand. POs are created as drafts unless `ZOHO_PO_STATUS=issued`. No PO is raised while the kill switch is on. POs the app raises count as stock on order in later runs until the next Zoho open-PO export is uploaded.
10. **Kill switch**: trips when more than 30% of at least 10 decisions in 28 days are rejected, or a fresh SKU marked OK is reported out of stock. Runs stay paused until someone resumes with a note.

## Closed loop and safeguards

See [docs/ENGINEERING-PLAN.md](docs/ENGINEERING-PLAN.md) for the full plan. In short:

- **Data gate** (`dataGate` in `src/lib/rules.ts`): stale stock (>10 days), stale sales (>21 days) or >20% SKUs without stock block the run. A single SKU without stock goes to Raghav undecided; Gemini is never asked to guess.
- **One run at a time** (unique index on running runs), **same-data skip** for cron, **Gemini timeout + retries**, **strict output validation**, and a full **trace** per run (model, prompt version, rules version, input hash, tokens, duration).
- **Outcome scoring** (`src/lib/learning.ts`): when a newer sales week and stock snapshot arrive, every decided line gets a verdict (right call, missed stockout, short after order, false alarm, missed overstock, ordered when not needed), the demand error, and who was right when Raghav overrode.
- **Lessons and calibration**: repeated overrides and misses become lessons; consistent bias becomes a rule-change proposal with evidence. Raghav accepts or dismisses each on the **Learning** page. Accepted lessons go into Gemini's context; accepted rule changes create a new rules version.
- **Eval**: `npm run eval` checks Gemini against golden cases from the case data (live API). **CI** (typecheck, tests, build on every push) is ready in `docs/ci-workflow.yml`: to switch it on, create `.github/workflows/ci.yml` on GitHub's website (Add file → Create new file) and paste it in. Pushing workflow files needs a GitHub login with the `workflow` permission.

## Setup

```bash
npm install
# fill in .env.local: DATABASE_URL, GEMINI_API_KEY, GEMINI_MODEL
npm run seed      # loads data/*.csv into Neon and writes the default rubric
npm run dev       # http://localhost:3000, then press Run now
npm test          # rules + decision-merge tests on the sample data
```

## Connect Zoho Inventory

1. Zoho API Console (api-console.zoho.in for India) > **Self Client** > copy the client id and secret into `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET`.
2. Self Client > **Generate Code** with scopes
   `ZohoInventory.purchaseorders.CREATE,ZohoInventory.purchaseorders.UPDATE,ZohoInventory.items.READ,ZohoInventory.contacts.READ`.
3. Within the code's validity window: `npm run zoho:token -- <code>` and paste the printed `ZOHO_REFRESH_TOKEN`.
4. Set `ZOHO_ORGANIZATION_ID` (Zoho Inventory > Manage Organizations). `ZOHO_ACCOUNTS_URL` / `ZOHO_API_BASE` default to India's data centre.
5. Restart the app, open the **Zoho** page: match SKUs to items, choose a vendor for each distributor.

## Deploy (Vercel)

Push to GitHub, import into Vercel, add `DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `CRON_SECRET`, `SITE_PASSWORD` and the `ZOHO_*` values as environment variables, deploy.
