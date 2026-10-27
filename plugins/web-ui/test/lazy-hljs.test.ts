import assert from "node:assert/strict";
import test from "node:test";
import hljsFacade from "../src/lazy-hljs.ts";

test("hljs facade highlights as escaped plain text before the real library loads", () => {
  const out = hljsFacade.highlight('if (a < b) alert("hi");', { language: "javascript" });
  assert.equal(out.value, "if (a &lt; b) alert(&quot;hi&quot;);");
  const auto = hljsFacade.highlightAuto("<script>alert(1)</script>");
  assert.ok(!auto.value.includes("<script>"), "auto path must escape too");
});

test("hljs facade reports no language pre-load, so code-block takes the auto path", () => {
  assert.equal(hljsFacade.getLanguage("javascript"), undefined);
});

test("stub grammar registration is a safe no-op", () => {
  assert.doesNotThrow(() => hljsFacade.registerLanguage("javascript", () => ({})));
});
