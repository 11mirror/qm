---
name: linear
description: Search, read, create, and update the user's Linear issues, projects, and comments through per-user OAuth.
requiredCapabilities:
  - connector:linear
  - egress:api.linear.app
---

# Linear

Use this skill when the user asks about Linear issues, tickets, projects, cycles, or
their team's work tracking — finding issues, checking status, filing a bug, leaving a
comment, or updating an issue.

This is an OAuth connector used by proxy: the user's token never enters your computer.
Select the connected-app credential for `api.linear.app` in `execute.credentials` (for
example `connector:api.linear.app:default`); that command gets `$AGENT_CREDENTIAL_TOKEN`.
Call `$AGENT_API_URL/v1/credentials/http/<host>/<path>` with `-H "x-agent-capability:
$AGENT_CREDENTIAL_TOKEN"`; the credential broker adds the user's token and forwards the
request to `https://<host>/<path>`. If you selected two accounts for the same host, put
the credential handle where the host goes.

Linear's API is GraphQL at `https://api.linear.app/graphql`, so post to
`$AGENT_API_URL/v1/credentials/http/api.linear.app/graphql`. Do not ask the user for a
token or use another principal's credential.

If no Linear credential is listed, or the broker or API returns 401/410 (`authentication`,
`connector_unavailable`), tell the user they need to connect Linear (Connectors page) and
stop — don't guess at issue data.

## Find / read issues

Query issues by text, assignee, or state:

```bash
curl -sS -X POST "$AGENT_API_URL/v1/credentials/http/api.linear.app/graphql" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"query":"{ issues(first: 20, filter: { title: { containsIgnoreCase: \"login\" } }) { nodes { identifier title state { name } assignee { name } url } } }"}'
```

Read one issue by id/identifier:

```bash
curl -sS -X POST "$AGENT_API_URL/v1/credentials/http/api.linear.app/graphql" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"query":"{ issue(id: \"ENG-123\") { identifier title description state { name } assignee { name } url comments { nodes { body user { name } } } } }"}'
```

Keep issue identifiers and `url`s in your answer so claims can be traced.

To create or assign an issue you usually need a team id — list them once:

```bash
curl -sS -X POST "$AGENT_API_URL/v1/credentials/http/api.linear.app/graphql" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"query":"{ teams(first: 100) { nodes { id key name } pageInfo { hasNextPage endCursor } } }"}'
```

Linear paginates every list: if `pageInfo.hasNextPage` is true, re-query with
`after: "<endCursor>"` — never conclude a team or issue doesn't exist from one page.

## Writes require approval

Creating an issue, commenting, or changing state is a write. Prepare the exact mutation,
summarize what it will create/change (team, title, target issue), and ask for approval
before running it.

After approval, create an issue:

```bash
curl -sS -X POST "$AGENT_API_URL/v1/credentials/http/api.linear.app/graphql" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"query":"mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }","variables":{"input":{"teamId":"TEAM_ID","title":"Login button misaligned on mobile","description":"Reported by a user; repro on iOS Safari."}}}'
```

Add a comment to an existing issue:

```bash
curl -sS -X POST "$AGENT_API_URL/v1/credentials/http/api.linear.app/graphql" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"query":"mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }","variables":{"input":{"issueId":"ISSUE_UUID","body":"Fixed in the latest deploy."}}}'
```

Always report the resulting issue/comment identifier and `url`.
