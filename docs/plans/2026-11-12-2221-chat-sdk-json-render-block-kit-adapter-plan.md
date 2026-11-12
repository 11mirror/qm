---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
title: Native Chat SDK json-render and Slack Block Kit Adapter
created_at: 2026-11-12
---

## Goal Capsule

- **Objective:** Generative UI cards generated in Chat SDK `json-render` format (`{ root, elements }`) and Slack Block Kit format map natively to clean, full-width Block Kit elements without dropping fields, tables, or formatting.
- **Means:** Implement full official Chat SDK / json-render component mapping (`Card`, `Section`, `Text`, `Fields`/`Field`, `Table`, `Actions`/`Button`, `Divider`) supporting both normalized component trees and direct element dictionaries.
- **Product Authority:** Finance and analytics operators in Slack origin threads; Chat SDK and Vercel json-render component catalog.
- **Stop Conditions:** All official json-render components render accurately to Slack Block Kit with unit tests passing.

---

## Product Contract

### Summary

Rewrite the Slack Block Kit card adapter in `src/slack/generative-ui.ts` to fully support official `@json-render/chat` and Vercel Chat SDK specifications. Support component types with both case-insensitive names (`Card`/`card`, `Text`/`text`, `Field`/`field`, `Table`/`table`) and property aliases (`label`/`title`, `headers`/`columns`, `content`/`text`).

### Problem Frame

In recent runs (such as thread `p1794501215788519`), the model writes either natural Chat SDK component specs or direct Block Kit elements. When `Field` properties use `title` instead of `label`, or `Table` uses `columns` instead of `headers`, or `Text` is inside nested sections, the adapter drops elements or renders empty labels (`**\n3,228 Cr`). The card adapter must follow the official Vercel `@json-render/chat` component definitions and map them seamlessly to Slack Block Kit.

### Requirements

- R1. `parseGenerativeUISpec` MUST fully support official `@json-render/chat` specs: `{ root: string, elements: Record<string, { type, props, children }> }`.
- R2. `Field` component MUST accept `title`, `label`, or `name` for the field header and `value` for the body.
- R3. `Table` component MUST accept `headers` or `columns` as string arrays and `rows` as 2D arrays.
- R4. `Text` and `Section` components MUST resolve markdown content and preserve bold headers, lists, and numbers.
- R5. Nested `Card` elements MUST render as titled sections, as specified in the `@json-render/chat` specification.
- R6. `Button` and `LinkButton` components MUST map to Slack action buttons with `primary` / `danger` styles and URLs.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Bidirectional Component Normalization:** Handle both official json-render object-map structure (`elements: { [key]: { type, props, children } }`) and linear list structure (`elements: [...]`), mapping all elements into standard Block Kit blocks. Governs R1, R2, R3, R4.
- KTD2. **Universal Field Key Aliasing:** `Field` props check `props.title ?? props.label ?? props.name` so neither dialect drops its title. Governs R2.
- KTD3. **Table Column Resiliency:** `Table` props check `props.headers ?? props.columns` and format into clean Slack ASCII table codeblocks with column padding. Governs R3.

---

## Implementation Units

### U1. Chat SDK Component Parser Rewrite (`src/slack/generative-ui.ts`)

- **Files:** `src/slack/generative-ui.ts`
- **Changes:**
  - Standardize `walkChildren` in `parseGenerativeUISpec`:
    - Support `Card`, `Section`, `Text`, `Fields`, `Field`, `Table`, `Divider`, `Actions`, `Button`, `LinkButton`.
    - Fix `Field`: `const title = String(fp.title ?? fp.label ?? fp.name ?? "");`
    - Fix `Table`: `const headers = (props.headers ?? props.columns) as unknown[];`
    - Support case-insensitive component names (`Card` vs `card`, `Text` vs `text`).
    - Recurse through nested `Section` and `Card` children.

### U2. Evaluation and Regression Tests (`test/slack-generative-ui.test.ts`)

- **Files:** `test/finny-harness-quality-eval.test.ts`
- **Changes:**
  - Add test verifying complete `@json-render/chat` official card structure from the Vercel demo.
  - Verify that fields, tables, text, buttons, and headers render into complete Slack Block Kit blocks without missing text or empty labels.

---

## Verification Contract

- **Commands:**
  - `node --test test/finny-harness-quality-eval.test.ts`
  - `bun run typecheck`
- **Quality Gate:** 100% test pass on all Chat SDK and json-render specs.
