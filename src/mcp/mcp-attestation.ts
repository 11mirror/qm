import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { CompactSign, compactVerify, decodeProtectedHeader, importPKCS8, importSPKI } from "jose";

export type McpAttestationType = "call-context" | "output-receipt" | "delivery-receipt";

export interface McpAttestationKeyPair {
  attestationPrivateKey: string;
  attestationPublicKey: string;
  attestationKeyId: string;
}

export type McpAttestationVerification =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: "malformed-token" | "invalid-public-key" | "protected-header" | "invalid-signature" | "invalid-payload";
    };

const TYPES: Record<McpAttestationType, { typ: string; kind: string }> = {
  "call-context": { typ: "qm-mcp-call-context+jws", kind: "qm.mcp-call-context" },
  "output-receipt": { typ: "qm-mcp-output-receipt+jws", kind: "qm.mcp-output-receipt" },
  "delivery-receipt": { typ: "qm-slack-delivery-attestation+jws", kind: "qm.slack-delivery-attestation" },
};

function keyId(publicKey: ReturnType<typeof createPublicKey>): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64url").slice(0, 16);
}

function ed25519PrivateKey(value: string) {
  const privateKey = createPrivateKey(value);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("MCP attestation key must be Ed25519");
  return privateKey;
}

function ed25519PublicKey(value: string) {
  const publicKey = createPublicKey(value);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("MCP attestation key must be Ed25519");
  return publicKey;
}

export function generateMcpAttestationKeyPair(): McpAttestationKeyPair {
  const generated = generateKeyPairSync("ed25519");
  return {
    attestationPrivateKey: generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    attestationPublicKey: generated.publicKey.export({ type: "spki", format: "pem" }).toString(),
    attestationKeyId: keyId(generated.publicKey),
  };
}

export async function mintMcpAttestation(
  value: unknown,
  privateKeyPem: string,
  type: McpAttestationType,
): Promise<string> {
  const expected = TYPES[type];
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== expected.kind) {
    throw new Error(`MCP ${type} attestation has the wrong kind`);
  }
  const privateKey = ed25519PrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const signingKey = await importPKCS8(privateKeyPem, "EdDSA");
  return new CompactSign(Buffer.from(JSON.stringify(value)))
    .setProtectedHeader({ alg: "EdDSA", kid: keyId(publicKey), typ: expected.typ })
    .sign(signingKey);
}

export async function verifyMcpAttestation(
  token: string,
  publicKeyPem: string,
  type: McpAttestationType,
): Promise<unknown | null> {
  const result = await inspectMcpAttestation(token, publicKeyPem, type);
  return result.ok ? result.value : null;
}

export async function inspectMcpAttestation(
  token: string,
  publicKeyPem: string,
  type: McpAttestationType,
): Promise<McpAttestationVerification> {
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = ed25519PublicKey(publicKeyPem);
  } catch {
    return { ok: false, error: "invalid-public-key" };
  }
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, error: "malformed-token" };
  }
  const expected = TYPES[type];
  if (header.alg !== "EdDSA" || header.typ !== expected.typ || header.kid !== keyId(publicKey)) {
    return { ok: false, error: "protected-header" };
  }
  let payload: Uint8Array;
  try {
    const verificationKey = await importSPKI(publicKeyPem, "EdDSA");
    payload = (await compactVerify(token, verificationKey, { algorithms: ["EdDSA"] })).payload;
  } catch {
    return { ok: false, error: "invalid-signature" };
  }
  try {
    const value = JSON.parse(Buffer.from(payload).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== expected.kind) {
      return { ok: false, error: "invalid-payload" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: "invalid-payload" };
  }
}
