---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
title: Finny Harness Resilience, Compact Slack Card Guidelines, and Subagent Tool Availability
created_at: 2026-11-13
---

## Goal Capsule

- **Objective:** Finance operators on Slack receive un-truncated, beautifully formatted Block Kit cards without client-side collapsing, while background Finny subagents reliably inherit role-bound `finny` tools to execute deterministic audits and finalize reports without stalling.
- **Means:** Enforce compact card rules (max 4 rows per table, summary KPI fields), ensure subagent toolsets inject the bound `finny` tool for `producer` and `auditor` roles, and harden spreadsheet producer scripts with dynamic row-range calculation. (KTD1, KTD2, KTD3)
- **Product Authority:** Finance operators on Slack; QM Finny store, runtime coordinator, and agent tool factory.
- **Stop Conditions:** All 3 units verified via tests, eval suite passing, and clean typecheck.

---

## Product Contract

### Summary

Harden the Finny finance harness across three identified failure modes: (1) prevent Slack desktop/mobile clients from collapsing cards with blue `Show more` links by enforcing compact 2-4 row tables and 2-column KPI grids, (2) ensure all spawned worker subagents reliably receive the `finny` tool with their active `producer`/`auditor` role grant, and (3) fix formula row-range offsets in spreadsheet builder scripts so total formulas dynamically match exact data rows.

### Problem Frame

During live testing across Test 1, Test 2, and Test 3:

1. **Slack Table Auto-Collapsing (`Show more`):** When models output multi-row tables (e.g. 10 workstreams or 8 debt instruments), Slack's client-side layout collapses the card into `Show more` / `Show less` folds, destroying the visual flow and making it look like unformatted code blocks.
2. **Missing Subagent `finny` Tool:** In Test 3 (`session d9df7fa6`), the spawned `Finny Auditor 2` subagent reported `[procedural blocker: There is no 'finny' tool in this session's toolset]`. It could not invoke `finny_pass`, `finny_block`, or `deterministic_audit`, leaving the parent coordinator waiting and stalling report finalization.
3. **Producer Row-Range Formula Bug:** The producer script emitted TOTAL formulas covering rows 2 to $N-1$ instead of 3 to $N$, excluding the last data row upon Excel recalculation.

### Requirements

**Compact Slack Card Guidelines**

- R1. Slack card prompt guidelines MUST restrict inline tables to top 3–5 summary rows.
- R2. Lists longer than 5 items MUST be formatted as 2-column Block Kit `fields` grids or deferred to the downloadable `.xlsx` workbook.
- R3. Card sections MUST use dividers (`{"type":"divider"}`) between distinct metric groups to prevent vertical code block merging.

**Subagent Tool Availability**

- R4. QM tool context factory MUST inject the `finny` tool into subagent sessions whenever the turn has an active Finny runtime binding (`producer` or `auditor`).
- R5. If a subagent has an assigned Finny role, it MUST be able to call `finny status`, `finny pass`, `finny block`, and `finny deterministic_audit`.

**Spreadsheet Producer Range Calculation**

- R6. Producer workbook builder instructions MUST mandate computing Excel formula ranges dynamically (`f"SUM(L3:L{last_row})"`), ensuring row ranges never omit the final data line.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Compact Table & Card Layout Prompting:** Update `SLACK_CARD_INSTRUCTION` in `src/slack/reactions.ts` and `orchestrator.ts` to explicitly cap inline table length to 3–5 key rows and guide models to use 2-column `fields` for longer itemized lists. Governs R1, R2, R3.
- KTD2. **Subagent Tool Injection Guarantee:** In `src/agent/agent-tools.ts` and `src/core/orchestrator.ts`, ensure `finny` tool is included in `tools` when `ref.current?.finny` is present or when the subagent carries a Finny worker binding. Governs R4, R5.
- KTD3. **Dynamic Formula Range Guidance:** In `src/wiring.ts` (`workerPolicy.task.instruction`), explicitly mandate using dynamic `min_row=3, max_row=ws.max_row` for all `SUM` formulas. Governs R6.

---

## Implementation Units

### U1. Compact Card Guidelines & Layout Rules in Slack Prompting

- **Goal:** Stop Slack from auto-collapsing cards with `Show more` by enforcing compact tables and summary fields.
- **Files:**
  - `src/slack/reactions.ts`
  - `src/core/orchestrator.ts`
  - `test/finny-harness-quality-eval.test.ts`
- **Approach:**
  - In `SLACK_CARD_INSTRUCTION`, specify:
    - Inline tables MUST be compact: 3–5 rows max.
    - If displaying >5 items, format as a 2-column `fields` grid or summarize top items with an "and N more in attached sheet" note.
    - Use dividers between metrics and tables for visual separation.
- **Verification:** `node --test test/finny-harness-quality-eval.test.ts`

### U2. Guarantee Subagent `finny` Tool Availability

- **Goal:** Ensure every Finny Producer/Auditor subagent receives its callable `finny` tool so audits never stall.
- **Files:**
  - `src/core/orchestrator.ts`
  - `src/finny/integration.ts`
  - `test/finny-agent-tool.test.ts`
- **Approach:**
  - In `orchestrator.ts:2583-2605`, ensure that when `turn.parentSessionId` is present and the session is bound to a Finny worker run, `finnyTools.forTurn` properly claims and injects the worker grant.
- **Verification:** `node --test test/finny-agent-tool.test.ts`

### U3. Dynamic Formula Range Guidance for Spreadsheet Producers

- **Goal:** Prevent off-by-one formula ranges in Excel totals.
- **Files:**
  - `src/wiring.ts`
  - `test/finny-deterministic-worker.test.ts`
- **Approach:**
  - In `src/wiring.ts:2216`, add explicit guidance:
    - Data rows start at row 3 (under headers). Total formulas MUST evaluate `SUM(col3:col{last_row})` dynamically, ensuring the last data item is never excluded.
- **Verification:** `node --test test/finny-deterministic-worker.test.ts`

---

## Verification Contract

- **Test Commands:**
  - `node --test test/finny-harness-quality-eval.test.ts`
  - `node --test test/finny-agent-tool.test.ts`
  - `node --test test/finny-deterministic-worker.test.ts`
  - `node --test test/slack-finny-cards.test.ts`
  - `bun run typecheck`
- **Quality Gate:** Zero typecheck errors, subagents receive `finny` tool, all prompt and eval tests pass.

---

## Definition of Done

- All 3 implementation units completed and committed.
- Slack cards render compactly without client-side `Show more` folds.
- Finny auditor subagents reliably inherit `finny` tools.
- Typecheck and full test suite passing.
