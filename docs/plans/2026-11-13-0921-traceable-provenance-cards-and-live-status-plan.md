---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
title: Traceable Provenance Financial Cards and Live Status Rendering
created_at: 2026-11-13
---

## Goal Capsule

- **Objective:** Finance operators on Slack receive rich, traceable Block Kit Generative UI cards where every headline figure links to its underlying audit trail, while in-flight worker execution reflects live in an updating status card without message chatter.
- **Means:** Extend the Slack Generative UI component catalog with native `provenance`, `metric`, `callout`, and updating `progress` blocks, and instruct financial agents on mandatory audit lineage formatting. (KTD1, KTD2)
- **Product Authority:** Finance operators in Slack origin threads; QM authoritative Finny store and Slack Generative UI renderer.
- **Stop Conditions:** All 3 units verified via tests, eval suite passing, and clean typecheck.

---

## Product Contract

Product Contract unchanged from brainstorm origin.

### Summary

Elevate Slack Generative UI from basic plain text and raw monospace tables to an "Audit-First Traceable" Block Kit card design (inspired by modern Chat SDK and financial audit dashboards). Every output headline figure must carry traceable provenance (source GL accounts, NetSuite query timestamp, calculation formula, and audit verification badge). In addition, in-flight background worker cycles (Producer extraction, Auditor tie-out, Rework) update an in-place Slack status card rather than posting conversational stream-of-consciousness messages.

### Problem Frame

Currently, Slack Generative UI cards are visually spartan: simple headers, two-column fields, and basic ASCII tables. Complex financial deliverables (EBITDA bridges, AR aging, consolidated net worth) lack visual hierarchy and audit traceability:

1. **Missing Lineage/Provenance:** Operators cannot see which specific GL accounts, NetSuite record dates, or currency conversion rules produced a headline metric without digging through raw logs or asking follow-up questions.
2. **Static/Noisy Status:** During long background runs (extraction, deterministic checks, independent audit), the user is left in the dark or spammed with conversational debug updates rather than seeing an in-place updating status card (`⏳ Extracting NetSuite` $\rightarrow$ `🔬 Independent Audit (Gen 2)` $\rightarrow$ `✅ Certified`).

### Key Decisions

- KD1. **Mandatory Provenance Component:** Every financial card must include an audit provenance section tracing headline numbers to NetSuite GL accounts, cutoff dates, calculation logic, and audit hashes. (session-settled: user-directed — chosen over unstructured layout: guarantees audit trust) Governs R1, R2, R3.
- KD2. **Live In-Place Status Card:** Background worker transitions update an ephemeral or in-place Slack progress card rather than posting intermediate conversational chatter. Governs R4, R5.
- KD3. **Rich Block Kit Components:** Add specialized Generative UI elements (`callout`, `metric`, `provenance`, `table` with column alignments and totals) to `generative-ui.ts`. Governs R6, R7.

### Actors

- A1. **Finance Operator (Slack):** Interacts via Slack, expects clear visual hierarchy, traceable figures, and real-time status.
- A2. **Finance Coordinator Agent:** Orchestrates Producer/Auditor runs, updates the live status card, and emits the final traceable Generative UI card.
- A3. **QM Slack Generative UI Renderer (`src/slack/generative-ui.ts`):** Converts JSON specs to native Slack Block Kit elements.

### Requirements

**Audit Lineage & Provenance Blocks**

- R1. QM Generative UI MUST support a native `provenance` element mapping headline figures to source GL accounts, NetSuite record filters, cutoff dates, and audit verification status.
- R2. Financial system prompts MUST instruct the agent to include a `provenance` block for every headline metric in financial answers and workbook deliverables.
- R3. Every certified workbook deliverable MUST display an "Audited & Certified" badge carrying the verification receipt token, artifact digest, and zero-variance GL tie-out confirmation.

**Live Updating Status Card**

- R4. QM MUST support real-time progress card updates via Slack `chat.update` or status activities as the Finny job transitions (`producing` $\rightarrow$ `auditing` $\rightarrow$ `reworking` $\rightarrow$ `finalized`).
- R5. The coordinator MUST NOT post conversational commentary while background workers are active; it MUST update the single live status card until finalization.

**Rich Visual Block Kit Components**

- R6. Generative UI MUST support high-impact visual components:
  - `metric`: Large KPI callouts with comparison delta (e.g. `₹38.4 Cr | +11% YoY`).
  - `callout`: Highlighted caveat blocks (e.g. `⚠️ 45 invoices on GL 112001 converted at historic booking rate`).
  - `table`: Formatted tables with right-aligned numeric columns, bold headers, and distinct `TOTAL` summary rows.
- R7. Generative UI MUST support 1-click action buttons (e.g. `Download Workbook (.xlsx)`, `View Method Review`, `Amend Scope`).

### Key Flows

- F1. Traceable Delivery with Live Background Status
  - **Trigger:** User asks for financial report or analysis (e.g. AR aging or Investor EBITDA bridge).
  - **Actors:** A1, A2, A3
  - **Steps:**
    1. Plan card is approved by Operator.
    2. QM creates/updates a live status card in the thread: `⏳ [1/3] Extracting NetSuite data...`.
    3. When Producer finishes and Auditor starts, status card updates to: `🔬 [2/3] Independent Audit & Tie-out...`.
    4. Upon finalization, status card marks `✅ Certified`.
    5. Agent posts the final Traceable Generative UI Card containing:
       - Header & KPI metrics.
       - Inline formatted data table.
       - **Every Answer, Traceable** provenance section linking each metric to its GL account and rule.
       - 1-click download button for the certified `.xlsx`.
  - **Covers:** R1, R2, R3, R4, R5, R6, R7

### Scope Boundaries

- **In Scope:**
  - `provenance`, `metric`, and `callout` element types in `src/slack/generative-ui.ts`.
  - System prompt enhancements in `src/core/orchestrator.ts` establishing the mandatory provenance design contract.
  - Live progress updates on Finny job status transitions.
- **Outside Scope (Deferred):**
  - Interactive drill-down modals inside Slack (e.g. opening popup dialogues on button click).
  - Direct SVG graph rendering in Slack messages.

### Acceptance Examples

- AE1. Net Worth Analysis with Traceable Provenance
  - **Covers:** R1, R2, R6
  - **Given:** User queries MTPL consolidated net worth.
  - **When:** Agent delivers the response.
  - **Then:** Output renders with KPI callouts (Negative Net Worth ₹(6,125) Cr, Cash ₹112 Cr), an annual breakdown table, and a structured provenance section tracing balances to GL 301001, GL 304101, and Series B–I debentures on GL 221102.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Unified Block Kit Component Catalog:** Extend `GenerativeUIElement` in `src/slack/generative-ui.ts` with `metric`, `callout`, and `provenance` types. Maps to Slack mrkdwn sections with bold callout brackets, monospace provenance badges, and structured divider sections. Governs R1, R6.
- KTD2. **Mandatory Provenance Prompting:** In `src/core/orchestrator.ts`, update the finance prompt to instruct the model to produce a `provenance` block listing: (1) Metric Name, (2) Source GL Account/Tables, (3) Cutoff Date/Time, (4) Normalization/Transformation Formula, and (5) Tie-out Status. Governs R2, R3.
- KTD3. **Live Status Tracking via Session Status / Card Update:** In `src/slack/session-status.ts` and `src/core/orchestrator.ts`, ensure background transitions update the thread's status card using `chat.update` so users see live progress without message spam. Governs R4, R5.

---

## Implementation Units

### U1. Traceable Provenance & Rich Card Components in Slack Generative UI

- **Goal:** Add `provenance`, `metric`, and `callout` element types to `src/slack/generative-ui.ts` and render them into rich Block Kit layouts.
- **Requirements:** R1, R6, R7
- **Files:**
  - `src/slack/generative-ui.ts`
  - `test/slack-finny-cards.test.ts`
  - `test/finny-harness-quality-eval.test.ts`
- **Approach:**
  - Extend `GenerativeUIElement` union:
    - `ProvenanceElement`: `{ type: "provenance", items: Array<{ metric: string, source: string, rule: string, status?: string }> }`
    - `MetricElement`: `{ type: "metric", label: string, value: string, delta?: string }`
    - `CalloutElement`: `{ type: "callout", text: string, level?: "info" | "warning" | "success" }`
  - Render `provenance` as formatted mrkdwn lines with monospace badges:
    `• *Metric* · \`GL Source\` · _Rule_ · ✅ Verified`
  - Render `metric` as high-contrast section fields or block quotes with large figures.
  - Render `callout` with warning/info emoji prefixes and quote bars.
- **Test Scenarios:**
  - `renderGenerativeUI` with `provenance` element produces structured Block Kit context/section blocks.
  - `metric` element with delta renders comparative KPI callouts.
  - `callout` with level="warning" renders formatted warning text.
- **Verification:** `node --test test/slack-finny-cards.test.ts`

### U2. Orchestrator Finance Prompt Contract for Provenance & Card Design

- **Goal:** Instruct financial models to always output headline figures with traceable provenance blocks.
- **Requirements:** R2, R3, R5
- **Files:**
  - `src/core/orchestrator.ts`
  - `test/finny-harness-quality-eval.test.ts`
- **Approach:**
  - Update `systemPrompt` in `orchestrator.ts`:
    - Add explicit `Every Answer, Traceable` instructions.
    - Require every output card to include: (1) `header`, (2) `metric` or `fields`, (3) `table` (if tabular data exists), (4) `provenance` tracing numbers to NetSuite GL accounts, and (5) download actions if a workbook exists.
- **Test Scenarios:**
  - Evaluator checks that financial prompt mandates `provenance` element inclusion.
- **Verification:** `node --test test/finny-harness-quality-eval.test.ts`

### U3. Live In-Place Status Card Updates for Finny Background Runs

- **Goal:** Ensure Finny background runs update a live status card in Slack rather than polluting the thread.
- **Requirements:** R4, R5
- **Files:**
  - `src/slack/session-status.ts`
  - `src/slack/turn-handler.ts`
  - `src/core/orchestrator.ts`
- **Approach:**
  - Hook Finny job status transitions into `SlackSessionStatus`:
    - On `producing`: post or update card to `⏳ [1/3] Extracting NetSuite data...`
    - On `auditing`: update card to `🔬 [2/3] Independent Audit & Tie-out...`
    - On `reworking`: update card to `🔄 Reworking workbook verification...`
    - On `finalized`: update card to `✅ Certified`
- **Test Scenarios:**
  - Job transitions invoke session status card updates.
- **Verification:** `bun run typecheck && node --test test/finny-agent-tool.test.ts`

---

## Verification Contract

- **Test Commands:**
  - `node --test test/slack-finny-cards.test.ts`
  - `node --test test/finny-harness-quality-eval.test.ts`
  - `node --test test/finny-agent-tool.test.ts`
  - `bun run typecheck`
- **Quality Gates:** Zero typecheck errors, all provenance and rich element rendering tests pass.

---

## Definition of Done

- All 3 implementation units completed and committed.
- `provenance`, `metric`, and `callout` elements natively rendered in Slack Block Kit.
- Finance prompt requires audit lineage blocks for all figures.
- Clean typecheck and full test suite passing.
