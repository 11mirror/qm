import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import {
  compileFinnyOperationPlan,
  decodeFinnyOperationPlan,
  encodeFinnyOperationPlan,
  type FinnyCompiledOperation,
} from "../src/finny/operation-compiler.ts";

const descriptor: FinnyCapabilityDescriptor = {
  schemaVersion: 1,
  capabilityId: "working_capital_velocity",
  revisionId: "working_capital_velocity.2026-10-30",
  semanticCapability: "working_capital_velocity",
  semanticAliases: ["inventory_velocity", "stock_efficiency"],
  dimensions: {
    required: ["entity", "period", "accounting_book"],
    supported: {
      currency: ["source_base", "reporting"],
      grain: ["total", "entity"],
      population: ["reviewed_inventory"],
      sources: ["netsuite"],
    },
    defaults: { sources: ["netsuite"] },
  },
  operations: [
    {
      id: "inventory_source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT SUM(amount) AS inventory_value FROM synthetic_inventory WHERE entity = :entity_id AND posted_at <= :period_end",
      parameters: ["entity_id", "period_end"],
    },
    {
      id: "repeat_inventory",
      primitive: "repeat_pull",
      dependsOn: ["inventory_source"],
      operationId: "inventory_source",
    },
    {
      id: "inventory_reconciliation",
      primitive: "reconcile",
      dependsOn: ["inventory_source", "repeat_inventory"],
      leftField: "inventory_value",
      rightField: "inventory_value",
      tolerance: "0",
    },
  ],
  resultOperationId: "inventory_source",
  parameterBindings: {
    entity_id: { source: "dimension", path: ["entity", "name"] },
    period_end: { source: "dimension", path: ["period", "date"] },
  },
  artifactPolicy: {
    allowedFormats: ["json", "csv"],
    defaultFormat: "csv",
    attachment: "when_requested",
  },
  approvalPolicy: {
    mode: "before_source",
    binds: ["capability_revision", "dimensions", "operation_graph"],
  },
  verificationPolicy: {
    requiredOperationIds: ["repeat_inventory", "inventory_reconciliation"],
    releaseGate: "delivery_eligible",
  },
};

const input = {
  descriptor,
  manifestDigest: `sha256:${"b".repeat(64)}` as const,
  catalogDigest: `sha256:${"a".repeat(64)}` as const,
  semanticCapability: "working_capital_velocity",
  dimensions: {
    accounting_book: "primary",
    currency: { kind: "source_base" },
    entity: { kind: "named", name: "synthetic_entity" },
    period: { kind: "as_of", date: "2026-10-19" },
    sources: [],
  },
};

test("the host compiles every reviewed operation into one immutable ordered plan", () => {
  const plan = compileFinnyOperationPlan(input);

  assert.equal(plan.schema, "finny.operation_plan.v1");
  assert.equal(plan.capabilityId, "working_capital_velocity");
  assert.equal(plan.revisionId, "working_capital_velocity.2026-10-30");
  assert.equal(plan.manifestDigest, input.manifestDigest);
  assert.equal(plan.catalogDigest, input.catalogDigest);
  assert.equal(plan.resultOperationId, "inventory_source");
  assert.match(plan.dimensionsDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    plan.operations.map((operation) => operation.id),
    ["inventory_source", "repeat_inventory", "inventory_reconciliation"],
  );
  assert.equal(plan.operations[0]?.primitive, "suiteql_select");
  assert.deepEqual(plan.operations.slice(1), descriptor.operations.slice(1));
  assert.deepEqual(plan.artifactPolicy, descriptor.artifactPolicy);
  assert.match(plan.artifactPolicyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(plan.approvalPolicy, descriptor.approvalPolicy);
  assert.match(plan.approvalPolicyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(plan.verificationPolicy, descriptor.verificationPolicy);
  assert.match(plan.verificationPolicyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(plan.operationGraphDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => Object.assign(plan.dimensions, { entity: "changed" }), TypeError);
  assert.throws(() => (plan.operations as FinnyCompiledOperation[]).reverse(), TypeError);
});

test("canonical plan custody hashes exact bytes and rejects tampering", () => {
  const plan = compileFinnyOperationPlan(input);
  const bytes = encodeFinnyOperationPlan(plan);

  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, plan.planDigest);
  assert.deepEqual(decodeFinnyOperationPlan(bytes, plan.planDigest), plan);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 2] = tampered[tampered.length - 2]! === 48 ? 49 : 48;
  assert.throws(() => decodeFinnyOperationPlan(tampered, plan.planDigest), /digest/i);
});

test("SuiteQL rendering escapes hostile strings and renders scalar types without raw SQL authority", () => {
  const typedDescriptor: FinnyCapabilityDescriptor = {
    ...descriptor,
    operations: descriptor.operations.map((operation) =>
      operation.primitive === "suiteql_select"
        ? {
            ...operation,
            sql: `${operation.sql} AND amount >= :minimum_amount AND active = :active AND parent IS :parent_id`,
            parameters: [...operation.parameters, "minimum_amount", "active", "parent_id"],
          }
        : operation,
    ),
    parameterBindings: {
      ...descriptor.parameterBindings,
      minimum_amount: { source: "literal", value: 10.5 },
      active: { source: "literal", value: true },
      parent_id: { source: "literal", value: null },
    },
  };
  const plan = compileFinnyOperationPlan({
    ...input,
    descriptor: typedDescriptor,
    dimensions: {
      ...input.dimensions,
      entity: { kind: "named", name: "synthetic' OR 1=1 --" },
      period: { kind: "as_of", date: "2026-10-19' OR posted_at IS NOT NULL --" },
    },
  });
  const source = plan.operations[0];

  assert.equal(source?.primitive, "suiteql_select");
  if (source?.primitive !== "suiteql_select") assert.fail("expected a SuiteQL operation");
  assert.equal(
    source.sql,
    "SELECT SUM(amount) AS inventory_value FROM synthetic_inventory WHERE entity = 'synthetic'' OR 1=1 --' AND posted_at <= '2026-10-19'' OR posted_at IS NOT NULL --' AND amount >= 10.5 AND active = TRUE AND parent IS NULL",
  );
  assert.deepEqual(source.parameters, ["entity_id", "period_end", "minimum_amount", "active", "parent_id"]);
});

test("dimension, parameter, and operation graph changes alter the bound digests", () => {
  const baseline = compileFinnyOperationPlan(input);
  const reordered = compileFinnyOperationPlan({
    ...input,
    dimensions: {
      period: { kind: "as_of", date: "2026-10-19" },
      entity: { name: "synthetic_entity", kind: "named" },
      currency: { kind: "source_base" },
      accounting_book: "primary",
      sources: [],
    },
  });
  const dimensionChange = compileFinnyOperationPlan({
    ...input,
    dimensions: { ...input.dimensions, currency: { kind: "reporting" } },
  });
  const graphChange = compileFinnyOperationPlan({
    ...input,
    descriptor: {
      ...descriptor,
      operations: descriptor.operations.map((operation) =>
        operation.primitive === "suiteql_select"
          ? { ...operation, sql: operation.sql.replace("amount", "base_amount") }
          : operation,
      ),
    },
  });
  const bindingChange = compileFinnyOperationPlan({
    ...input,
    descriptor: {
      ...descriptor,
      parameterBindings: {
        ...descriptor.parameterBindings,
        entity_id: { source: "literal", value: "synthetic_entity" },
      },
    },
  });

  assert.equal(reordered.planDigest, baseline.planDigest);
  assert.notEqual(dimensionChange.planDigest, baseline.planDigest);
  assert.equal(dimensionChange.operationGraphDigest, baseline.operationGraphDigest);
  assert.notEqual(graphChange.operationGraphDigest, baseline.operationGraphDigest);
  assert.notEqual(graphChange.planDigest, baseline.planDigest);
  assert.notEqual(bindingChange.operationGraphDigest, baseline.operationGraphDigest);
  assert.notEqual(bindingChange.planDigest, baseline.planDigest);
});

test("policy digests bind each reviewed policy independently", () => {
  const baseline = compileFinnyOperationPlan(input);
  const artifact = compileFinnyOperationPlan({
    ...input,
    descriptor: {
      ...descriptor,
      artifactPolicy: { ...descriptor.artifactPolicy, attachment: "always" },
    },
  });
  const approval = compileFinnyOperationPlan({
    ...input,
    descriptor: {
      ...descriptor,
      approvalPolicy: { mode: "none", binds: [] },
    },
  });
  const verification = compileFinnyOperationPlan({
    ...input,
    descriptor: {
      ...descriptor,
      verificationPolicy: { ...descriptor.verificationPolicy, requiredOperationIds: [] },
    },
  });

  assert.notEqual(artifact.artifactPolicyDigest, baseline.artifactPolicyDigest);
  assert.equal(artifact.approvalPolicyDigest, baseline.approvalPolicyDigest);
  assert.notEqual(approval.approvalPolicyDigest, baseline.approvalPolicyDigest);
  assert.equal(approval.verificationPolicyDigest, baseline.verificationPolicyDigest);
  assert.notEqual(verification.verificationPolicyDigest, baseline.verificationPolicyDigest);
  assert.equal(verification.artifactPolicyDigest, baseline.artifactPolicyDigest);
});

test("compilation fails closed on semantic, dimension, and parameter ambiguity", () => {
  const failures: Array<[string, Parameters<typeof compileFinnyOperationPlan>[0], RegExp]> = [
    ["semantic mismatch", { ...input, semanticCapability: "inventory_velocity" }, /semantic capability/i],
    [
      "missing dimension",
      {
        ...input,
        dimensions: {
          entity: { kind: "named", name: "synthetic_entity" },
          period: { kind: "as_of", date: "2026-10-19" },
        },
      },
      /accounting_book.*required/i,
    ],
    [
      "unsupported dimension",
      { ...input, dimensions: { ...input.dimensions, segment: "north" } },
      /dimension segment.*unsupported/i,
    ],
    [
      "unsupported dimension value",
      { ...input, dimensions: { ...input.dimensions, currency: { kind: "unreviewed" } } },
      /currency.*unreviewed.*unsupported/i,
    ],
    [
      "missing binding",
      {
        ...input,
        descriptor: {
          ...descriptor,
          parameterBindings: {
            period_end: descriptor.parameterBindings.period_end!,
          },
        },
      },
      /entity_id.*required/i,
    ],
    [
      "extra binding",
      {
        ...input,
        descriptor: {
          ...descriptor,
          parameterBindings: {
            ...descriptor.parameterBindings,
            sql: { source: "literal", value: "SELECT 1" },
          },
        },
      },
      /binding sql.*unexpected/i,
    ],
    [
      "non-finite number",
      {
        ...input,
        descriptor: {
          ...descriptor,
          parameterBindings: {
            ...descriptor.parameterBindings,
            entity_id: { source: "literal", value: Number.POSITIVE_INFINITY },
          },
        },
      },
      /finite/i,
    ],
    [
      "object terminal binding",
      {
        ...input,
        descriptor: {
          ...descriptor,
          parameterBindings: {
            ...descriptor.parameterBindings,
            entity_id: { source: "dimension", path: ["entity"] },
          },
        },
      },
      /entity_id.*scalar/i,
    ],
  ];

  for (const [name, candidate, expected] of failures)
    assert.throws(() => compileFinnyOperationPlan(candidate), expected, name);
});
