# HTTP chat surfaces

An HTTP chat surface connects QM to a chat product that is not Slack: the product sends
signed message events to QM, and QM posts replies back through the product's REST API. Each
configured surface gets its own surface name, scope namespace and signing secret. Nothing
product-specific lives in QM; the contract below is all a product implements.

Inside QM an HTTP chat surface is one implementation of the `Surface` contract in
`src/surfaces/surface.ts`; Slack is the other. It declares no edits, reactions or rich
cards, and Markdown text.

## Configuration

`HTTP_CHAT_SURFACES` is a JSON array. Each entry:

| Field                  | Meaning                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `surface`              | Surface name, `^[a-z][a-z0-9-]{0,31}$`. Not `slack`, `web` or another built-in name.      |
| `account`              | Account or workspace id within the surface. Default `default`.                            |
| `label`                | Product name the model is told it is talking over, e.g. "over Acme Chat".                 |
| `apiUrl`               | Base URL of the product's agent API.                                                      |
| `apiToken`             | Bearer token QM sends to `apiUrl`.                                                        |
| `signingSecret`        | At least 32 characters. Signs events sent to QM. Distinct from QM's own signing secret.   |
| `internalEmailDomains` | Email domains whose authors are internal members. Everyone else is a guest. Default none. |

## Events in: `POST /v1/surfaces/<surface>/events`

Signed exactly like QM source-auth requests: `x-timestamp` (Unix seconds) and
`x-signature: v0=<hex HMAC-SHA256(signingSecret, "v0:<timestamp>:POST\n<path?query>\n<body>")>`.
Requests older than five minutes are rejected, as is any body over QM's 1 MB request limit;
no field has a cap of its own. Event types other than `message` are accepted and ignored.

```json
{
  "type": "message",
  "chat": { "id": "42", "kind": "dm", "name": "optional", "members": [{ "id": "7", "email": "a@example.com" }] },
  "message": {
    "id": "9001",
    "thread_id": null,
    "text": "Markdown text",
    "mentions_bot": false,
    "thread_has_bot": false,
    "sent_at": 1767225600000,
    "attachments": [{ "id": "f1", "name": "deck.pdf", "mimetype": "application/pdf", "size": 1024, "url": "https://…" }]
  },
  "author": {
    "id": "7",
    "email": "a@example.com",
    "name": "A",
    "guest": false,
    "bot": false,
    "timezone": "America/Los_Angeles"
  }
}
```

Only `chat.kind: "dm"` starts turns for now; `group` and `channel` events are accepted and
ignored, because QM's channel handling still answers through a Slack-shaped posting tool.
`message.id` is the idempotency key, so redelivering an event does not start a second turn.
`author.email` becomes the QM principal. An author is an internal member only when the email's
domain is in `internalEmailDomains` and `guest` is not true; everyone else, including an
author without an email, is a guest.

Trust model: whoever holds `signingSecret` can speak as any author on this surface, the same
trust QM extends to Slack's user ids. Keep the secret server-side in the product, and keep
`internalEmailDomains` to the domains that product authenticates.

Conversation references are qualified by surface and account: a DM in chat 42 is thread
`<surface>:<account>:dm:42` with scope `personal:<email>`; a channel thread is
`<surface>:<account>:ch:42:<thread_id>` with scope `channel:<surface>:<account>:42`.

## Replies out: `POST <apiUrl>/chats/<chat id>/messages`

`Authorization: Bearer <apiToken>`, body `{ "text": "Markdown", "thread_id": "500", "idempotency_key": "run:<id>" }`
(`thread_id` only for thread replies). Respond 2xx with `{ "id": "<message id>" }`. The same
`idempotency_key` may arrive more than once after a retry; create one message per key.

Turn replies, failure notices, approval requests and background work addressed to the
conversation (crons, webhooks) all arrive through this endpoint. A 4xx response other than 408
or 429 is final; QM retries 5xx responses and network errors for up to six hours.

QM keeps a copy of each DM message and each reply in its surface message store, keyed by
surface, account and chat, so later context reads see the conversation. `sent_at` (Unix
milliseconds) orders the stored copy; when it is absent QM uses the time it received the event.

Attachments in an event are passed to the model as `[attachment: <name> <url>]` lines; QM does
not fetch them. Files QM sends back arrive as the same kind of line in `text`.

An approval request reads `Approval needed: <summary>` followed by a link to the conversation
in the QM web app, where the approval is granted or denied.
