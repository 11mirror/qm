import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("Retry under a failed send stays clickable while its prompt row is pinned", () => {
  const dom = new JSDOM(
    `<!doctype html><div class="message-stack"><div class="message-row user-row latest-prompt">
      <div class="message-bubble user-bubble"><div class="pin-content">hello</div></div>
      <div class="send-failure"><span>Couldn't send.</span><button class="btn compact" type="button">Retry</button></div>
    </div></div>`,
  );
  const { document, getComputedStyle } = dom.window;
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  document.head.append(style);
  const row = document.querySelector(".latest-prompt")!;
  assert.equal(getComputedStyle(row).pointerEvents, "none");
  assert.equal(getComputedStyle(row.querySelector(".send-failure")!).pointerEvents, "none");
  assert.equal(getComputedStyle(row.querySelector(".send-failure .btn")!).pointerEvents, "auto");
  dom.window.close();
});
