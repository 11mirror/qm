import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeFinnyFinanceIntent } from "../src/finny/finance-ir.ts";

test("normalizes AP intent with explicit finance dimensions and release controls", () => {
  const ir = normalizeFinnyFinanceIntent({
    request: "AP balance",
    entity: { kind: "named", name: " Example Manufacturing " },
    period: { kind: "as_of", date: "2026-03-31" },
    currency: { kind: "specified", code: "inr" },
    grain: "vendor",
    sources: ["netsuite", "legacy", "netsuite"],
    migrationMarkers: [" opening migration ", "opening migration"],
    artifact: "required",
  });
  assert.deepEqual(ir, {
    version: 1,
    request: "AP balance",
    measure: "ap_gl_control_balance",
    temporalShape: "stock",
    entity: { kind: "named", name: "Example Manufacturing" },
    period: { kind: "as_of", date: "2026-03-31" },
    currency: { kind: "specified", code: "INR" },
    grain: "vendor",
    sources: ["netsuite", "legacy"],
    migrationMarkers: ["opening migration"],
    artifact: "required",
    verification: "single_numeric_total",
  });
});

test("normalizes flow periods without turning expense into a payable stock", () => {
  const ir = normalizeFinnyFinanceIntent({
    request: "Expense for the year",
    measure: "expense",
    period: { kind: "range", start: "2026-01-01", end: "2026-12-31" },
    grain: "monthly",
  });
  assert.equal(ir.measure, "expense");
  assert.equal(ir.temporalShape, "flow");
  assert.deepEqual(ir.period, { kind: "range", start: "2026-01-01", end: "2026-12-31" });
  assert.equal(ir.grain, "monthly");
  assert.equal(ir.artifact, "optional");
});

test("preserves unknown and explicit natural language constraints instead of inventing defaults", () => {
  const ir = normalizeFinnyFinanceIntent("AP balance by vendor as of 2026-03-31 in USD after migration");
  assert.equal(ir.grain, "vendor");
  assert.deepEqual(ir.period, { kind: "as_of", date: "2026-03-31" });
  assert.deepEqual(ir.currency, { kind: "specified", code: "USD" });
  assert.deepEqual(ir.migrationMarkers, ["migration"]);
  assert.equal(normalizeFinnyFinanceIntent("weather forecast").measure, "unknown");
});

test("preserves named entities and artifact requests from natural intent", () => {
  const ir = normalizeFinnyFinanceIntent("AP balance for Example Manufacturing as an Excel file");
  assert.deepEqual(ir.entity, { kind: "named", name: "Example Manufacturing" });
  assert.equal(ir.artifact, "required");
});

test("normalizes a synthetic open AR request without losing its historical cutoff", () => {
  const ir = normalizeFinnyFinanceIntent("what's our open AR for Example Manufacturing as at 15-Sep-2025");
  assert.deepEqual(ir, {
    version: 1,
    request: "what's our open AR for Example Manufacturing as at 15-Sep-2025",
    measure: "open_receivables",
    temporalShape: "stock",
    entity: { kind: "named", name: "Example Manufacturing" },
    period: { kind: "as_of", date: "2025-09-15" },
    currency: { kind: "source_base" },
    grain: "total",
    sources: ["netsuite"],
    migrationMarkers: [],
    artifact: "optional",
    verification: "single_numeric_total",
  });
});

test("keeps invalid human-readable finance dates unresolved", () => {
  const ir = normalizeFinnyFinanceIntent("open AR for Example Manufacturing as at 31-Feb-2025");
  assert.deepEqual(ir.period, {
    kind: "unresolved",
    text: "open AR for Example Manufacturing as at 31-Feb-2025",
  });
});

test("maps a reviewed supplier-liability phrase to AP without discarding its meaning", () => {
  const ir = normalizeFinnyFinanceIntent("How much do we owe suppliers?");
  assert.equal(ir.measure, "ap_gl_control_balance");
  assert.equal(ir.entity.kind, "all");
  assert.equal(ir.period.kind, "current");
  assert.equal(ir.grain, "total");
  assert.equal(ir.unresolvedConstraints, undefined);
});

test("fails closed on AP qualifiers outside the reviewed natural-language surface", () => {
  const ir = normalizeFinnyFinanceIntent("AP balance excluding intercompany suppliers");
  assert.deepEqual(ir.unresolvedConstraints, ["AP balance excluding intercompany suppliers"]);
});
