# Root Cause Analysis & Fix Plan: Finny Finance UI, Flow & Verification

**Incident Thread:** [p1794457976303229](https://11mirror.slack.com/archives/D0CFQ3FP3NJ/p1794457976303229)  
**Job ID:** `275691d3-7807-47c1-930e-ecabee4aa2bf`  
**Date:** 2026-11-12

---

## 1. Executive Summary & Root Causes

### A. Why did it ask for LibreOffice Approval (`rm -rf recalc && soffice ...`)?

- **Root Cause:** In subagent `Finny Auditor` (`03a5bc70-78f6-4f89-8608-a106947b68a2`), the auditor failed `summary.crossfoot` with floating-point residue ($3.7 \times 10^{-9}$ to $3.0 \times 10^{-8}$). To diagnose the crossfoot discrepancy, the auditor attempted to run headless LibreOffice Calc CLI:
  ```bash
  cd /tmp && rm -rf recalc && mkdir recalc && cp ~/workspace/ar/ar_weekly.xlsx recalc/ && cd recalc && soffice --headless ...
  ```
- **The Approval Gate:** QM's organizational command policy (`src/policy/command-policy.ts`) enforces human approval for any recursive deletion (`\brm\b[^\n]*(?:-[a-zA-Z]*r|--recursive)`).
- **The Flow Failure:** This approval request was surfaced directly to the user in Slack (_"Allowed once by @Kalishukla"_), leaking an internal subagent debugging command into the user's thread, stalling the run, and confusing the user.

### B. Why is the output unstructured, verbose prose with no `json-render` / Generative UI?

- **Root Cause 1 (Prompt Leakage on Intermediate Turns):** The parent session acts as a coordinator between Producer and Auditor subagents. When an audit block occurred, the parent agent sent multiple long-winded conversational status updates into the Slack thread detailing internal bookkeeping (e.g. _"Audit came back... The formal block is cosmetic... The real issue is a population disagreement... So receipts and the SAP population are solid, but 17 invoices and ₹63.5 lakh of native open AR are in dispute"_).
- **Root Cause 2 (`parseGenerativeUISpec` Stripping/Extraction):** In `src/slack/turn-handler.ts:633` and `src/slack/generative-ui.ts:221`, `parseGenerativeUISpec` requires the entire turn output to begin with `{` and end with `}`:
  ```typescript
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  ```
  If the model outputs even a single sentence of conversational commentary (e.g., _"Here is the weekly AR report:"_) followed by or preceding the JSON payload, or encloses the JSON inside markdown code blocks (` ```json ... ``` `), `parseGenerativeUISpec` fails completely and defaults to raw mrkdwn text.
- **Root Cause 3 (Missing Authoritative Final Delivery Block):** Currently, workbook completion relies on the LLM in the parent turn voluntarily outputting a raw JSON string instead of an authoritative delivery mechanism where `finny_finalize` directly renders the verified card.

---

## 2. Architecture & Design Fixes

### Fix 1: Silent Autonomous Sandbox Recalculation (Eliminate Approval Gate)

1. **Remove `rm -rf` from Worker Pipelines:** Replace shell pipeline temporary directory wipes with isolated Python `tempfile.TemporaryDirectory()`.
2. **Pure-Python Evaluator Parity:** Audit scripts must use Python `openpyxl` with IEEE 754 float rounding to 2 decimal places (`round(val, 2)` or `Decimal`) matching NetSuite's paisa currency precision, eliminating the need to invoke headless LibreOffice CLI.
3. **Subagent Approval Suppression:** Subagents must never escalate command approval gates to the user's Slack thread. If a subagent attempts a blocked command, it must fail closed inside the subagent and fall back to authorized Python tools.

### Fix 2: Generative UI Robust Parsing & Fenced Block Extraction

1. **Fenced JSON & Embedded Extraction:** Update `parseGenerativeUISpec` in `src/slack/generative-ui.ts` to:
   - Strip markdown code fences (` ```json ... ``` ` or ` ``` ... ``` `).
   - If leading or trailing prose exists, extract the outermost JSON object matching `"root"` / `"schema": "generative-ui.v1"`.
2. **Strict In-Thread Silence During Rework:**
   - Add system prompt instructions for Finny coordinator turns: when jobs are in `reworking` or `auditing` status, do not broadcast intermediate debugging debates into Slack. Post a single compact 1-line progress indicator (`:hourglass_flowing_sand: Auditing workbook...`) rather than paragraphs of accounting stream-of-consciousness.

### Fix 3: Authoritative Final Delivery Card from Core

1. **Direct Card Delivery on `finny_finalize`:**
   - In `src/finny/integration.ts`, when `finny_finalize` succeeds, Core must assemble the Generative UI Block Kit card directly from the certified job summary and post it alongside the `.xlsx` file artifact.
   - The card must feature:
     - Header & Key Metric Fields (Total Open, Total Overdue, Top 10 Overdue, Unreconciled Variance).
     - Inline Structured Table (`json-render` `table` element with columns: `Invoice #`, `Customer`, `Due Date`, `DPD Bucket`, `Amount (INR)`).
     - Action buttons: Download `.xlsx` workbook.

---

## 3. Implementation Plan & Work Units

### Unit 1: Robust JSON / Generative UI Parser (`src/slack/generative-ui.ts`)

- Support markdown fenced code blocks (` ```json ... ``` `).
- Support mixed content where conversational commentary wraps the JSON card.
- Add unit tests in `test/slack-generative-ui.test.ts` verifying extraction of fenced and surrounded JSON cards.

### Unit 2: Worker Recalculation & Command Safety (`src/wiring.ts`, `skills-seed/finnyloop/SKILL.md`)

- Update Finny worker task instructions:
  - Strictly prohibit `rm -rf` and headless LibreOffice invocation.
  - Require Python `tempfile` and `openpyxl` with 2-decimal rounded precision for currency comparisons.
- Ensure subagent commands requiring human approval fail immediately with an internal error rather than surfacing ephemeral approval cards to the user.

### Unit 3: Coordinator Turn Discipline & Progress Card (`src/core/orchestrator.ts`)

- Update `isFinanceTurn` system prompt in `orchestrator.ts`:
  - Enforce that final responses MUST emit the `json-render` schema.
  - Suppress verbose accounting stream-of-consciousness on intermediate rework turns; keep updates to concise, structured progress cards.

---

## 4. Verification & Testing

1. **Unit Tests:**
   - Run `bun test test/slack-finny-cards.test.ts`
   - Run `bun test test/finny-agent-tool.test.ts`
   - Test markdown-fenced `json-render` extraction in `generative-ui.ts`.
2. **Typecheck & Lint:**
   - `bun run typecheck`
3. **End-to-End Slack Smoke Test:**
   - Verify that financial queries on `@finnystaging2` render an inline Block Kit card with a data table and zero command-approval prompts.
