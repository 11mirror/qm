# Slack delivery attestations

Slack delivery acknowledgements may include durable provider evidence:

```json
{
  "slackApiMs": 41,
  "providerReceipt": {
    "provider": "slack",
    "action": "post",
    "channelId": "C123",
    "messageTs": "1710000000.123456",
    "threadTs": "1710000000.000001",
    "slackAccountId": "primary",
    "slackTeamId": "T123",
    "renderedBodySha256": "...",
    "files": [{ "id": "F123", "sha256": "..." }]
  }
}
```

Core stores the evidence and acknowledgement in one guarded delivery-row transition. Strong version 1 evidence is limited to Slack or group `post`, `update`, and `attachments` actions with a provider `messageTs`. The channel, thread, edit reference, Slack account, and Slack team must match the persisted destination. Deliveries with attachments require one unique Slack file ID and exact-byte SHA-256 digest for every intended attachment, and every file's share must be confirmed in the exact requested channel and thread. A root-channel delivery rejects a share committed in any thread. Invalid or incomplete evidence rejects the acknowledgement without marking the delivery complete.

Only the in-process Slack core path may submit provider evidence. The HTTP acknowledgement endpoint rejects `providerReceipt`; HTTP clients can create only legacy weak acknowledgements. A recovered unsplit Slack or group post can reconstruct strong evidence from its idempotency marker and complete provider file IDs in the posted thread only after downloading each Slack-hosted file and proving its digest matches the intended durable bytes. A marker with no files uploads the fully missing set once; partial, ambiguous, or byte-mismatched recovered sets remain unacknowledged. Reactions, pins, deletes, principal deliveries, split posts, failed or partial attachment uploads, unconfirmed file shares, and recovered uploads whose complete provider IDs are unavailable remain weak and cannot produce a strong attestation. Provider evidence cannot be added after a weak acknowledgement.

The selected connector reads a signed attestation with:

```text
GET /v1/deliveries/:id/attestation?serverId=finny
Authorization: Bearer <the selected MCP server's shared bearer token>
```

When the connector knows the attested MCP call ID but not QM's delivery UUID, it
computes the SHA-256 of the exact `x-qm-context` token it received and uses the same
authentication to look up the delivery:

```text
GET /v1/deliveries/attestation?serverId=finny&callId=<x-qm-context callId>&contextSha256=<SHA-256 of the exact x-qm-context token>
Authorization: Bearer <the selected MCP server's shared bearer token>
```

This route is public at the HTTP framework layer and does not accept or require QM core source authentication. The handler binds the caller to `serverId` by comparing a fixed-length digest of `Authorization` with the selected server's configured shared bearer token. The requested MCP server must be registered, enabled, configured with shared bearer authentication, context-attested, and have a complete QM-owned Ed25519 attestation keypair. Per-user bearer and client-credentials servers cannot read delivery attestations in version 1. Missing, unknown, ineligible, and incorrectly authenticated connector identities all return the same `401` response.

The response is `{ "attestation": "<compact JWS>", "outputReceipts": ["<compact JWS>"] }`. QM signs the `delivery-receipt` domain with the selected server's private key; Finny verifies with the registered public key. Each returned output receipt is exact persisted evidence, not a reconstructed token, and Finny verifies it with the active or a retained QM public key. After connector authentication, the delivery must contain durable MCP output evidence for that same server. A valid connector asking about an unrelated delivery receives `409 delivery_evidence_incomplete` and no signature. The lookup matches `serverId`, `callId`, and `contextSha256` exactly, so reused call IDs cannot select evidence from a different signed context. Missing delivery rows or an incomplete lookup tuple return `404`; pending deliveries and acknowledgements without complete provider or causal MCP evidence also return `409 delivery_evidence_incomplete`.

Version 1 claims contain:

```json
{
  "kind": "qm.slack-delivery-attestation",
  "version": 1,
  "deliveryId": "...",
  "idempotencyKey": "...",
  "destinationType": "slack",
  "mcpEvidenceRefs": [
    {
      "serverId": "finny",
      "callId": "...",
      "contextSha256": "...",
      "outputReceiptSha256": "...",
      "outputSha256": "..."
    }
  ],
  "providerReceipt": {
    "provider": "slack",
    "action": "post",
    "channelId": "C123",
    "messageTs": "1710000000.123456",
    "threadTs": "1710000000.000001",
    "slackAccountId": "primary",
    "slackTeamId": "T123",
    "renderedBodySha256": "...",
    "files": [{ "id": "F123", "sha256": "..." }]
  },
  "attachmentMetadataSha256": "...",
  "requestedBodySha256": "...",
  "acknowledgedAt": 1710000000123,
  "issuedAt": 1710000000456,
  "audienceServerId": "finny",
  "attestationKeyId": "..."
}
```

The attestation excludes message text, raw destination targets, attachment contents, attachment metadata, and full output-receipt tokens. `requestedBodySha256` binds the persisted requested text and attachment descriptors. `providerReceipt.renderedBodySha256` separately binds the exact transformed Slack request: chat request fields for posts and updates, or a compact upload manifest containing request fields, filenames, and byte digests for attachments. `attachmentMetadataSha256` binds the persisted attachment descriptor array. Every audience-matching evidence reference must carry a full output receipt whose exact SHA-256 equals `outputReceiptSha256`; its `outputSha256` must equal the SHA-256 of the persisted delivery text. Before signing, QM also verifies the receipt signature with the audience server's active or retained public keys and requires its server ID, call ID, context digest, and output digest to match the reference. The delivery JWS includes only those identifiers and digests. Legacy, incomplete, malformed, tampered, unknown-key, and causally mismatched references fail closed. The audience and key ID prevent a receipt minted for one registered connector from being presented as another connector's proof. MCP call-context, output-receipt, and delivery-receipt attestations use distinct signature domains.

Postgres migration `delivery/store/0007` adds nullable `deliveries.provider_receipt JSONB`, and the single-statement `delivery/store/0009` migration builds its MCP evidence GIN index with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` for authenticated three-part lookup without blocking writes. Existing rows remain readable and existing acknowledgement clients remain valid, but rows without provider evidence cannot produce a strong Slack delivery attestation.
