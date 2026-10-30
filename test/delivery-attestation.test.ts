import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { generateMcpAttestationKeyPair, mintMcpAttestation, verifyMcpAttestation } from "../src/mcp/mcp-attestation.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";

const SECRET = "delivery-attestation-source-secret".repeat(2);
const CONNECTOR_TOKEN = "finny-connector-delivery-token".repeat(2);
const RENDERED_BODY_SHA256 = "a".repeat(64);
const FILE_SHA256 = "b".repeat(64);
const KEYS = generateMcpAttestationKeyPair();
const DELIVERY_TEXT = "sensitive finance result";
const OUTPUT_SHA256 = createHash("sha256").update(DELIVERY_TEXT).digest("hex");
const CONTEXT_SHA256 = createHash("sha256").update("x-qm-context-token").digest("hex");
const OUTPUT_RECEIPT = await mintMcpAttestation(
  {
    kind: "qm.mcp-output-receipt",
    version: 1,
    serverId: "finny",
    callId: "call-finance",
    contextSha256: CONTEXT_SHA256,
    outputSha256: OUTPUT_SHA256,
    issuedAt: 150,
    nonce: "receipt-1",
  },
  KEYS.attestationPrivateKey,
  "output-receipt",
);
const OUTPUT_RECEIPT_SHA256 = createHash("sha256").update(OUTPUT_RECEIPT).digest("hex");
const ATTESTED_SERVER = {
  id: "finny",
  name: "Finny",
  url: "https://finny.example/mcp",
  auth: "bearer" as const,
  credentialScope: "shared" as const,
  bearerToken: CONNECTOR_TOKEN,
  catalog: true,
  attestActor: true,
  attestContext: true,
  ...KEYS,
  readOnly: false,
  enabled: true,
  updatedAt: 1,
  updatedBy: "admin",
};

async function withServer(
  delivery: Record<string, unknown> | Record<string, unknown>[],
  run: (base: string) => Promise<void>,
  servers: Record<string, Record<string, unknown>> = { finny: ATTESTED_SERVER },
): Promise<void> {
  const deliveries = Array.isArray(delivery) ? delivery : [delivery];
  const app = {
    getDelivery: async (id: string) => deliveries.find((candidate) => candidate.id === id) ?? null,
    listDeliveriesByMcpCall: async (serverId: string, callId: string, contextSha256: string) =>
      deliveries.filter((candidate) =>
        (
          candidate.provenance as
            { mcpEvidenceRefs?: Array<{ serverId: string; callId: string; contextSha256?: string }> } | undefined
        )?.mcpEvidenceRefs?.some(
          (ref) => ref.serverId === serverId && ref.callId === callId && ref.contextSha256 === contextSha256,
        ),
      ),
  } as unknown as App;
  const server = createServer(app, {
    signingSecret: SECRET,
    mcpServers: { get: async (id: string) => servers[id] ?? null } as never,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function readAttestation(
  base: string,
  id = "delivery-1",
  serverId: string | null = "finny",
  token: string | null = CONNECTOR_TOKEN,
): Promise<Response> {
  const path = `/v1/deliveries/${id}/attestation${serverId === null ? "" : `?serverId=${serverId}`}`;
  return fetch(`${base}${path}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
}

async function readAttestationByCall(
  base: string,
  callId: string,
  contextSha256 = CONTEXT_SHA256,
  serverId = "finny",
  token = CONNECTOR_TOKEN,
): Promise<Response> {
  return fetch(
    `${base}/v1/deliveries/attestation?serverId=${serverId}&callId=${callId}&contextSha256=${contextSha256}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
}

test("delivery acknowledgement rejects incomplete Slack evidence before persisting it", async () => {
  let acknowledgements = 0;
  const app = {
    recordPrincipalDelivery: async () => {},
    ackDelivery: async () => {
      acknowledgements++;
    },
  } as unknown as App;
  const server = createServer(app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = "/v1/deliveries/delivery-1/ack";
  const raw = JSON.stringify({
    providerReceipt: {
      provider: "slack",
      action: "post",
      channelId: "C-private",
      messageTs: "171.002",
    },
  });
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signedRequestHeaders(SECRET, "POST", path, raw) },
      body: raw,
    });
    assert.equal(response.status, 400);
    assert.equal(acknowledgements, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("delivery attestation signs persisted Slack evidence without message content or raw destination", async () => {
  const attachments = [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }];
  await withServer(
    {
      id: "delivery-1",
      idempotencyKey: "run:finance-report",
      destination: { type: "slack", target: "C-private:171.001" },
      text: DELIVERY_TEXT,
      attachments,
      createdAt: 100,
      deliveredAt: 200,
      provenance: {
        mcpEvidenceRefs: [
          {
            serverId: "finny",
            callId: "call-finance",
            outputReceipt: OUTPUT_RECEIPT,
            outputReceiptSha256: OUTPUT_RECEIPT_SHA256,
            outputSha256: OUTPUT_SHA256,
            contextSha256: CONTEXT_SHA256,
          },
          { serverId: "other", callId: "call-other", outputReceiptSha256: "d".repeat(64) },
        ],
      },
      providerReceipt: {
        provider: "slack",
        action: "post",
        channelId: "C-private",
        messageTs: "171.002",
        threadTs: "171.001",
        renderedBodySha256: RENDERED_BODY_SHA256,
        files: [{ id: "F1", sha256: FILE_SHA256 }],
      },
    },
    async (base) => {
      const response = await readAttestation(base);
      const raw = await response.text();
      assert.equal(response.status, 200, raw);
      const { attestation, outputReceipts } = JSON.parse(raw) as { attestation: string; outputReceipts: string[] };
      assert.deepEqual(outputReceipts, [OUTPUT_RECEIPT]);
      const claims = (await verifyMcpAttestation(attestation, KEYS.attestationPublicKey, "delivery-receipt")) as Record<
        string,
        unknown
      >;
      assert.equal(claims.kind, "qm.slack-delivery-attestation");
      assert.equal(claims.version, 1);
      assert.equal(claims.deliveryId, "delivery-1");
      assert.equal(claims.idempotencyKey, "run:finance-report");
      assert.equal(claims.destinationType, "slack");
      assert.equal(claims.acknowledgedAt, 200);
      assert.equal(claims.audienceServerId, "finny");
      assert.equal(claims.attestationKeyId, KEYS.attestationKeyId);
      assert.deepEqual(claims.mcpEvidenceRefs, [
        {
          serverId: "finny",
          callId: "call-finance",
          outputReceiptSha256: OUTPUT_RECEIPT_SHA256,
          outputSha256: OUTPUT_SHA256,
          contextSha256: CONTEXT_SHA256,
        },
      ]);
      assert.deepEqual(claims.providerReceipt, {
        provider: "slack",
        action: "post",
        channelId: "C-private",
        messageTs: "171.002",
        threadTs: "171.001",
        renderedBodySha256: RENDERED_BODY_SHA256,
        files: [{ id: "F1", sha256: FILE_SHA256 }],
      });
      assert.equal(claims.attachmentMetadataSha256, "f921f2d60dff6e8ff8f752e610beeb667480599e662fad93a0b717b4257dc5d0");
      assert.equal(claims.requestedBodySha256, "db128330d68d9843db2fc16205270eb59a81970c5d2808eb8a1cf1d51ddc187d");
      assert.equal("bodySha256" in claims, false);
      assert.equal("text" in claims, false);
      assert.equal("destination" in claims, false);
      assert.equal(JSON.stringify(claims).includes(OUTPUT_RECEIPT), false);
      assert.equal(JSON.stringify(claims).includes("sensitive finance result"), false);
      assert.equal(JSON.stringify(claims).includes("C-private:171.001"), false);
      assert.equal(await verifyMcpAttestation(attestation, KEYS.attestationPublicKey, "call-context"), null);
      const byCallResponse = await readAttestationByCall(base, "call-finance");
      assert.equal(byCallResponse.status, 200);
      const byCall = (await byCallResponse.json()) as { attestation: string; outputReceipts: string[] };
      assert.deepEqual(byCall.outputReceipts, [OUTPUT_RECEIPT]);
      assert.ok(await verifyMcpAttestation(byCall.attestation, KEYS.attestationPublicKey, "delivery-receipt"));
      assert.equal((await readAttestationByCall(base, "unknown-call")).status, 404);
      const missingContext = await fetch(`${base}/v1/deliveries/attestation?serverId=finny&callId=call-finance`, {
        headers: { authorization: `Bearer ${CONNECTOR_TOKEN}` },
      });
      assert.equal(missingContext.status, 404);
    },
  );
});

test("delivery attestation rejects incomplete, tampered, and causally mismatched MCP evidence", async () => {
  const signedMismatch = await mintMcpAttestation(
    {
      kind: "qm.mcp-output-receipt",
      version: 1,
      serverId: "finny",
      callId: "different-call",
      outputSha256: OUTPUT_SHA256,
      contextSha256: CONTEXT_SHA256,
      issuedAt: 150,
      nonce: "receipt-mismatch",
    },
    KEYS.attestationPrivateKey,
    "output-receipt",
  );
  const tokenParts = OUTPUT_RECEIPT.split(".");
  tokenParts[2] = `${tokenParts[2]!.startsWith("a") ? "b" : "a"}${tokenParts[2]!.slice(1)}`;
  const tampered = tokenParts.join(".");
  const unknownKeys = generateMcpAttestationKeyPair();
  const unknownKeyReceipt = await mintMcpAttestation(
    {
      kind: "qm.mcp-output-receipt",
      version: 1,
      serverId: "finny",
      callId: "call-finance",
      outputSha256: OUTPUT_SHA256,
      contextSha256: CONTEXT_SHA256,
      issuedAt: 150,
      nonce: "unknown-key",
    },
    unknownKeys.attestationPrivateKey,
    "output-receipt",
  );
  const wrongVersionReceipt = await mintMcpAttestation(
    {
      kind: "qm.mcp-output-receipt",
      version: 2,
      serverId: "finny",
      callId: "call-finance",
      outputSha256: OUTPUT_SHA256,
      contextSha256: CONTEXT_SHA256,
      issuedAt: 150,
      nonce: "wrong-version",
    },
    KEYS.attestationPrivateKey,
    "output-receipt",
  );
  const refs = [
    { serverId: "finny", callId: "call-finance", outputReceiptSha256: OUTPUT_RECEIPT_SHA256 },
    {
      serverId: "finny",
      callId: "call-finance",
      outputReceipt: OUTPUT_RECEIPT,
      outputReceiptSha256: "f".repeat(64),
      outputSha256: OUTPUT_SHA256,
      contextSha256: CONTEXT_SHA256,
    },
    {
      serverId: "finny",
      callId: "call-finance",
      outputReceipt: OUTPUT_RECEIPT,
      outputReceiptSha256: OUTPUT_RECEIPT_SHA256,
      outputSha256: "e".repeat(64),
      contextSha256: CONTEXT_SHA256,
    },
    {
      serverId: "finny",
      callId: "call-finance",
      outputReceipt: OUTPUT_RECEIPT,
      outputReceiptSha256: OUTPUT_RECEIPT_SHA256,
      outputSha256: OUTPUT_SHA256,
      contextSha256: "e".repeat(64),
    },
    {
      serverId: "finny",
      callId: "call-finance",
      outputReceipt: tampered,
      outputReceiptSha256: createHash("sha256").update(tampered).digest("hex"),
      outputSha256: OUTPUT_SHA256,
      contextSha256: CONTEXT_SHA256,
    },
    {
      serverId: "finny",
      callId: "call-finance",
      outputReceipt: signedMismatch,
      outputReceiptSha256: createHash("sha256").update(signedMismatch).digest("hex"),
      outputSha256: OUTPUT_SHA256,
      contextSha256: CONTEXT_SHA256,
    },
    {
      serverId: "finny",
      callId: "call-finance",
      outputReceipt: unknownKeyReceipt,
      outputReceiptSha256: createHash("sha256").update(unknownKeyReceipt).digest("hex"),
      outputSha256: OUTPUT_SHA256,
      contextSha256: CONTEXT_SHA256,
    },
    {
      serverId: "finny",
      callId: "call-finance",
      outputReceipt: wrongVersionReceipt,
      outputReceiptSha256: createHash("sha256").update(wrongVersionReceipt).digest("hex"),
      outputSha256: OUTPUT_SHA256,
      contextSha256: CONTEXT_SHA256,
    },
  ];
  const validRef = {
    serverId: "finny",
    callId: "call-finance",
    outputReceipt: OUTPUT_RECEIPT,
    outputReceiptSha256: OUTPUT_RECEIPT_SHA256,
    outputSha256: OUTPUT_SHA256,
    contextSha256: CONTEXT_SHA256,
  };
  for (const evidenceRefs of [...refs.map((ref) => [ref]), [validRef, refs[0]!]]) {
    await withServer(
      {
        id: "delivery-1",
        idempotencyKey: "run:finance-report",
        destination: { type: "slack", target: "C-private" },
        text: DELIVERY_TEXT,
        createdAt: 100,
        deliveredAt: 200,
        provenance: { mcpEvidenceRefs: evidenceRefs },
        providerReceipt: {
          provider: "slack",
          action: "post",
          channelId: "C-private",
          messageTs: "171.002",
          renderedBodySha256: RENDERED_BODY_SHA256,
        },
      },
      async (base) => {
        const response = await readAttestation(base);
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: "delivery_evidence_incomplete" });
      },
    );
  }
});

test("delivery attestation verifies output receipts with a retained public key", async () => {
  const retired = generateMcpAttestationKeyPair();
  const receipt = await mintMcpAttestation(
    {
      kind: "qm.mcp-output-receipt",
      version: 1,
      serverId: "finny",
      callId: "call-retired",
      contextSha256: CONTEXT_SHA256,
      outputSha256: OUTPUT_SHA256,
      issuedAt: 150,
      nonce: "retired-key",
    },
    retired.attestationPrivateKey,
    "output-receipt",
  );
  await withServer(
    {
      id: "delivery-1",
      idempotencyKey: "run:finance-report",
      destination: { type: "slack", target: "C-private" },
      text: DELIVERY_TEXT,
      createdAt: 100,
      deliveredAt: 200,
      provenance: {
        mcpEvidenceRefs: [
          {
            serverId: "finny",
            callId: "call-retired",
            outputReceipt: receipt,
            outputReceiptSha256: createHash("sha256").update(receipt).digest("hex"),
            outputSha256: OUTPUT_SHA256,
            contextSha256: CONTEXT_SHA256,
          },
        ],
      },
      providerReceipt: {
        provider: "slack",
        action: "post",
        channelId: "C-private",
        messageTs: "171.002",
        renderedBodySha256: RENDERED_BODY_SHA256,
      },
    },
    async (base) => {
      const response = await readAttestationByCall(base, "call-retired");
      assert.equal(response.status, 200);
      assert.deepEqual(((await response.json()) as { outputReceipts: string[] }).outputReceipts, [receipt]);
    },
    {
      finny: {
        ...ATTESTED_SERVER,
        retiredAttestationKeys: [
          { publicKey: retired.attestationPublicKey, keyId: retired.attestationKeyId, retiredAt: 125 },
        ],
      },
    },
  );
});

test("call lookup disambiguates fully valid deliveries by context digest", async () => {
  const otherContextSha256 = createHash("sha256").update("other-x-qm-context-token").digest("hex");
  const otherReceipt = await mintMcpAttestation(
    {
      kind: "qm.mcp-output-receipt",
      version: 1,
      serverId: "finny",
      callId: "call-finance",
      contextSha256: otherContextSha256,
      outputSha256: OUTPUT_SHA256,
      issuedAt: 151,
      nonce: "other-context",
    },
    KEYS.attestationPrivateKey,
    "output-receipt",
  );
  const valid = {
    id: "delivery-context-a",
    idempotencyKey: "run:context-a",
    destination: { type: "slack", target: "C-private" },
    text: DELIVERY_TEXT,
    createdAt: 100,
    deliveredAt: 200,
    provenance: {
      mcpEvidenceRefs: [
        {
          serverId: "finny",
          callId: "call-finance",
          outputReceipt: OUTPUT_RECEIPT,
          outputReceiptSha256: OUTPUT_RECEIPT_SHA256,
          outputSha256: OUTPUT_SHA256,
          contextSha256: CONTEXT_SHA256,
        },
      ],
    },
    providerReceipt: {
      provider: "slack",
      action: "post",
      channelId: "C-private",
      messageTs: "171.002",
      renderedBodySha256: RENDERED_BODY_SHA256,
    },
  };
  const other = {
    ...valid,
    id: "delivery-context-b",
    idempotencyKey: "run:context-b",
    createdAt: 300,
    provenance: {
      mcpEvidenceRefs: [
        {
          serverId: "finny",
          callId: "call-finance",
          outputReceipt: otherReceipt,
          outputReceiptSha256: createHash("sha256").update(otherReceipt).digest("hex"),
          outputSha256: OUTPUT_SHA256,
          contextSha256: otherContextSha256,
        },
      ],
    },
  };
  await withServer([other, valid], async (base) => {
    const response = await readAttestationByCall(base, "call-finance");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { attestation: string; outputReceipts: string[] };
    assert.deepEqual(body.outputReceipts, [OUTPUT_RECEIPT]);
    const claims = (await verifyMcpAttestation(
      body.attestation,
      KEYS.attestationPublicKey,
      "delivery-receipt",
    )) as Record<string, unknown>;
    assert.equal(claims.deliveryId, "delivery-context-a");
    const otherResponse = await readAttestationByCall(base, "call-finance", otherContextSha256);
    assert.equal(otherResponse.status, 200);
    const otherBody = (await otherResponse.json()) as { attestation: string; outputReceipts: string[] };
    assert.deepEqual(otherBody.outputReceipts, [otherReceipt]);
    const otherClaims = (await verifyMcpAttestation(
      otherBody.attestation,
      KEYS.attestationPublicKey,
      "delivery-receipt",
    )) as Record<string, unknown>;
    assert.equal(otherClaims.deliveryId, "delivery-context-b");
  });
});

test("delivery attestation requires a registered context-attesting audience", async () => {
  const delivery = {
    id: "delivery-1",
    idempotencyKey: "run:finance-report",
    destination: { type: "slack", target: "C-private" },
    text: "result",
    createdAt: 100,
    deliveredAt: 200,
    provenance: {
      mcpEvidenceRefs: [{ serverId: "finny", callId: "call-finance", outputReceiptSha256: OUTPUT_RECEIPT_SHA256 }],
    },
    providerReceipt: {
      provider: "slack",
      action: "post",
      channelId: "C-private",
      messageTs: "171.002",
      renderedBodySha256: RENDERED_BODY_SHA256,
    },
  };
  await withServer(
    delivery,
    async (base) => {
      for (const response of [
        await readAttestation(base, "delivery-1", null),
        await readAttestation(base, "delivery-1", "missing"),
        await readAttestation(base, "delivery-1", "weak"),
        await readAttestation(base, "delivery-1", "disabled"),
        await readAttestation(base, "delivery-1", "no-keypair"),
        await readAttestation(base, "delivery-1", "finny", null),
        await readAttestation(base, "delivery-1", "finny", "wrong-token"),
        await readAttestation(base, "delivery-1", "other", CONNECTOR_TOKEN),
        await readAttestation(base, "delivery-1", "client-credentials"),
        await readAttestation(base, "delivery-1", "per-user"),
      ]) {
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "unauthorized" });
      }
      const unrelated = await readAttestation(base, "delivery-1", "other", "other-connector-token".repeat(2));
      assert.equal(unrelated.status, 409);
      assert.deepEqual(await unrelated.json(), { error: "delivery_evidence_incomplete" });
      const path = "/v1/deliveries/delivery-1/attestation?serverId=finny";
      assert.equal(
        (
          await fetch(`${base}${path}`, {
            headers: signedRequestHeaders(SECRET, "GET", path, ""),
          })
        ).status,
        401,
      );
    },
    {
      finny: ATTESTED_SERVER,
      weak: { ...ATTESTED_SERVER, id: "weak", attestContext: false },
      disabled: { ...ATTESTED_SERVER, id: "disabled", enabled: false },
      "no-keypair": { ...ATTESTED_SERVER, id: "no-keypair", attestationPrivateKey: undefined },
      other: { ...ATTESTED_SERVER, id: "other", bearerToken: "other-connector-token".repeat(2) },
      "client-credentials": {
        ...ATTESTED_SERVER,
        id: "client-credentials",
        auth: "client-credentials",
        bearerToken: undefined,
      },
      "per-user": { ...ATTESTED_SERVER, id: "per-user", credentialScope: "per-user" },
    },
  );
});

test("delivery attestation fails closed without a durable acknowledgement and Slack provider evidence", async () => {
  const base = {
    id: "delivery-1",
    idempotencyKey: "run:finance-report",
    destination: { type: "slack", target: "C-private" },
    text: "result",
    createdAt: 100,
    provenance: {
      mcpEvidenceRefs: [{ serverId: "finny", callId: "call-finance", outputReceiptSha256: OUTPUT_RECEIPT_SHA256 }],
    },
  };
  for (const delivery of [
    { ...base, deliveredAt: null },
    { ...base, deliveredAt: 200 },
    {
      ...base,
      deliveredAt: 200,
      providerReceipt: { provider: "slack", action: "post", channelId: "C-private" },
    },
    {
      ...base,
      provenance: undefined,
      deliveredAt: 200,
      providerReceipt: {
        provider: "slack",
        action: "post",
        channelId: "C-private",
        messageTs: "171.002",
        renderedBodySha256: RENDERED_BODY_SHA256,
      },
    },
    {
      ...base,
      destination: { type: "web", target: "web:private" },
      deliveredAt: 200,
      providerReceipt: {
        provider: "slack",
        action: "post",
        channelId: "C-private",
        messageTs: "171.002",
        renderedBodySha256: RENDERED_BODY_SHA256,
      },
    },
    {
      ...base,
      destination: { type: "principal", target: "U-private" },
      deliveredAt: 200,
      providerReceipt: {
        provider: "slack",
        action: "post",
        channelId: "C-private",
        messageTs: "171.002",
        renderedBodySha256: RENDERED_BODY_SHA256,
      },
    },
  ]) {
    await withServer(delivery, async (url) => {
      const response = await readAttestation(url);
      assert.equal(response.status, 409);
      assert.equal(((await response.json()) as { error: string }).error, "delivery_evidence_incomplete");
    });
  }
});
