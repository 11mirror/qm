import assert from "node:assert/strict";
import { test } from "node:test";
import * as finnyPlan from "../src/finny/plan.ts";
import { finnySopFixture } from "./support/finny-sop-fixture.ts";

const sop = finnySopFixture();

test("accepts one strict finance SOP and rejects workflow-only executable fields", () => {
  const api = finnyPlan as unknown as {
    validateFinnySopVersion?: (value: unknown) => unknown;
  };
  assert.equal(typeof api.validateFinnySopVersion, "function");
  assert.deepEqual(api.validateFinnySopVersion!(sop), sop);
  const { sources: _sources, ...missingSources } = sop;
  assert.throws(() => api.validateFinnySopVersion!(missingSources), /sources/i);
  assert.throws(() => api.validateFinnySopVersion!({ ...sop, title: "   " }), /shape|title/i);
  assert.throws(
    () => api.validateFinnySopVersion!({ ...sop, nodes: [{ id: "retry", retryBudget: 3 }] }),
    /unknown|nodes/i,
  );
});

test("matches both material boolean values to canonical Slack option IDs", () => {
  const booleanSop = {
    ...sop,
    inputs: [
      ...sop.inputs,
      {
        id: "include_credits",
        label: "Include vendor credits",
        from: "human",
        type: "boolean",
        required: true,
        material: true,
      },
    ],
  } as const;
  const clarification = (id: "true" | "false") => ({
    question: "Include vendor credits?",
    options: [
      { id: "true", label: "Yes" },
      { id: "false", label: "No" },
    ],
    recommendedOptionId: id,
  });
  assert.doesNotThrow(() =>
    finnyPlan.assertFinnyMaterialClarificationMatchesSop(
      booleanSop,
      { cutoff: "2026-10-31", currency: "INR", include_credits: true },
      clarification("true"),
    ),
  );
  assert.doesNotThrow(() =>
    finnyPlan.assertFinnyMaterialClarificationMatchesSop(
      booleanSop,
      { cutoff: "2026-10-31", currency: "INR", include_credits: false },
      clarification("false"),
    ),
  );
  const optionalBooleanSop = {
    ...booleanSop,
    inputs: booleanSop.inputs.map((input) =>
      input.id === "include_credits" ? { ...input, required: false } : input,
    ),
  } as const;
  assert.throws(() =>
    finnyPlan.assertFinnyMaterialClarificationMatchesSop(
      optionalBooleanSop,
      { cutoff: "2026-10-31", currency: "INR" },
      {
        question: "Include vendor credits?",
        options: [
          { id: "undefined", label: "Not provided" },
          { id: "true", label: "Yes" },
        ],
        recommendedOptionId: "undefined",
      },
    ),
  );
});

test("execution digest changes only with executable meaning or material values", () => {
  const api = finnyPlan as unknown as {
    canonicalFinnySopDefinitionDigest?: (value: unknown) => string;
    canonicalFinnyExecutionDigest?: (value: unknown, values: Record<string, string | boolean>) => string;
  };
  assert.equal(typeof api.canonicalFinnySopDefinitionDigest, "function");
  assert.equal(typeof api.canonicalFinnyExecutionDigest, "function");
  const values = { cutoff: "2026-10-31", currency: "INR", note: "first run" };
  const renamed = {
    ...sop,
    title: "Vendor aging",
    intent: { ...sop.intent, description: "Search display changed", searchTerms: ["payables"] },
    inputs: sop.inputs.map((input) => ({ ...input, label: `Display ${input.label}` })),
  };
  const reorderedContract = {
    ...sop,
    outputs: sop.outputs.map((output) =>
      output.id === "workbook"
        ? {
            ...output,
            contract: {
              sheets: ["Summary", "Detail", "Exceptions"],
              mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          }
        : output,
    ),
  };
  const originalExecution = api.canonicalFinnyExecutionDigest!(sop, values);
  assert.match(originalExecution, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(api.canonicalFinnySopDefinitionDigest!(sop), api.canonicalFinnySopDefinitionDigest!(renamed));
  assert.equal(originalExecution, api.canonicalFinnyExecutionDigest!(renamed, { ...values, note: "second run" }));
  assert.equal(
    api.canonicalFinnySopDefinitionDigest!(sop),
    api.canonicalFinnySopDefinitionDigest!(reorderedContract),
  );
  const unicodeContract = {
    ...sop,
    outputs: sop.outputs.map((output) =>
      output.id === "workbook" ? { ...output, contract: { "é": 1, "e\u0301": 2 } } : output,
    ),
  };
  const reversedUnicodeContract = {
    ...sop,
    outputs: sop.outputs.map((output) =>
      output.id === "workbook" ? { ...output, contract: { "e\u0301": 2, "é": 1 } } : output,
    ),
  };
  assert.equal(
    api.canonicalFinnySopDefinitionDigest!(unicodeContract),
    api.canonicalFinnySopDefinitionDigest!(reversedUnicodeContract),
  );
  assert.equal(
    api.canonicalFinnyExecutionDigest!(unicodeContract, values),
    api.canonicalFinnyExecutionDigest!(reversedUnicodeContract, values),
  );
  assert.notEqual(originalExecution, api.canonicalFinnyExecutionDigest!(sop, { ...values, cutoff: "2026-11-30" }));
  assert.throws(() => api.canonicalFinnyExecutionDigest!(sop, { cutoff: "2026-10-31" }), /currency|required/i);
  assert.throws(
    () => api.canonicalFinnyExecutionDigest!(sop, { ...values, undeclared: "no" }),
    /undeclared|unknown/i,
  );
});

test("bound SOP values preserve declared object prototype keys", () => {
  const prototypeKeySop = {
    ...sop,
    inputs: [
      ...sop.inputs,
      {
        id: "__proto__",
        label: "Prototype",
        from: "human" as const,
        type: "text" as const,
        material: true,
        required: true,
      },
      {
        id: "constructor",
        label: "Constructor",
        from: "human" as const,
        type: "text" as const,
        material: true,
        required: true,
      },
    ],
  };
  const values = JSON.parse(
    '{"cutoff":"2026-10-31","currency":"INR","note":"first run","__proto__":"safe","constructor":"also-safe"}',
  ) as Record<string, string | boolean>;
  const validated = finnyPlan.validateFinnySopValues(prototypeKeySop, values);
  assert.equal(Object.getPrototypeOf(validated), null);
  assert.equal(validated.__proto__, "safe");
  assert.equal(validated.constructor, "also-safe");
  const missingConstructor = JSON.parse(
    '{"cutoff":"2026-10-31","currency":"INR","note":"first run","__proto__":"safe"}',
  );
  assert.throws(() => finnyPlan.validateFinnySopValues(prototypeKeySop, missingConstructor), /constructor.*missing/i);
});

test("compiles Producer and audit envelopes from the same SOP version and execution digest", () => {
  const api = finnyPlan as unknown as {
    compileFinnyProducerTask?: (value: unknown, values: Record<string, string | boolean>) => Record<string, unknown>;
    compileFinnyAuditEnvelope?: (value: unknown, values: Record<string, string | boolean>) => Record<string, unknown>;
  };
  assert.equal(typeof api.compileFinnyProducerTask, "function");
  assert.equal(typeof api.compileFinnyAuditEnvelope, "function");
  const values = { cutoff: "2026-10-31", currency: "INR", note: "first run" };
  const producer = api.compileFinnyProducerTask!(sop, values);
  const audit = api.compileFinnyAuditEnvelope!(sop, values);
  const boundInputs = Object.assign(Object.create(null) as Record<string, string>, values);
  assert.deepEqual(producer, {
    schema: "finny.producer-task.v1",
    sopVersion: {
      id: "ap-aging",
      version: 3,
      scopeId: "org:invented-media-company",
    },
    executionDigest: producer.executionDigest,
    objective: sop.objective,
    boundInputs,
    sources: sop.sources,
    steps: sop.steps,
    controls: sop.controls,
    outputs: sop.outputs,
  });
  assert.deepEqual(audit, {
    schema: "finny.audit-envelope.v1",
    sopVersion: producer.sopVersion,
    executionDigest: producer.executionDigest,
    boundInputs,
    sources: sop.sources,
    controls: sop.controls,
    outputs: sop.outputs,
  });
});

test("rejects SOPs without finance evidence, controls, workbook, and certified summary contracts", () => {
  const api = finnyPlan as unknown as {
    validateFinnySopVersion: (value: unknown) => unknown;
    canonicalFinnyExecutionDigest: (value: unknown, values: Record<string, string | boolean>) => string;
  };
  assert.throws(() => api.validateFinnySopVersion({ ...sop, controls: [] }), /control/i);
  assert.throws(
    () => api.validateFinnySopVersion({ ...sop, outputs: [{ ...sop.outputs[0], contract: null }, sop.outputs[1]] }),
    /shape|contract/i,
  );
  assert.throws(() => api.validateFinnySopVersion({ ...sop, approval: { ...sop.approval, required: false } }), /shape/i);
  assert.throws(
    () => api.validateFinnySopVersion({ ...sop, outputs: sop.outputs.filter((output) => output.kind !== "xlsx") }),
    /xlsx|workbook/i,
  );
  assert.throws(
    () => api.validateFinnySopVersion({ ...sop, outputs: sop.outputs.filter((output) => output.kind !== "summary") }),
    /summary/i,
  );
  assert.throws(
    () => api.validateFinnySopVersion({ ...sop, sources: [{ ...sop.sources[0], asOfInput: "unknown" }] }),
    /unknown/i,
  );
  assert.throws(
    () => api.canonicalFinnyExecutionDigest(sop, { cutoff: "2026-10-31", currency: true }),
    /currency|text/i,
  );
});

test("compiles role-specific worker tasks without prompt-level workflow authority", () => {
  const api = finnyPlan as unknown as {
    compileFinnyWorkerTask?: (
      job: Record<string, unknown>,
      role: "producer" | "auditor",
    ) => Record<string, unknown>;
  };
  assert.equal(typeof api.compileFinnyWorkerTask, "function");
  const values = { cutoff: "2026-10-31", currency: "INR" };
  const job = {
    id: "job-1",
    sop,
    sopBinding: {
      versionId: "org%3Ainvented-media-company/ap-aging@3",
      values,
      executionDigest: finnyPlan.canonicalFinnyExecutionDigest(sop, values),
      revision: 1,
    },
    policy: { policyVersion: "p1", requiredGenerations: { "source.completeness": 1 } },
    findingPolicy: { id: "f1", maxFindings: 8, maxCodeLength: 80, maxMessageLength: 2_000 },
    artifactDigest: "artifact-digest",
  };
  const producer = api.compileFinnyWorkerTask!(job, "producer");
  const auditor = api.compileFinnyWorkerTask!(job, "auditor");
  assert.equal(producer.schema, "finny.producer-task.v1");
  assert.equal(producer.jobId, "job-1");
  assert.equal("artifactDigest" in producer, false);
  assert.equal(auditor.schema, "finny.audit-envelope.v1");
  assert.equal(auditor.jobId, "job-1");
  assert.equal(auditor.artifactDigest, "artifact-digest");
  assert.equal(JSON.stringify({ producer, auditor }).includes("retryBudget"), false);
  assert.equal(JSON.stringify({ producer, auditor }).includes("instruction"), false);
});

test("projects approval presentation from the exact SOP binding", () => {
  const api = finnyPlan as unknown as {
    finnySopPlanPresentation?: (sop: unknown, values: Record<string, string | boolean>) => Record<string, unknown>;
  };
  assert.equal(typeof api.finnySopPlanPresentation, "function");
  assert.deepEqual(api.finnySopPlanPresentation!(sop, { cutoff: "2026-10-31", currency: "INR" }), {
    title: sop.title,
    summary: sop.intent.description,
    phases: [
      { name: sop.steps[0].action, owner: "Producer", dependencies: [] },
      { name: sop.steps[1].action, owner: "Producer", dependencies: [sop.steps[0].action] },
    ],
    certification: sop.controls.map((control) => control.assertion).join("\n"),
    deliverable: "XLSX workbook, certified summary",
    destination: "origin-thread",
    clarifications: [
      { question: "Cutoff date", answer: "2026-10-31" },
      { question: "Presentation currency", answer: "INR" },
    ],
  });
});
