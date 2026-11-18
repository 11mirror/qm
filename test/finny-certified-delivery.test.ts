import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { certifiedResultDelivery, deliverPendingCertifiedResults } from "../src/finny/certified-delivery.ts";
import type { FinnyCertifiedResultRecord } from "../src/finny/certified-result.ts";
import { parseGenerativeUISpec, renderGenerativeUI } from "../src/slack/generative-ui.ts";

const result = {
  id: "result-1",
  scopeId: "org:sharechat",
  schema: "finny.result.v1" as const,
  jobId: "job-1",
  sopVersionId: "sop-1",
  executionDigest: "execution-1",
  artifact: {
    fileId: "file-1",
    sha256: "a".repeat(64),
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
  },
  summary: {
    period: "2026-10-31",
    currency: "INR",
    metrics: [{ id: "open-ap", label: "Open AP", value: "12172560.00", detailRefs: ["xlsx:Summary!B7"] }],
    exceptions: [
      {
        text: "One disputed bill remains open",
        material: true,
        detailRefs: ["xlsx:Exceptions!A2:D2"],
      },
    ],
    caveats: [{ text: "FX translated at the approved cutoff rate", detailRefs: ["evidence:source-manifest#fx-rate"] }],
  },
  auditAttemptId: "audit-1",
  receipt: {
    token: "signed-receipt",
    payload: {
      aud: "finny.final.delivery" as const,
      resultId: "result-1",
      jobId: "job-1",
      scopeId: "org:sharechat",
      sopVersionId: "sop-1",
      executionDigest: "execution-1",
      artifactFileId: "file-1",
      artifactSha256: "a".repeat(64),
      auditAttemptId: "audit-1",
      approvalRequestId: "approval-1",
      approvalActorId: "U1",
      originThreadRef: "slack:C1:100.1",
      issuedAt: 1,
    },
  },
  destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
  idempotencyKey: "certify-result-1",
  createdAt: 1,
};

test("projects the canonical certified result into one result-owned delivery", () => {
  const delivery = certifiedResultDelivery(result, "https://qm.example.test");
  assert.equal(delivery.idempotencyKey, "finny-result:result-1");
  assert.deepEqual(delivery.destination, result.destination);
  const projection = JSON.parse(delivery.text) as {
    fallbackText: string;
    elements: Array<Record<string, unknown>>;
  };
  assert.match(projection.fallbackText, /2026-10-31/);
  assert.match(projection.fallbackText, /INR/);
  assert.match(projection.fallbackText, /Open AP: 12172560\.00/);
  assert.match(projection.fallbackText, /One disputed bill remains open/);
  assert.match(projection.fallbackText, /FX translated at the approved cutoff rate/);
  assert.match(projection.fallbackText, /signed-receipt/);
  assert.match(projection.fallbackText, /\/api\/files\/file-1\/content/);
  const rendered = renderGenerativeUI(parseGenerativeUISpec(delivery.text)!);
  assert.match(JSON.stringify(rendered.blocks), /Open AP/);
  assert.match(JSON.stringify(rendered.blocks), /12172560\.00/);
  assert.match(JSON.stringify(rendered.blocks), /signed-receipt/);
  assert.match(JSON.stringify(rendered.blocks), /https:\/\/qm\.example\.test\/api\/files\/file-1\/content/);
  assert.match(JSON.stringify(rendered.blocks), /https:\/\/qm\.example\.test\/api\/finny\/results\/result-1/);
});

test("keeps the download, receipt, and complete fallback summary visible beyond Slack block limits", () => {
  const metrics = Array.from({ length: 48 }, (_, index) => ({
    id: `metric-${index}`,
    label: `Metric ${index} ${"descriptive-label ".repeat(180)}`,
    value: String(index),
    detailRefs: [`xlsx:Summary!B${index + 1}`],
  }));
  const delivery = certifiedResultDelivery(
    { ...result, summary: { ...result.summary, metrics } },
    "https://qm.example.test",
  );
  const rendered = renderGenerativeUI(parseGenerativeUISpec(delivery.text)!);
  const visible = JSON.stringify(rendered.blocks);
  assert.match(visible, /api\\?\/files\\?\/file-1\\?\/content/);
  assert.match(visible, /signed-receipt/);
  assert.match(visible, /Metric 47/);
  assert.match(visible, /One disputed bill remains open/);
  assert.match(visible, /FX translated at the approved cutoff rate/);
  assert.match(rendered.text, /Metric 47 .*: 47/);
});

test("packs a long label by actual length without dropping its certified value", () => {
  const metrics = Array.from({ length: 48 }, (_, index) => ({
    id: `metric-${index}`,
    label: index === 47 ? `Metric 47 ${"long-label ".repeat(145)}` : `Metric ${index}`,
    value: index === 47 ? "123456.78" : String(index),
    detailRefs: [`xlsx:Summary!B${index + 1}`],
  }));
  const delivery = certifiedResultDelivery(
    { ...result, summary: { ...result.summary, metrics } },
    "https://qm.example.test",
  );
  const rendered = renderGenerativeUI(parseGenerativeUISpec(delivery.text)!);
  assert.match(JSON.stringify(rendered.blocks), /123456\.78/);
});

test("splits one oversized caveat without dropping its final words", () => {
  const caveat = `${"extended caveat ".repeat(215)}FINAL CAVEAT WORDS`;
  const delivery = certifiedResultDelivery(
    { ...result, summary: { ...result.summary, caveats: [{ text: caveat, detailRefs: ["xlsx:Notes!A1"] }] } },
    "https://qm.example.test",
  );
  const rendered = renderGenerativeUI(parseGenerativeUISpec(delivery.text)!);
  assert.match(JSON.stringify(rendered.blocks), /FINAL CAVEAT WORDS/);
});

test("packs Slack-expanded invoice links without clipping the final control", () => {
  const metrics = Array.from({ length: 47 }, (_, index) => ({
    id: `metric-${index}`,
    label: `Invoice ${index} https://example.test/invoices/${index}?vendor=${"long-vendor-name".repeat(6)}`,
    value: String(index),
    detailRefs: [`xlsx:Summary!B${index + 1}`],
  }));
  const delivery = certifiedResultDelivery(
    {
      ...result,
      summary: {
        ...result.summary,
        metrics: [...metrics, { id: "excluded", label: "EXCLUDE_DISPUTED_BALANCES", value: "PASS", detailRefs: [] }],
      },
    },
    "https://qm.example.test",
  );
  const rendered = renderGenerativeUI(parseGenerativeUISpec(delivery.text)!);
  assert.match(JSON.stringify(rendered.blocks), /EXCLUDE_DISPUTED_BALANCES/);
});

test("keeps every certified value when Slack compacts link-heavy metrics", () => {
  const metrics = Array.from({ length: 48 }, (_, index) => ({
    id: `metric-${index}`,
    label: `Invoice ${index} https://example.test/invoices/${index}?vendor=${"long-vendor-name".repeat(120)}`,
    value: `CERTIFIED_VALUE_${index}`,
    detailRefs: [`xlsx:Summary!B${index + 1}`],
  }));
  const delivery = certifiedResultDelivery(
    { ...result, summary: { ...result.summary, metrics } },
    "https://qm.example.test",
  );
  const rendered = renderGenerativeUI(parseGenerativeUISpec(delivery.text)!);
  const visible = JSON.stringify(rendered.blocks);
  for (let index = 0; index < metrics.length; index += 1)
    assert.match(visible, new RegExp(`CERTIFIED_VALUE_${index}\\b`));
});

test("uses the identical certified figures for web and Slack destinations", () => {
  const slack = certifiedResultDelivery(result, "https://qm.example.test");
  const web = certifiedResultDelivery(
    { ...result, destination: { type: "web", target: "session-1" } },
    "https://qm.example.test",
  );
  assert.equal(JSON.parse(slack.text).fallbackText, JSON.parse(web.text).fallbackText);
  assert.deepEqual(web.destination, {
    type: "web",
    target: "session-1",
    webTranscript: { kind: "reply" },
  });
});

test("recovers result-owned delivery intent without duplicating the visible result", async () => {
  const deliveries = createDeliveryStore();
  let deliveryId: string | undefined;
  const lifecycle: string[] = [];
  const results = {
    async pendingCertifiedResultDeliveries() {
      return deliveryId ? [] : [result];
    },
    async markCertifiedResultDelivery(resultId: string, id: string) {
      assert.equal(resultId, result.id);
      lifecycle.push("marked");
      deliveryId = id;
    },
  };
  const retired: string[] = [];
  const afterEnqueue = async (entry: FinnyCertifiedResultRecord) => {
    lifecycle.push("retired");
    retired.push(entry.jobId);
  };
  await deliverPendingCertifiedResults(results, deliveries, "https://qm.example.test", afterEnqueue);
  await deliverPendingCertifiedResults(results, deliveries, "https://qm.example.test", afterEnqueue);
  assert.ok(deliveryId);
  assert.equal((await deliveries.pending("slack")).length, 1);
  assert.deepEqual(retired, [result.jobId]);
  assert.deepEqual(lifecycle, ["retired", "marked"]);
});
