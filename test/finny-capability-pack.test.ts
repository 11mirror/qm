import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadFinnyCapabilityPack } from "../src/finny/capability-pack.ts";
import { resolveFinnyIntent } from "../src/finny/intent-resolver.ts";
import { loadFinnyKnowledgeIndex } from "../src/finny/knowledge-index.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "../src/finny/reviewed-query.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function syntheticCapability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
      },
      defaults: {},
    },
    operations: [
      {
        id: "inventory_source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "WITH inventory AS (SELECT amount FROM synthetic_inventory WHERE entity = :entity_id AND posted_at <= :period_end) SELECT amount FROM inventory",
        parameters: ["entity_id", "period_end"],
      },
      {
        id: "inventory_total",
        primitive: "aggregate",
        dependsOn: ["inventory_source"],
        groupBy: [],
        metrics: [{ id: "inventory_value", operator: "sum", field: "amount" }],
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
        dependsOn: ["inventory_total", "repeat_inventory"],
        leftField: "inventory_value",
        rightField: "inventory_value",
        tolerance: "0",
      },
    ],
    resultOperationId: "inventory_total",
    parameterBindings: {
      entity_id: { source: "dimension", path: ["entity"] },
      period_end: { source: "dimension", path: ["period"] },
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
    ...overrides,
  };
}

async function writePack(
  t: test.TestContext,
  descriptors: Array<{ path: string; value: Record<string, unknown> }>,
  manifestOverrides: Record<string, unknown> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "finny-capabilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  for (const descriptor of descriptors) {
    const body = JSON.stringify(descriptor.value);
    await mkdir(join(root, descriptor.path, ".."), { recursive: true });
    await writeFile(join(root, descriptor.path), body);
    files.push({ path: descriptor.path, size: Buffer.byteLength(body), sha256: sha256(body) });
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      classification: "reviewed-finance-capability-pack",
      capabilities: descriptors.map((descriptor) => descriptor.path),
      files,
      ...manifestOverrides,
    }),
  );
  return root;
}

test("the reviewed capability sub-bundle coexists with knowledge and adds measures as data", async () => {
  const knowledge = await loadFinnyKnowledgeIndex(resolve("finny-skills"));
  const catalog = await loadFinnyCapabilityPack(resolve("finny-skills/capabilities"));
  const payable = catalog.capabilities.get("ap_gl_control_balance");
  const synthetic = catalog.capabilities.get("synthetic_inventory_velocity");

  assert.equal(knowledge.fileCount, 1);
  assert.equal(catalog.capabilities.size, 2);
  assert.equal(payable?.capabilityId, "ap_gl_control_balance");
  assert.equal(payable?.revisionId, "ap_gl_control_balance.2026-10-30");
  assert.deepEqual(payable?.dimensions.supported, {
    accounting_book: ["primary"],
    artifact: ["optional", "required"],
    currency: ["source_base"],
    entity: ["all"],
    grain: ["total"],
    period: ["current"],
    sources: ["netsuite"],
  });
  const payableSource = payable?.operations[0];
  assert.equal(payableSource?.primitive, "suiteql_select");
  if (payableSource?.primitive === "suiteql_select") {
    assert.equal(
      payableSource.sql.replace(":account_type", "'AcctPay'").replace(":accounting_book_id", "1"),
      FINNY_AP_GL_CONTROL_BALANCE_QUERY,
    );
  }
  assert.deepEqual(payable?.parameterBindings, {
    account_type: { source: "literal", value: "AcctPay" },
    accounting_book_id: { source: "literal", value: 1 },
  });
  assert.equal(catalog.aliases.get("accounts_payable"), "ap_gl_control_balance");
  assert.equal(synthetic?.capabilityId, "synthetic_inventory_velocity");
  assert.equal(synthetic?.operations[0]?.primitive, "suiteql_select");
  assert.deepEqual(synthetic?.parameterBindings.entity_name, {
    source: "dimension",
    path: ["entity", "name"],
  });
  assert.equal(catalog.aliases.get("stock_efficiency"), "synthetic_inventory_velocity");
  assert.notEqual(catalog.manifestDigest, knowledge.bundleDigest);
  const payableIntent = resolveFinnyIntent("How much do we owe suppliers?", catalog);
  assert.equal(payableIntent.status, "resolved");
  if (payableIntent.status === "resolved") assert.equal(payableIntent.capability, payable);
});

test("a reviewed pack adds a synthetic semantic measure without a TypeScript code path", async (t) => {
  const root = await writePack(t, [{ path: "capabilities/working-capital.json", value: syntheticCapability() }]);

  const catalog = await loadFinnyCapabilityPack(root);
  const capability = catalog.capabilities.get("working_capital_velocity");

  assert.equal(capability?.capabilityId, "working_capital_velocity");
  assert.equal(capability?.revisionId, "working_capital_velocity.2026-10-30");
  assert.equal(capability?.operations[0]?.primitive, "suiteql_select");
  assert.equal(catalog.aliases.get("inventory_velocity"), "working_capital_velocity");
  assert.match(catalog.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(catalog.catalogDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await loadFinnyCapabilityPack(root)).catalogDigest, catalog.catalogDigest);
});

test("capability loading rejects unreviewed, unknown, and model-authority fields", async (t) => {
  const cases = [
    {
      name: "unreviewed manifest",
      descriptor: syntheticCapability(),
      manifest: { classification: "draft-finance-capability-pack" },
    },
    {
      name: "unknown descriptor field",
      descriptor: syntheticCapability({ surprise: true }),
      manifest: {},
    },
    {
      name: "model authority",
      descriptor: syntheticCapability({ modelAuthority: "may_execute" }),
      manifest: {},
    },
    {
      name: "unknown primitive",
      descriptor: syntheticCapability({
        operations: [{ id: "shell", primitive: "model_generated_sql", dependsOn: [] }],
      }),
      manifest: {},
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const root = await writePack(
        subtest,
        [{ path: "capabilities/measure.json", value: item.descriptor }],
        item.manifest,
      );
      await assert.rejects(loadFinnyCapabilityPack(root), /invalid|reviewed|unknown/i);
    });
  }
});

test("capability loading rejects path escapes and manifest byte mismatches", async (t) => {
  const root = await writePack(t, [{ path: "capabilities/measure.json", value: syntheticCapability() }]);
  const outside = join(root, "..", `outside-${Date.now()}.json`);
  await writeFile(outside, JSON.stringify(syntheticCapability()));
  t.after(() => rm(outside, { force: true }));
  const outsideBody = await import("node:fs/promises").then(({ readFile }) => readFile(outside, "utf8"));
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      classification: "reviewed-finance-capability-pack",
      capabilities: [`../${outside.split("/").at(-1)}`],
      files: [
        {
          path: `../${outside.split("/").at(-1)}`,
          size: Buffer.byteLength(outsideBody),
          sha256: sha256(outsideBody),
        },
      ],
    }),
  );
  await assert.rejects(loadFinnyCapabilityPack(root), /escapes/i);

  const sizeRoot = await writePack(t, [{ path: "capabilities/measure.json", value: syntheticCapability() }]);
  const manifest = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) => readFile(join(sizeRoot, "manifest.json"), "utf8")),
  ) as { files: Array<{ size: number; sha256: string }> };
  manifest.files[0]!.size += 1;
  await writeFile(join(sizeRoot, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(loadFinnyCapabilityPack(sizeRoot), /size mismatch/i);

  const digestRoot = await writePack(t, [{ path: "capabilities/measure.json", value: syntheticCapability() }]);
  const digestManifest = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) => readFile(join(digestRoot, "manifest.json"), "utf8")),
  ) as { files: Array<{ size: number; sha256: string }> };
  digestManifest.files[0]!.sha256 = "0".repeat(64);
  await writeFile(join(digestRoot, "manifest.json"), JSON.stringify(digestManifest));
  await assert.rejects(loadFinnyCapabilityPack(digestRoot), /digest mismatch/i);
});

test("capability loading rejects a manifest symlink that escapes the reviewed bundle", async (t) => {
  const root = await writePack(t, [{ path: "capabilities/measure.json", value: syntheticCapability() }]);
  const outside = join(root, "..", `outside-manifest-${Date.now()}.json`);
  await writeFile(outside, await readFile(join(root, "manifest.json")));
  t.after(() => rm(outside, { force: true }));
  await unlink(join(root, "manifest.json"));
  await symlink(outside, join(root, "manifest.json"));

  await assert.rejects(loadFinnyCapabilityPack(root), /escapes/i);
});

test("capability loading rejects duplicate identities and invalid operation graphs", async (t) => {
  const duplicateCapability = await writePack(t, [
    { path: "capabilities/one.json", value: syntheticCapability() },
    {
      path: "capabilities/two.json",
      value: syntheticCapability({
        revisionId: "working_capital_velocity.2026-11-01",
        semanticCapability: "another_semantic_capability",
        semanticAliases: ["another_alias"],
      }),
    },
  ]);
  await assert.rejects(loadFinnyCapabilityPack(duplicateCapability), /duplicate capabilityId/i);

  const duplicateRevision = await writePack(t, [
    { path: "capabilities/one.json", value: syntheticCapability() },
    {
      path: "capabilities/two.json",
      value: syntheticCapability({
        capabilityId: "another_capability",
        semanticCapability: "another_semantic_capability",
        semanticAliases: ["another_alias"],
      }),
    },
  ]);
  await assert.rejects(loadFinnyCapabilityPack(duplicateRevision), /duplicate revisionId/i);

  const duplicateOperation = await writePack(t, [
    {
      path: "capabilities/measure.json",
      value: syntheticCapability({
        operations: [
          {
            id: "source",
            primitive: "suiteql_select",
            dependsOn: [],
            sql: "SELECT amount FROM synthetic_table WHERE entity = :entity_id",
            parameters: ["entity_id"],
          },
          { id: "source", primitive: "project", dependsOn: ["source"], fields: ["amount"] },
        ],
      }),
    },
  ]);
  await assert.rejects(loadFinnyCapabilityPack(duplicateOperation), /duplicate operation/i);

  const forwardDependency = await writePack(t, [
    {
      path: "capabilities/measure.json",
      value: syntheticCapability({
        operations: [
          { id: "projection", primitive: "project", dependsOn: ["source"], fields: ["amount"] },
          {
            id: "source",
            primitive: "suiteql_select",
            dependsOn: [],
            sql: "SELECT amount FROM synthetic_table WHERE entity = :entity_id",
            parameters: ["entity_id"],
          },
        ],
      }),
    },
  ]);
  await assert.rejects(loadFinnyCapabilityPack(forwardDependency), /dependency/i);

  const invalidResult = await writePack(t, [
    {
      path: "capabilities/measure.json",
      value: syntheticCapability({ resultOperationId: "inventory_reconciliation" }),
    },
  ]);
  await assert.rejects(loadFinnyCapabilityPack(invalidResult), /result operation/i);
});

test("operation parameters require one reviewed dimension or literal binding", async (t) => {
  const cases = [
    {
      name: "missing binding",
      bindings: { entity_id: { source: "dimension", path: ["entity"] } },
    },
    {
      name: "extra binding",
      bindings: {
        entity_id: { source: "dimension", path: ["entity"] },
        period_end: { source: "dimension", path: ["period"] },
        raw_sql: { source: "literal", value: "SELECT 1" },
      },
    },
    {
      name: "undeclared dimension root",
      bindings: {
        entity_id: { source: "dimension", path: ["secret", "entity"] },
        period_end: { source: "dimension", path: ["period"] },
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const root = await writePack(subtest, [
        {
          path: "capabilities/measure.json",
          value: syntheticCapability({ parameterBindings: item.bindings }),
        },
      ]);
      await assert.rejects(loadFinnyCapabilityPack(root), /parameter binding|dimension/i);
    });
  }
});

test("dimension defaults must be declared and reviewed", async (t) => {
  const undeclared = await writePack(t, [
    {
      path: "capabilities/measure.json",
      value: syntheticCapability({
        dimensions: {
          required: ["entity"],
          supported: { entity: ["named"] },
          defaults: { sources: ["netsuite"] },
        },
      }),
    },
  ]);
  await assert.rejects(loadFinnyCapabilityPack(undeclared), /dimension default.*undeclared/i);

  const unsupported = await writePack(t, [
    {
      path: "capabilities/measure.json",
      value: syntheticCapability({
        dimensions: {
          required: ["entity"],
          supported: { entity: ["named"], sources: ["netsuite"] },
          defaults: { sources: ["legacy"] },
        },
      }),
    },
  ]);
  await assert.rejects(loadFinnyCapabilityPack(unsupported), /dimension default.*unsupported/i);
});

test("SuiteQL operations accept only one read-only SELECT or WITH template with declared named parameters", async (t) => {
  const unsafeSql = [
    "DELETE FROM synthetic_table WHERE entity = :entity_id",
    "SELECT amount FROM synthetic_table; DELETE FROM synthetic_table",
    "WITH removed AS (DELETE FROM synthetic_table RETURNING amount) SELECT amount FROM removed",
    "SELECT amount FROM synthetic_table WHERE entity = ?",
    "SELECT amount FROM synthetic_table WHERE entity = :undeclared",
  ];

  for (const [index, sql] of unsafeSql.entries()) {
    await t.test(`unsafe template ${index + 1}`, async (subtest) => {
      const root = await writePack(subtest, [
        {
          path: "capabilities/measure.json",
          value: syntheticCapability({
            operations: [
              {
                id: "source",
                primitive: "suiteql_select",
                dependsOn: [],
                sql,
                parameters: ["entity_id"],
              },
            ],
            verificationPolicy: { requiredOperationIds: [], releaseGate: "delivery_eligible" },
          }),
        },
      ]);
      await assert.rejects(loadFinnyCapabilityPack(root), /read-only|parameter|statement|invalid/i);
    });
  }
});
