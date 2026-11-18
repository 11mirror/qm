import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qm.example.test" });
for (const key of ["window", "document", "customElements", "HTMLElement", "Element", "Node", "Document"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const { GenerativeCard } = await import("../src/generative-card.ts");

test("certified result renders business facts, receipt, and workbook download", async () => {
  const card = new GenerativeCard();
  document.body.append(card);
  card.spec = JSON.stringify({
    schema: "generative-ui.v1",
    elements: [
      { type: "header", text: "Finny Certification Complete" },
      { type: "callout", title: "Certified scope", text: "2026-10-31 · INR", level: "success" },
      { type: "metric", label: "Open AP", value: "12172560.00" },
      {
        type: "actions",
        buttons: [
          {
            label: "Download Workbook (.xlsx)",
            actionId: "download",
            value: "file-1",
            url: "https://qm.example.test/api/files/file-1/content",
          },
        ],
      },
      { type: "context", elements: ["Receipt: `signed-receipt`"] },
    ],
  });
  await card.updateComplete;
  assert.match(card.textContent ?? "", /2026-10-31 · INR/);
  assert.match(card.textContent ?? "", /Open AP/);
  assert.match(card.textContent ?? "", /12172560\.00/);
  assert.match(card.textContent ?? "", /signed-receipt/);
  assert.equal(card.querySelector("a")?.href, "https://qm.example.test/api/files/file-1/content");
  card.remove();
});
