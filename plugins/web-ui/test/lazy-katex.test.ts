import assert from "node:assert/strict";
import test from "node:test";
import katexFacade from "../src/lazy-katex.ts";

test("katex facade renders math as escaped text before the real library loads", () => {
  const out = katexFacade.renderToString('x < y & "z"');
  assert.match(out, /^<span class="math-pending">/);
  assert.ok(out.includes("x &lt; y &amp; &quot;z&quot;"), "math text must be HTML-escaped");
  assert.ok(!out.includes("<y"), "no raw angle brackets survive");
});
