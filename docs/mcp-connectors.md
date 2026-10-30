# MCP connector credentials

Administrators register HTTP MCP servers through `PUT /v1/admin/mcp-servers/:id`
from an admin session (`/admin/api/mcp-servers/:id` behind the portal); agent tokens
are refused, so an agent cannot change which tools it may call or which calls need
approval. Registration controls the outbound destination and the tools available to agents.

`approval` decides which calls pause for a person's approval, bound to the exact
arguments and good for one call: `annotations` (the default; tools annotated
`destructiveHint: true` and not `readOnlyHint: true`), `all`, or `none`. An update
that omits `approval` keeps the current policy.

`credentialScope` selects the identity used for `tools/call`:

- `shared` (the default for existing and new registrations): all callers use the
  configured `auth`, `bearerToken`, or `clientId` and `clientSecret`.
- `per-user`: each call uses the initiating actor's bearer token from the encrypted
  connector keychain, under `credentialHost` in the selected `credentialAccountType`
  slot (`default`, `personal`, or `company`; defaults to `default`). The
  runtime supplies the actor; tool arguments cannot select another user.

For example:

```json
{
  "name": "Customer tools",
  "url": "https://tools.example.com/mcp",
  "auth": "none",
  "credentialScope": "per-user",
  "credentialHost": "accounts.example.com",
  "readOnly": false,
  "enabled": true
}
```

Per-user mode requires persistent keychain encryption (`CONNECTOR_SECRET_KEY`).
Connect the user's account using an existing QM OAuth connector, or have a trusted
integration save its token through the source-authenticated
`POST /v1/connectors/token` endpoint with `host`, `principalId`, `accessToken`, and
optional `expiresAt` (Unix milliseconds). Supported OAuth providers can also store
and refresh a `refreshToken`. This change does not add OAuth provider discovery or
an interactive MCP login flow. An unsupported provider must manage token renewal
in its integration; do not store a refresh token that QM cannot refresh.

Missing, expired, revoked, or unrefreshable user credentials fail the call with a
connection-required message. Per-user MCP calls do not use operator environment
tokens, organization credentials, another user's account, or the shared discovery
credential as fallback. Tokens are resolved again for every call rather than
cached across users. Triggered work uses its existing initiating actor identity.

Tool discovery (`tools/list`, including registration probes) remains connector-wide
and uses the configured `auth`. In per-user mode those credentials are only for
catalog discovery. The server must expose a common, non-sensitive catalog and
check each caller's permissions when executing a tool. A public catalog can use
`auth: "none"`; a private catalog can use a dedicated shared discovery credential.
Do not put user-specific data into names, descriptions, or schemas.

`credentialHost` explicitly authorizes sending that connector's user token to the
registered server. Only register a trusted service permitted to receive those
tokens. Per-user endpoints require HTTPS, except on loopback for local development.
HTTP redirects are rejected for every MCP authentication mode. Updating an endpoint
or credential host is an administrative trust decision. Tool call auditing records
the initiating actor as before; authentication does not expand the audience allowed
to receive the result.

## Signed call context and output receipts

A shared catalog connector can require host-attested calls by setting all of
`catalog`, `attestActor`, and `attestContext` to `true`, using `bearer` or
`client-credentials` authentication. QM generates a connector-specific Ed25519
keypair when the mode is enabled. The private key is stored in the durable MCP
server record and is never accepted from or returned by the admin API. Admin reads
expose the public verification key, its fingerprint in `attestationKeyId`, and
`hasAttestationPrivateKey`. Rotation is a two-phase admin operation. First, save
the registration with `prepareAttestationKey: true`. QM generates a pending keypair,
or reuses the existing pending pair, while the active key continues signing. Admin
responses and reads expose `pendingAttestationPublicKey`, `pendingAttestationKeyId`,
and `hasPendingAttestationPrivateKey`, but never either private key. Distribute the
pending public key to every verifier, then save with `activateAttestationKeyId` set
to the exact pending key ID. QM atomically promotes that pair and clears the pending
fields. Retired public keys remain visible in `retiredAttestationKeys` so durable
receipts minted before rotation remain verifiable; retired private keys are never
retained. A wrong or missing pending key ID is rejected. The old one-step
`rotateAttestationKey` and removed symmetric `attestationSecret` settings are
rejected.
An attested durable record without the generated key fields fails closed; save the
registration through the admin API once to generate them. No database migration is
needed because MCP registrations use the existing durable JSON map.

For each catalog `invoke`, QM sends `x-qm-context` as a compact EdDSA JWS on the
single JSON-RPC `tools/call` request. Session initialization, search, describe, tool
discovery, and session termination do not carry the header. The version 1 payload binds
the actor, scope, session, thread, surface, optional Slack account, team, and user
IDs, run and attempt, resolved harness and model, MCP server and remote tool,
canonical argument SHA-256, call ID, optional approval key, issue and expiry times,
and a nonce. The token lasts 60 seconds. Slack policy namespaces and reply timestamps
are deliberately excluded; the session and thread claims already bind the
conversation. A Slack call is rejected unless its source includes the three Slack
IDs. A call is also rejected when its actor differs from the initiating principal.

The connector must verify the JWS with the public key, require the
`qm-mcp-call-context+jws` protected type, and check expiry, exact server and tool,
canonical argument digest, and approval binding before executing. It must durably
reject a reused nonce or call ID for the token lifetime. Holding the public key
does not grant signing authority. Model text and tool arguments are not evidence
of identity or approval.

After an attested tool response, QM returns a typed host result containing `text`,
`outputReceipt`, `outputSha256`, and `contextSha256`, where `contextSha256` is the
SHA-256 of the exact `x-qm-context` token sent to the connector. Agent tools expose
only `text` to the model and durable replay; the compact receipt and both digests
are stored in the durable `tool_result` summary tied to the call ID. They therefore
add no model tokens and cannot be copied or rewritten as model-visible evidence.

The version 1 receipt uses the distinct `qm-mcp-output-receipt+jws` protected type
and binds the server, remote tool, canonical argument digest, call ID, call-context
token digest, output digest, issue time, and a new nonce. Output receipts do not
expire, so they remain durable audit evidence after the short-lived call-context
token expires. They contain neither the tool output nor connector credentials. A
receipt proves only that QM received those output bytes through the configured
authenticated MCP transport. It does not prove that the upstream finance system
created or approved the data; that requires an upstream signature or other
source-native evidence. Connectors that do not enable `attestContext` retain
byte-for-byte legacy outputs and receive no signed context header.
