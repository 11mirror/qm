---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
title: Finny Harness User Experience, Float Resilience, and Delivery Streamlining
created_at: 2026-11-12
---

## Goal Capsule

- **Objective:** Operators receive clean, structured Block Kit Generative UI cards with inline tables and zero subagent command-approval interruptions during financial report generation, eliminating conversational chatter and floating-point crossfoot deadlocks.
- **Means:** Enforce financial 2-decimal rounding tolerance in crossfoot validation, suppress coordinator in-flight text updates during rework turns, and deliver authoritative Generative UI cards directly on job finalization.
- **Product Authority:** Finance operators in Slack origin threads; QM authoritative Finny store and coordinator.
- **Stop Conditions:** All 3 units verified via tests, eval suite passing, and clean typecheck.

---

## Product Contract

### Summary

Overhaul the Finny finance harness to deliver a clean, structured user experience in Slack. Suppress verbose intermediate subagent chatter, eliminate floating-point crossfoot block loops by introducing a financial tolerance in `summary.crossfoot`, and ensure final deliverables render as rich Generative UI cards with inline data tables and `.xlsx` download links.

### Problem Frame

During financial runs (e.g. AR aging reports and Investor EBITDA bridges), users experience three major friction points:

1. **Chatter & Verbosity:** Intermediate subagent wake turns cause the parent coordinator to broadcast paragraphs of uncertified internal accounting debugging, confusing users before audit completes.
2. **False Float Crossfoot Blocks:** Binary floating-point arithmetic residue ($10^{-10}$) triggers `summary.crossfoot` mismatches in the deterministic spreadsheet engine, trapping jobs in repeated rework cycles until escalation.
3. **Missing Generative UI on Delivery:** The system prompt previously relied on conversational turn completion to emit raw JSON; if the model writes commentary, cards fail to render or get lost.

### Requirements

**Coordinator Streamlining & Silence**

- R1. QM MUST suppress conversational prose on intermediate subagent wake turns while a Finny job is in `producing`, `auditing`, or `reworking` status.
- R2. The parent coordinator MUST invoke `finish_silently` on intermediate turns unless human approval or plan amendment is explicitly required.
- R3. QM MUST strictly forbid disclosing uncertified provisional figures or raw ASCII tables in chat prior to job finalization.

**Spreadsheet Engine & Worker Resilience**

- R4. The deterministic spreadsheet worker MUST permit a financial rounding tolerance ($\le 0.005$) on `summary.crossfoot` comparisons to prevent IEEE 754 floating-point residue from blocking valid workbooks.
- R5. Worker instructions MUST mandate pure-Python openpyxl with 2-decimal rounded precision and forbid invoking external CLI tools (`soffice`) or destructive commands (`rm -rf`).

**Structured Delivery & Block/Escalation Cards**

- R6. Upon successful `finny_finalize`, Core MUST authoritatively enqueue a Generative UI Block Kit card with summary KPIs, inline debtor/vendor data tables, and `.xlsx` download links.
- R7. When a job escalates or blocks, QM MUST present a compact Block Kit card displaying the failed invariant and action buttons (`Amend Plan` / `Retry`) instead of conversational text.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Financial Tolerance in Crossfoot Validation:** Update `validatePassConsistency` in `src/finny/deterministic-spreadsheet-worker.ts` so `summary.crossfoot` evaluates `Math.abs(item.difference) <= 0.005` or `item.actual === item.expected` rather than requiring strict binary float identity. Governs R4.
- KTD2. **Authoritative Final Delivery Pipeline:** Wire `finnyFinalDelivery` directly into `completeAuditPassed` / `finalize` execution in `src/wiring.ts` and `src/finny/integration.ts`, ensuring the structured card and workbook are posted together atomically. Governs R6.
- KTD3. **Coordinator Wake Suppression:** Enforce `finish_silently` guardrails in `src/core/orchestrator.ts` whenever the turn is a subagent wake without terminal failure. Governs R1, R2, R3.

---

## Implementation Units

### U1. Crossfoot Float Resilience in Spreadsheet Worker

- **Goal:** Prevent false `CROSSFOOT_MISMATCH` blocks caused by floating-point residue in financial spreadsheet checks.
- **Files:**
  - `src/finny/deterministic-spreadsheet-worker.ts`
  - `test/finny-deterministic-worker.test.ts`
- **Approach:**
  - In `validatePassConsistency`, update the crossfoot check:
    ```typescript
    if (evidence.kind === "cross-foot") {
      if (
        evidence.comparisons.length === 0 ||
        evidence.comparisons.some((item) => Math.abs(item.difference) > 0.005 && item.actual !== item.expected)
      ) {
        throw new Error("Spreadsheet PASS evidence is inconsistent");
      }
    }
    ```
- **Test Scenarios:**
  - A comparison with difference `0.00000000003` passes consistency check.
  - A comparison with difference `1.50` fails consistency check.
- **Verification:** `bun test test/finny-deterministic-worker.test.ts`

### U2. Coordinator Turn Silence & Anti-Chatter Rules

- **Goal:** Stop the parent agent from posting uncertified provisional numbers and debugging paragraphs to Slack during rework.
- **Files:**
  - `src/core/orchestrator.ts`
  - `test/finny-harness-quality-eval.test.ts`
- **Approach:**
  - Enhance financial turn system prompt in `orchestrator.ts`:
    - When turn text matches `<wake reason="subagent" ...>`, instruct the model to call `finish_silently` if no final deliverable is ready.
    - Explicitly forbid broadcasting provisional figures or markdown tables into chat.
- **Test Scenarios:**
  - Subagent wake turns evaluate with anti-chatter rules injected.
  - Uncertified text is suppressed until final receipt is minted.
- **Verification:** `node --test test/finny-harness-quality-eval.test.ts`

### U3. Atomic Final Delivery & Escalation Cards

- **Goal:** Ensure every finalized job delivers a rich Generative UI card and escalated jobs render a clean structured card.
- **Files:**
  - `src/finny/integration.ts`
  - `src/slack/finny-cards.ts`
  - `test/slack-finny-cards.test.ts`
- **Approach:**
  - Enhance `finnyFinalDelivery` to include structured summary table and download actions.
  - Provide helper for structured escalation cards if max reworks limit is reached.
- **Test Scenarios:**
  - `finnyFinalDelivery` produces valid Block Kit elements with tables and download actions.
  - Escalation outcomes render cleanly as Block Kit cards.
- **Verification:** `node --test test/slack-finny-cards.test.ts`

---

## Verification Contract

- **Test Commands:**
  - `bun test test/finny-deterministic-worker.test.ts`
  - `node --test test/finny-harness-quality-eval.test.ts`
  - `node --test test/slack-finny-cards.test.ts`
  - `bun run typecheck`
- **Quality Gates:** Zero typecheck errors, all regression eval edges passing, zero command-approval blocks on sandbox workers.

---

## Definition of Done

- All 3 implementation units completed and committed.
- Floating-point crossfoot tolerance of 0.005 implemented and covered by unit tests.
- Intermediate chatter rules enforced and evaluated.
- Typecheck passes with 0 diagnostics.
