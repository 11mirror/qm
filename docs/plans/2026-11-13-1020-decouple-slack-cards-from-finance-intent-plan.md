---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
title: Decouple Slack Card Presentation from Finance Intent & Surface Gateway Standard
created_at: 2026-11-13
---

## Goal Capsule

- **Objective:** Any agent interaction on the Slack surface presenting structured data, metrics, or summaries renders as a bordered Block Kit card, decoupled from fragile and subjective finance keyword regexes.
- **Means:** Move standard Block Kit Generative UI card instructions into Slack's native `gatewayContext.instructions` in `src/slack/turn-handler.ts`, leaving `isFinanceTurn` solely responsible for FinnyLoop plan governance.
- **Product Authority:** Operators in Slack threads; QM Slack surface runtime and orchestrator.
- **Open Blockers:** None.

---

## Product Contract

### Summary

Decouple Slack card presentation from subjective finance keyword matching. Move Generative UI / `json-render` card formatting instructions into Slack's surface gateway context so that _any_ data presentation query on Slack naturally formats as an interactive card. Keep `isFinanceTurn` strictly scoped to mandatory FinnyLoop governance (plan approval, producer/auditor grants, workbook certification).

### Problem Frame

Currently, instructions teaching the model how to emit Generative UI cards (`schema: "generative-ui.v1"` / `json-render`) are trapped inside `if (isFinanceTurn)` in `src/core/orchestrator.ts`.
This leads to subjective and fragile behavior:

1. If a user asks _"present simple data on our past interactions"_, _"summarize workstreams"_, or asks an ad-hoc diagnostic question without matching specific finance keywords (NetSuite, AP, AR, GL, EBITDA), `isFinanceTurn` evaluates to `false`.
2. The model receives zero card instructions and falls back to raw Markdown tables and plain text.
3. Card formatting should be a **surface capability of Slack**, not an artifact of accounting intent.

### Key Decisions

- KD1. **Surface Gateway Standard for Cards:** Move Generative UI card instructions to `gatewayContext.instructions` in `src/slack/turn-handler.ts`. Any Slack conversation receives card design instructions. Governs R1, R2.
- KD2. **Finance Gate Isolation:** Retain `isFinanceTurn` in `src/core/orchestrator.ts` strictly for FinnyLoop governance lifecycle (plan presentation, auditor tie-outs, NetSuite verification). Governs R3.

### Requirements

**Surface Presentation Architecture**

- R1. Slack's `gatewayContext` MUST inject Generative UI card formatting instructions for all Slack conversations (DMs and channels).
- R2. When answering queries that present data, tables, summaries, or metrics on Slack, the agent MUST render using the generative UI card schema or Chat SDK format (`{ root, elements }`).
- R3. `isFinanceTurn` in `orchestrator.ts` MUST focus exclusively on accounting rules, NetSuite field specifications, invariants, and mandatory FinnyLoop plan approval.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Slack Presentation Gateway Block:** Add `SLACK_CARD_PRESENTATION_INSTRUCTION` to `src/slack/turn-handler.ts` (combining with `REACTION_INSTRUCTION`), ensuring every Slack turn receives card styling rules without touching core orchestrator finance logic. Governs R1, R2.
- KTD2. **Orchestrator Finance Prompt Streamlining:** Remove generic card styling boilerplate from `orchestrator.ts:1192` and focus the prompt strictly on FinnyLoop plan requirements, mandatory invariants, and in-flight silence. Governs R3.

---

## Implementation Units

### U1. Slack Gateway Context Presentation Injection

- **Goal:** Teach the model how to emit Generative UI cards across all Slack turns.
- **Files:**
  - `src/slack/turn-handler.ts`
  - `src/slack/reactions.ts`
  - `test/slack-finny-cards.test.ts`
- **Approach:**
  - Define `SLACK_CARD_INSTRUCTION` in `src/slack/reactions.ts` (or `src/slack/lib.ts`).
  - Append to `gatewayContext.instructions` in `turn-handler.ts`.
- **Verification:** Unit tests confirming gateway context carries card design instructions.

### U2. Orchestrator Finance Prompt Cleanup

- **Goal:** Cleanly separate finance governance from generic card rendering.
- **Files:**
  - `src/core/orchestrator.ts`
  - `test/finny-harness-quality-eval.test.ts`
- **Approach:**
  - In `orchestrator.ts`, keep `isFinanceTurn` focused on Finny plan presentation, invariants, and in-flight silence.
- **Verification:** `node --test test/finny-harness-quality-eval.test.ts`

---

## Verification Contract

- **Test Commands:**
  - `node --test test/slack-finny-cards.test.ts`
  - `node --test test/finny-harness-quality-eval.test.ts`
  - `bun run typecheck`
- **Quality Gate:** Zero typecheck errors, non-finance data presentation queries receive card formatting instructions.
