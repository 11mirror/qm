import { test } from "node:test";
import assert from "node:assert/strict";
import { packRerun, recordedRerun } from "../../src/sessions/rerun-record.ts";

test("a rerun record keeps only the input the ToolCall body does not already carry, and reads back whole", () => {
  const command = "x".repeat(50_000);
  const payload = { tool: "execute", command, purpose: "Run", scope: "scoped" };
  const packed = packRerun(payload, { tool: "execute", input: { command, purpose: "Run", timeout_seconds: 30 } });
  assert.deepEqual(packed, { tool: "execute", input: { timeout_seconds: 30 }, recorded: ["command", "purpose"] });
  assert.ok(JSON.stringify(packed).length < 200, "the long command is not stored twice");
  assert.deepEqual(recordedRerun({ ...payload, retrySafe: true, rerun: packed }), {
    tool: "execute",
    input: { command, purpose: "Run", timeout_seconds: 30 },
  });
});

test("a rerun record whose body value differs from the input keeps the input value", () => {
  const packed = packRerun(
    { tool: "history", query: "budget (redacted)" },
    { tool: "history", input: { query: "budget" } },
  );
  assert.deepEqual(packed, { tool: "history", input: { query: "budget" } });
  assert.deepEqual(
    recordedRerun({ tool: "history", query: "x", rerun: { tool: "history", input: { query: "budget" } } }),
    {
      tool: "history",
      input: { query: "budget" },
    },
  );
  assert.equal(recordedRerun({ tool: "history" }), undefined);
  assert.equal(recordedRerun({ rerun: { tool: "history", input: [] } }), undefined);
});
