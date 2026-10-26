import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./fixture.ts";
import { GovernanceState } from "../../src/admin/governance-state.ts";
function setup() {
  const { dom } = litFixture({ markup: true });
  dom.window.eval("window.governanceUI = ui; governanceUI.mountCards();");
  return dom;
}
test("Lit mounts Governance without wrappers or duplicate ids", () => {
  const dom = setup();
  try {
    for (const id of ["auto-flagger", "command-policy", "egress", "ambient-policy"]) {
      const card = dom.window.document.getElementById(`card-${id}`)!;
      assert.equal(card.tagName, "SECTION");
      assert.equal(card.parentElement?.className, "governance-content");
      assert.ok(card.querySelector(`[data-save="${id}"]`));
    }
    const ids = [...dom.window.document.querySelectorAll("[id]")].map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    dom.window.close();
  }
});
test("keyed Lit rules preserve focus, escape values, validate and remove from state", () => {
  const dom = setup();
  try {
    dom.window.eval('governanceUI.load({commandPolicy:{mode:"denylist",rules:[]}},"org:test")');
    const doc = dom.window.document;
    doc.getElementById("add-rule")!.click();
    const input = doc.querySelector<HTMLInputElement>(".policy-pattern")!;
    input.value = "<img src=x onerror=alert(1)>";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(doc.activeElement, input);
    assert.equal(doc.querySelectorAll("#rules img, #rules script").length, 0);
    assert.equal(dom.window.eval('governanceUI.collect("command-policy").rules[0].pattern'), input.value);
    input.value = "[";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.throws(() => dom.window.eval('governanceUI.collect("command-policy")'), /regular expression/);
    doc.querySelector<HTMLButtonElement>('[aria-label="Remove command policy rule"]')!.click();
    assert.equal(doc.querySelectorAll(".policy-rule").length, 0);
    assert.equal(doc.getElementById("rules-empty")!.classList.contains("hidden"), false);
  } finally {
    dom.window.close();
  }
});
test("bot ledger changes derive rollup enablement and payload from state", () => {
  const dom = setup();
  try {
    dom.window.eval('governanceUI.load({ambientPolicy:{bots:{Build:{mode:"rollup",rollupHours:12}}}},"channel:test")');
    const doc = dom.window.document;
    const hours = doc.querySelector<HTMLInputElement>('#ambient-bots input[type="number"]')!;
    assert.equal(hours.disabled, false);
    const select = doc.querySelector<HTMLSelectElement>("#ambient-bots select")!;
    select.value = "ignore";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(hours.disabled, true);
    assert.equal(dom.window.eval('governanceUI.collect("ambient-policy").bots.Build.mode'), "ignore");
    doc.querySelector<HTMLButtonElement>('[aria-label="Remove bot ledger entry"]')!.click();
    assert.equal(doc.querySelectorAll("#ambient-bots tr").length, 0);
  } finally {
    dom.window.close();
  }
});
test("saving an older submitted draft preserves edits made during the request", () => {
  const state = new GovernanceState("org-ambient");
  state.load({ on: true });
  state.change("governance-org-ambient", false);
  const submitted = state.collect();
  state.saving = true;
  state.change("governance-org-ambient", true);
  state.commit(submitted);
  assert.equal(state.draft.on, true);
  assert.equal(state.dirty, true);
  assert.equal(state.message, "Unsaved changes");
});
test("policy validation detects duplicate bots and overlapping hosts", () => {
  const bots = new GovernanceState("ambient-policy");
  bots.load({ bots: { Build: { mode: "ignore" } } });
  bots.bots.push({ id: -1, name: "build", mode: "ignore", hours: "" });
  assert.throws(() => bots.collect(), /Duplicate bot/);
  const egress = new GovernanceState("egress");
  egress.load({ allowedHosts: ["example.com"], deniedHosts: ["example.com"] });
  assert.throws(() => egress.collect(), /both lists/);
});
