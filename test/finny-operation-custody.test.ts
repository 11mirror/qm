import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import type { FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import {
  decodeFinnyOperationResult,
  encodeFinnyOperationResult,
  loadFinnyOperationPlan,
  storeFinnyOperationPlan,
} from "../src/finny/operation-custody.ts";
import { compileFinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createMemoryDurableByteStore, type DurableByteStore } from "../src/files/durable-byte-store.ts";

const descriptor: FinnyCapabilityDescriptor = {
  schemaVersion: 1,
  capabilityId: "reviewed_balance",
  revisionId: "reviewed_balance.2026-10-30",
  semanticCapability: "reviewed_balance",
  semanticAliases: ["balance"],
  dimensions: {
    required: ["entity"],
    supported: { sources: ["netsuite"] },
    defaults: { sources: ["netsuite"] },
  },
  operations: [
    {
      id: "balance_source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT amount FROM balance WHERE entity = :entity_id",
      parameters: ["entity_id"],
    },
  ],
  resultOperationId: "balance_source",
  parameterBindings: {
    entity_id: { source: "dimension", path: ["entity", "name"] },
  },
  artifactPolicy: {
    allowedFormats: ["json"],
    defaultFormat: "json",
    attachment: "when_requested",
  },
  approvalPolicy: {
    mode: "before_source",
    binds: ["capability_revision", "dimensions", "operation_graph"],
  },
  verificationPolicy: {
    requiredOperationIds: [],
    releaseGate: "delivery_eligible",
  },
};

function plan() {
  return compileFinnyOperationPlan({
    descriptor,
    manifestDigest: `sha256:${"a".repeat(64)}`,
    catalogDigest: `sha256:${"b".repeat(64)}`,
    semanticCapability: "reviewed_balance",
    dimensions: {
      entity: { kind: "named", name: "synthetic_entity" },
      sources: ["netsuite"],
    },
  });
}

const dependencyResults = [
  {
    operationId: "source_rows",
    resultDigest: `sha256:${"c".repeat(64)}` as const,
  },
  {
    operationId: "filtered_rows",
    resultDigest: `sha256:${"d".repeat(64)}` as const,
  },
];

const resultInput = {
  runId: "run_123",
  planDigest: `sha256:${"a".repeat(64)}` as const,
  operationId: "balance_total",
  operationDigest: `sha256:${"b".repeat(64)}` as const,
  dependencyResults,
  output: [{ total: "1200.50", entity: "synthetic_entity" }],
};

test("plan custody persists and reloads only the canonical plan bound to its digest", async () => {
  const bytes = createMemoryDurableByteStore();
  const compiled = plan();

  const stored = await storeFinnyOperationPlan(bytes, compiled);

  assert.equal(stored.planDigest, compiled.planDigest);
  assert.equal(stored.blobKey, `files/${compiled.planDigest.slice("sha256:".length)}`);
  assert.deepEqual(await loadFinnyOperationPlan(bytes, stored), compiled);

  const opened = await bytes.open(stored.blobKey);
  assert.ok(opened);
  const corrupt: DurableByteStore = {
    ...bytes,
    async open(blobKey) {
      if (blobKey !== stored.blobKey) return bytes.open(blobKey);
      return { sizeBytes: opened.sizeBytes + 1, stream: Readable.from(Buffer.from("{}")) };
    },
  };
  await assert.rejects(() => loadFinnyOperationPlan(corrupt, stored), /size|digest/i);
});

test("operation result custody hashes canonical bytes and preserves ordered dependency bindings", () => {
  const encoded = encodeFinnyOperationResult(resultInput);
  const expectedBytes = Buffer.from(
    `{"dependencyResults":[{"operationId":"source_rows","resultDigest":"sha256:${"c".repeat(64)}"},{"operationId":"filtered_rows","resultDigest":"sha256:${"d".repeat(64)}"}],"operationDigest":"sha256:${"b".repeat(64)}","operationId":"balance_total","output":[{"entity":"synthetic_entity","total":"1200.50"}],"planDigest":"sha256:${"a".repeat(64)}","runId":"run_123","schema":"finny.operation_result.v1"}`,
  );

  assert.deepEqual(encoded.bytes, expectedBytes);
  assert.equal(encoded.resultDigest, `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`);
  assert.deepEqual(
    decodeFinnyOperationResult(encoded.bytes, {
      resultDigest: encoded.resultDigest,
      runId: resultInput.runId,
      planDigest: resultInput.planDigest,
      operationId: resultInput.operationId,
      operationDigest: resultInput.operationDigest,
      dependencyResults,
    }),
    { schema: "finny.operation_result.v1", ...resultInput },
  );
});

test("operation result custody rejects corruption, noncanonical bytes, and changed authority bindings", () => {
  const encoded = encodeFinnyOperationResult(resultInput);
  const expected = {
    resultDigest: encoded.resultDigest,
    runId: resultInput.runId,
    planDigest: resultInput.planDigest,
    operationId: resultInput.operationId,
    operationDigest: resultInput.operationDigest,
    dependencyResults,
  };
  const corrupt = Buffer.from(encoded.bytes);
  corrupt[corrupt.length - 2] = corrupt[corrupt.length - 2]! === 48 ? 49 : 48;
  assert.throws(() => decodeFinnyOperationResult(corrupt, expected), /digest/i);

  const noncanonical = Buffer.concat([Buffer.from(" "), encoded.bytes]);
  const noncanonicalDigest = `sha256:${createHash("sha256").update(noncanonical).digest("hex")}` as const;
  assert.throws(
    () => decodeFinnyOperationResult(noncanonical, { ...expected, resultDigest: noncanonicalDigest }),
    /encoding/i,
  );

  assert.throws(() => decodeFinnyOperationResult(encoded.bytes, { ...expected, runId: "run_456" }), /binding/i);
  assert.throws(
    () =>
      decodeFinnyOperationResult(encoded.bytes, {
        ...expected,
        dependencyResults: [...dependencyResults].reverse(),
      }),
    /binding/i,
  );
});

test("operation result custody rejects unsupported output values before persistence", () => {
  assert.throws(() => encodeFinnyOperationResult({ ...resultInput, output: [{ amount: Number.NaN }] }), /output/i);
  assert.throws(
    () =>
      encodeFinnyOperationResult({ ...resultInput, dependencyResults: [dependencyResults[0]!, dependencyResults[0]!] }),
    /dependency/i,
  );
});
