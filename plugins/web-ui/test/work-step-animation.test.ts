import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("only live work step labels fade in while settled heads stay still", () => {
  const dom = new JSDOM(
    '<style></style><details><summary class="work-head"><span class="work-step">Reading</span></summary></details>',
  );
  try {
    dom.window.document.querySelector("style")!.textContent = readFileSync(
      new URL("../src/styles/transcript-live.css", import.meta.url),
      "utf8",
    );
    const fold = dom.window.document.querySelector("details")!;
    const step = dom.window.document.querySelector("span")!;
    for (const status of ["thinking", "working", "complete", "failed"]) {
      fold.className = `work-${status}`;
      const animation = dom.window.getComputedStyle(step).animation;
      assert.equal(animation.includes("work-step-in"), status === "thinking" || status === "working");
    }
    step.classList.add("work-step-out");
    assert.match(dom.window.getComputedStyle(step).animation, /work-step-out/);
  } finally {
    dom.window.close();
  }
});
