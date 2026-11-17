# Independent Finny Auditor Deployment & Verification Guide

This guide establishes the production and staging architecture for running **QM Finny as an Independent Auditor & Reviewer**.

## Architecture Overview

```
                                  +------------------------------+
                                  |   Producer Agent             |
                                  |   (e.g., finny-freehand)     |
                                  |   - Generates extracts & SQL |
                                  |   - Proposes workbook data   |
                                  +--------------+---------------+
                                                 |
                                                 v
+------------------------+        +------------------------------+
| Human Approver         | <----> | Slack Thread (Channel)       |
| (Finance Leadership)   |        | - Shared audit log           |
+------------------------+        | - Interactive plan cards     |
                                  +--------------+---------------+
                                                 ^
                                                 |
                                  +--------------+---------------+
                                  | Independent Auditor (Finny)  |
                                  | (finny-staging)              |
                                  | - Dedicated gateway & token  |
                                  | - Read-only SuiteQL queries  |
                                  | - Formula & gate tie-outs    |
                                  +--------------+---------------+
                                                 |
                                                 v
                                  +------------------------------+
                                  | NetSuite ERP (SuiteQL Engine)|
                                  | - Live GL actuals            |
                                  | - Period posting boundaries  |
                                  +------------------------------+
```

## 1. Gateway Isolation & Identity Tenancy

To function as an independent auditor rather than a passive observer or shared session worker, `finny-staging` must run with:

- Dedicated **Slack App & Bot Tokens**:
  - `SLACK_APP_TOKEN` (Socket Mode)
  - `SLACK_BOT_TOKEN` (`xoxb-...`) with `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`.
- Isolated process lifetime and persistent PostgreSQL database backend:
  - `DATABASE_URL` dedicated to auditor run state and `finny_jobs` ledger.
  - `PUBLIC_WEB_URL` mapped to the staging instance domain.

## 2. Inbound Slack Ingestion & Outbound Tagging Guarantees

1. **Rich Text & Code Block Ingestion:**
   - Inbound Slack messages containing preformatted code fences (`type: "rich_text_preformatted"`) are extracted directly into code-fenced markdown (` ```...``` `).
   - Prevents empty SuiteQL queries when external bots or users paste SQL inside formatted code blocks.
2. **Outbound Multi-Bot and Human Tagging:**
   - Mentions such as `@finny-freehand` or `@Kalishukla` are automatically armed by QM's Slack markdown converter into Slack wire syntax (`<@USER_OR_BOT_ID>`).
   - Bot members from `users.list` are indexed by app handle, display name, and real name to guarantee notification delivery across participants.

## 3. Read-Only NetSuite SuiteQL Verification Loop

When evaluating financial tie-out gates:

- **Gate A (Native Population vs GL Control):**
  - Auditor independently queries `transaction.postingperiod` and `trandate` actuals via SuiteQL to verify `SUM(foreignamountunpaid)` against GL control balances.
  - Excludes unverified carry-forward stores (e.g., SAP legacy parquet extracts) from live tie-out arithmetic unless explicitly reconciled.
- **Gate B (Crossfoot Integrity):**
  - Validates sheet formulas and crossfoot sums to the penny across tabs.
- **Gate C (Population Consistency):**
  - Compares version-over-version row counts and discloses excluded GL accounts.

## 4. Runbook: Verification Commands

```bash
# Verify Slack rich text and code fence parsing
node --test test/slack-message-content.test.ts

# Verify Slack outbound bot and user mention arming
node --test test/slack-mrkdwn.test.ts

# Build and check type cleanliness
npm run build
```
