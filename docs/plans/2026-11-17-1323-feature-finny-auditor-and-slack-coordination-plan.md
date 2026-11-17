---
title: Independent Auditor Agent Topology and Slack Ingestion Architecture
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
created_at: 2026-11-17T13:23:00Z
---

## Goal Capsule

- **Objective:** Establish finny-staging as an independent auditor agent with isolated gateway connections and verify all multi-bot Slack interactions (code fences, rich text, bot/human tagging) so producer bots and humans can be audited and guided without communication loss.
- **Means:** Extend Slack payload ingestion to parse `rich_text` and preformatted code blocks (KTD1), upgrade outbound mention resolution to index bot profiles and multi-word display names (KTD2), and configure finny-staging with dedicated credentials, runtime tenancy, and read-only SuiteQL verification capabilities (KTD3).
- **Product authority:** Finny governance harness and Slack surface adapter; does not alter producer bot runtime internals.
- **Open blockers:** None.

---

## Product Contract

### Summary

finny-staging operates as an independent auditor bot with its own Slack identity, gateway connection, and read-only NetSuite SuiteQL credentials. It participates in shared Slack channels alongside humans and producer bots (such as finny-freehand), actively reviewing calculations, parsing SuiteQL queries out of formatted code blocks, and tagging participants accurately to unblock financial cutoffs.

### Problem Frame

During financial cutoffs and AP/GL tie-outs, human operators and automated producer agents coordinate in shared Slack channels. finny-staging was introduced to provide governance checks and verify populations before execution. In practice, three critical points of failure emerged:

1. When producer bots paste SQL queries inside code blocks or rich text elements, Slack delivers them as `rich_text` structures. Because QM's message content parser ignored `rich_text`, queries arrived completely blank, forcing human intervention.
2. In multi-agent channels, the auditor was unable to tag producer bots or human stakeholders due to limitations in display name normalization and bot user exclusion in the directory index.
3. Operating as a shared or dependent instance compromised the auditor's objectivity and ability to independently reproduce queries against NetSuite SuiteQL.

### Actors

- **A1. Independent Auditor (finny-staging):** An autonomous QM agent instance holding read-only SuiteQL and control-balance access, responsible for evaluating gate conditions, cross-checking query logic, and issuing binding approvals or rejections.
- **A2. Producer Bot (finny-freehand):** Automated data worker responsible for assembling extracts, workbooks, and proposing SQL queries and tie-out schedules.
- **A3. Human Approver / Operator (e.g., Kali, Bhoomika):** Finance leadership confirming business cutoff dates, reviewing gate discrepancies, and approving final disbursements.

### Key Decisions

- **KD1. Full recursive extraction of Slack rich text:** Support all Slack Block Kit rich text elements (`rich_text_preformatted`, `rich_text_section`, `rich_text_list`, `rich_text_quote`) in message content decoding. Governs R1, R2.
- **KD2. Unified Slack mention indexing for bots and multi-word names:** Index bot display names, app usernames, and multi-word human names without discarding duplicates prematurely, allowing clean `@bot-handle` and `@First Last` resolution. Governs R3, R4.
- **KD3. Strict runtime and credential isolation for Auditor:** finny-staging runs as its own container/process with distinct Slack App tokens and dedicated NetSuite TBA credentials to ensure audit independence. Governs R5, R6.

### Requirements

#### Inbound Slack Formatting and Code Block Parsing

- R1. Slack message ingestion extracts text from all `rich_text` blocks, including `rich_text_preformatted` (code blocks), `rich_text_section`, `rich_text_list`, and `rich_text_quote`.
- R2. Code fences (triple backticks) and language tags sent by Slack clients or external bots are preserved verbatim in turn inputs without blanking or truncation.

#### Outbound Mention Arming and Multi-Bot Coordination

- R3. Outbound message formatting converts plain `@mentions` of bot identities (such as `@finny-freehand` or `@finny-staging`) into Slack-native `<@BOT_USER_ID>` syntax.
- R4. Multi-word display names and real names for human users resolve accurately without truncation or syntax corruption.

#### Independent Auditor Architecture & SuiteQL Verification

- R5. The auditor operates on an isolated gateway connection and distinct Slack Bot token, maintaining its own thread stake and session history.
- R6. The auditor possesses independent, read-only NetSuite SuiteQL execution tools to verify transaction period boundaries, GL control tie-outs, and AP balances without relying on producer-supplied snapshots.
- R7. When a producer bot or human submits query logic, the auditor parses the query, executes its own read-only shadow check, and returns a structured audit verdict (Approve / Block / Clarify).

````mermaid
sequenceDiagram
  autonumber
  actor Human as Human Operator (Kali/Bhoomika)
  participant Producer as Producer Bot (finny-freehand)
  participant Slack as Slack Channel
  participant Auditor as Auditor Agent (finny-staging)
  participant NetSuite as NetSuite SuiteQL

  Producer->>Slack: Post Plan & SuiteQL Query (in ```sql code block)
  Slack->>Auditor: Message event (rich_text_preformatted)
  Note over Auditor: R1, R2: Extract SQL text from rich_text blocks
  Auditor->>NetSuite: Independent verification query (R6)
  NetSuite-->>Auditor: Return live control balance & row count
  alt Gates Pass
    Auditor->>Slack: Tag @finny-freehand and @Human with approval & gate audit
  else Discrepancy Found
    Auditor->>Slack: Tag @finny-freehand with specific diff and block gate
  end
````

### Key Flows

- F1. **Code block extraction and query review**
  - **Trigger:** A producer bot posts a thread reply containing SuiteQL queries within Markdown code fences or Slack preformatted blocks.
  - **Actors:** A2 (Producer), A1 (Auditor).
  - **Steps:** Slack adapter parses `rich_text_preformatted` elements into code-fenced strings; orchestrator passes untrusted SQL into the auditor turn; auditor executes preflight syntactic and accounting boundary checks.
  - **Outcome:** Auditor receives full query text rather than empty blocks.
  - **Covered by:** R1, R2.

- F2. **Auditor tagging and gate confirmation**
  - **Trigger:** Auditor finishes verifying Gate A, Gate B, and Gate C tie-out conditions.
  - **Actors:** A1 (Auditor), A2 (Producer), A3 (Human).
  - **Steps:** Auditor composes review response referencing both `@finny-freehand` and the designated human approver; Slack outbound formatter arms mentions using user and bot directory indices.
  - **Outcome:** Both the producer bot and human approver receive Slack push notifications with actionable gate status.
  - **Covered by:** R3, R4, R7.

### Acceptance Examples

- AE1. **SuiteQL Code Block Delivery**
  - **Covers:** R1, R2
  - **Given:** A message payload containing `type: "rich_text"` with an inner element of `type: "rich_text_preformatted"` holding `SELECT id, amount FROM transaction`.
  - **When:** `slackMessageContent` processes the block list.
  - **Then:** Returned `text` contains the enclosed SQL query formatted within code blocks.

- AE2. **Bot-to-Bot Tagging**
  - **Covers:** R3, R4
  - **Given:** An outbound message from finny-staging stating `@finny-freehand please re-run cutoff`.
  - **When:** `toSlackMrkdwn` executes with the directory mention index loaded.
  - **Then:** The output string transforms to `<@U_FREEHAND_BOT_ID> please re-run cutoff`.

- AE3. **Independent Control Tie-Out**
  - **Covers:** R6, R7
  - **Given:** Producer claims SAP carry-forward of 77 rows matches GL 111001 control balance.
  - **When:** Auditor evaluates Gate A requirements.
  - **Then:** Auditor flags that SAP legacy rows are unverified against live GL, requires explicit disclosure footnotes, and blocks delivery until native populations tie out to GL actuals.

### Scope Boundaries

- **In scope:**
  - Slack wire decoding for `rich_text` and code blocks.
  - Outbound mention resolver improvements for bot profiles and display names.
  - Multi-agent coordination rules between Producer and Auditor personas.
  - Auditor tool contract for read-only SuiteQL validation.
- **Deferred for later:**
  - Automated Slack app manifest synchronization across dev workspaces.
  - Full write-back mutations to NetSuite ERP.
- **Outside this product's identity:**
  - Direct P2P inter-agent RPC outside Slack or documented API turn boundaries; audit logs must remain visible in the shared Slack thread.

### Success Criteria

- **SC1. Zero Empty Code Blocks:** 100% of code-fenced or preformatted messages posted in Slack threads are visible to agent turn inputs.
- **SC2. Dual Tagging Reliability:** Outbound messages mentioning human and bot participants successfully render as blue clickable mentions triggering Slack notification events.
- **SC3. Audit Autonomy:** finny-staging executes read-only validation queries against live data sources without relying on producer-supplied intermediate files.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Rich Text AST Ingestion Walker:** In `src/slack/message-content.ts`, add visitor handlers for `rich_text` blocks and their recursive elements (`rich_text_section`, `rich_text_preformatted`, `rich_text_list`, `rich_text_quote`). For `rich_text_preformatted`, format text wrapped in triple backticks and preserve any specified language attribute. Governs R1, R2.
- **KTD2. Dual-Pool Mention Indexing in Directory:** In `src/slack/directory.ts`, index bot members (`u.is_bot: true`) using their bot profile display name, real name, and app name. In `src/slack/mrkdwn.ts`, update `armUserMentions()` regex to tokenize matching against indexed handles with hyphens, underscores, and spaces. Governs R3, R4.
- **KTD3. Autonomous Auditor Tenancy:** Auditor deploys as a standalone service instance with independent Slack App credentials (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`) and distinct `KEYCHAIN` credentials granting read-only SuiteQL queries, enabling independent shadow audits. Governs R5, R6, R7.

---

## Implementation Units

### U1. Recursive Rich Text & Code Block Ingestion

- **Goal:** Enable `slackMessageContent` to recursively parse Slack `rich_text` blocks and format code blocks without dropping content.
- **Requirements:** R1, R2
- **Files:**
  - `src/slack/message-content.ts`
  - `test/slack-message-content.test.ts`
- **Approach:**
  - In `src/slack/message-content.ts`, extend `blockText(block)` to handle `block.type === "rich_text"`.
  - Process elements recursively:
    - `rich_text_section`: concatenate text objects and link labels.
    - `rich_text_preformatted`: extract enclosed text elements and wrap in ` ```\n${text}\n``` `.
    - `rich_text_list`: format items as bulleted or numbered lines.
    - `rich_text_quote`: prefix with `> `.
- **Test Scenarios:**
  - Test payload containing `type: "rich_text"` with a `rich_text_preformatted` block containing SQL query text.
  - Verify that `slackMessageContent` returns the SQL query inside code fences.
- **Verification:** `node --test test/slack-message-content.test.ts`

### U2. Bot Profile and Multi-Word Outbound Mention Resolution

- **Goal:** Ensure outbound messages arm both bot usernames (e.g., `@finny-freehand`) and human names (e.g., `@Kalishukla`) to Slack wire tags `<@ID>`.
- **Requirements:** R3, R4
- **Files:**
  - `src/slack/directory.ts`
  - `src/slack/mrkdwn.ts`
  - `test/slack-mrkdwn.test.ts`
- **Approach:**
  - In `src/slack/directory.ts`, allow bot members (`u.is_bot === true`) to be indexed into `mentionIndex` by `u.name`, `u.profile?.display_name`, and `u.real_name`.
  - In `src/slack/mrkdwn.ts`, refine `MENTION_SEGMENT` and `PLAIN_MENTION` regex to support alphanumeric tokens joined by hyphens, underscores, dots, or spaces.
- **Test Scenarios:**
  - Outbound string `@finny-freehand please check Gate A` converts to `<@B_FREEHAND_ID> please check Gate A`.
  - Outbound string `@Kalishukla please confirm` converts to `<@U_KALI_ID> please confirm`.
- **Verification:** `node --test test/slack-mrkdwn.test.ts`

### U3. Independent Auditor Gateway Setup and Verification Guide

- **Goal:** Document the deployment configuration, environment variables, and NetSuite TBA credentials required for finny-staging to act as an independent auditor.
- **Requirements:** R5, R6, R7
- **Files:**
  - `docs/solutions/architecture/independent-finny-auditor-guide.md`
- **Approach:**
  - Document the separate instance deployment pattern: isolated process, separate Slack socket mode credentials, dedicated database/storage scope.
  - Document the read-only SuiteQL verification loop and how the auditor executes shadow queries to validate populations.
- **Verification:** Markdown structure and verification check against repo coding standards.

---

## Verification Contract

| Command                                          | Purpose                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `node --test test/slack-message-content.test.ts` | Proves `rich_text` and code blocks parse correctly from Slack payloads |
| `node --test test/slack-mrkdwn.test.ts`          | Proves outbound bot and human tagging arm to `<@ID>`                   |
| `npm run build`                                  | Full TypeScript typecheck and compilation gate                         |

---

## Definition of Done

- [ ] All `rich_text` blocks and `rich_text_preformatted` code snippets in incoming Slack events are parsed into turn input text.
- [ ] Outbound `@finny-freehand` and human names convert to `<@ID>` wire syntax.
- [ ] Independent auditor deployment architecture is fully documented and testable.
- [ ] Zero lint, typecheck, or test regressions across the repository.
- [ ] All abandoned/temporary test scaffolds cleaned up.
