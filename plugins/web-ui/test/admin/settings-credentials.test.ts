import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "../support/admin-fixture.ts";
import { settingsDom } from "../support/admin-settings.ts";
import { CredentialState } from "../../src/admin/settings-credentials.ts";

test("credential editor derives broker capabilities and preserves write-only secrets", () => {
  const dom = settingsDom();
  try {
    dom.window.eval(
      'settingsUI.configureCredentials({label: id => id,formatTime:String,edit(){},remove(){}}); settingsUI.loadCredentials([],[],[],[],"org:test"); settingsUI.credentialState.begin({slug:"service",name:"Service",host:"api.example.com",updatedAt:10,hasSecret:true,injection:{actor:true},grantees:["org:test"]})',
    );
    const doc = dom.window.document;
    const secret = doc.getElementById("sc-secret") as HTMLInputElement;
    assert.equal(secret.value, "");
    assert.equal(dom.window.eval('"secret" in settingsUI.credentialState.collect()'), false);
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().injection.actor"), true);
    const host = doc.getElementById("sc-host") as HTMLInputElement;
    host.value = "changed.example.com";
    host.dispatchEvent(new dom.window.Event("input"));
    assert.equal(doc.getElementById("sc-cap-host")!.textContent, "changed.example.com and its subdomains");
    assert.equal((doc.getElementById("sc-save") as HTMLButtonElement).disabled, false);
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().expectedUpdatedAt"), 10);
  } finally {
    dom.window.close();
  }
});

test("credential delivery transitions exclude narrower broker grants from env payloads", () => {
  const dom = settingsDom();
  try {
    dom.window.eval(
      'settingsUI.loadCredentials([],[],[],[],"org:test"); settingsUI.credentialState.begin(null); settingsUI.credentialState.change("name","Example");settingsUI.credentialState.change("slug","example");settingsUI.credentialState.change("org",false);settingsUI.credentialState.change("people","person@example.com");settingsUI.credentialState.change("delivery","env");settingsUI.credentialState.change("envkey","EXAMPLE_KEY")',
    );
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().grantees.join()"), "org:test");
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().host"), "");
    assert.equal(dom.window.eval("settingsUI.credentialState.validate(settingsUI.credentialState.collect())"), "");
    dom.window.eval('settingsUI.credentialState.change("envkey","AGENT_SECRET")');
    assert.match(
      String(dom.window.eval("settingsUI.credentialState.validate(settingsUI.credentialState.collect())")),
      /reserved/,
    );
  } finally {
    dom.window.close();
  }
});

test("credential save acknowledges its submitted snapshot and retains newer edits", () => {
  const dom = settingsDom();
  try {
    dom.window.eval(
      'settingsUI.loadCredentials([],[],[],[],"org:test"); settingsUI.credentialState.begin({slug:"test",name:"Old",host:"example.com",updatedAt:1,grantees:["org:test"]});settingsUI.credentialState.change("name","Submitted");window.submitted=settingsUI.credentialState.collect();settingsUI.credentialState.change("name","Newer draft");settingsUI.loadCredentials([{slug:"test",updatedAt:2}],[],[],[],"org:test");settingsUI.credentialState.commit(submitted)',
    );
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().name"), "Newer draft");
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().expectedUpdatedAt"), 2);
    assert.equal(dom.window.eval("settingsUI.credentialState.dirty"), true);
  } finally {
    dom.window.close();
  }
});

test("credential edits carry the loaded revision and preserve injection settings", () => {
  const state = new CredentialState();
  state.begin({ slug: "test", name: "Test", host: "example.com", updatedAt: 42 });
  assert.equal(state.collect().expectedUpdatedAt, 42);
  const fixed = new CredentialState();
  fixed.begin({
    slug: "versioned",
    name: "Versioned",
    host: "api.example.com",
    updatedAt: 7,
    injection: { header: "x-api-key", scheme: "Token", actor: true, headers: { "x-api-version": "2025-11-01" } },
  });
  fixed.draft.secret = "rotated";
  fixed.draft.host = "api2.example.com";
  assert.deepEqual(fixed.collect().injection, {
    actor: true,
    headers: { "x-api-version": "2025-11-01" },
    header: "x-api-key",
    scheme: "Token",
  });
});

test("credential usage distinguishes loading, failure, and confirmed zero", () => {
  const f = litFixture();
  try {
    f.root.innerHTML = '<template data-settings-card="card-service-credentials"></template>';
    f.ui.settings.mountCards();
    for (const [usage, message] of [
      [{}, "Loading usage…"],
      [{ usageUnavailable: true }, "Usage unavailable"],
      [{ usageCount: 0 }, "0 successful uses in retained broker history"],
    ] as const) {
      f.ui.settings.loadCredentials([{ slug: "test", host: "example.com", ...usage }], [], [], [], "org:test");
      assert.ok(f.document.querySelector("#sc-list")!.textContent!.includes(message));
    }
  } finally {
    f.dom.window.close();
  }
});
