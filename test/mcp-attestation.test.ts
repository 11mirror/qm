import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateMcpAttestationKeyPair,
  inspectMcpAttestation,
  mintMcpAttestation,
  verifyMcpAttestation,
} from "../src/mcp/mcp-attestation.ts";

test("delivery receipts use their own EdDSA attestation domain", async () => {
  const keys = generateMcpAttestationKeyPair();
  const delivery = {
    kind: "qm.slack-delivery-attestation",
    version: 1,
    deliveryId: "delivery-1",
    channelId: "C1",
    messageTs: "171.25",
  };
  const deliveryToken = await mintMcpAttestation(delivery, keys.attestationPrivateKey, "delivery-receipt");
  assert.deepEqual(await verifyMcpAttestation(deliveryToken, keys.attestationPublicKey, "delivery-receipt"), delivery);
  assert.equal(await verifyMcpAttestation(deliveryToken, keys.attestationPublicKey, "call-context"), null);
  assert.deepEqual(await inspectMcpAttestation(deliveryToken, keys.attestationPublicKey, "call-context"), {
    ok: false,
    error: "protected-header",
  });
  assert.equal(await verifyMcpAttestation(deliveryToken, keys.attestationPublicKey, "output-receipt"), null);

  const contextToken = await mintMcpAttestation(
    { kind: "qm.mcp-call-context", version: 1, callId: "call-1" },
    keys.attestationPrivateKey,
    "call-context",
  );
  assert.equal(await verifyMcpAttestation(contextToken, keys.attestationPublicKey, "delivery-receipt"), null);
});
