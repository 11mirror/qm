import assert from "node:assert/strict";
import { adminShell } from "../support/admin-fixture.ts";
import test from "node:test";
import { JSDOM } from "jsdom";
import { configure, ConnectorsState, SlackInstallationState } from "../../src/admin/integrations-state.ts";
import { adminBundle } from "../support/admin-bundle.ts";
const integrationsBundle = adminBundle("integrations.ts", "integrationsUI");
function setup() {
  const dom = new JSDOM(adminShell(), {
    runScripts: "outside-only",
    url: "http://localhost/settings/slack-settings",
  });
  dom.window.eval(
    integrationsBundle +
      ';window.ui=integrationsUI;ui.mountCards();ui.configure({api:async()=>({ok:true,data:{}}),orgScope:()=>"org:test",connectorName:id=>id,save:()=>{}});',
  );
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}
test("Slack settings are state driven and preserve newer drafts when committing", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'ui.loadScope({externalSlackParticipants:false,channelHeaderPinDefault:false,ackEmoji:[]},"org:test")',
    );
    const doc = dom.window.document;
    const radio = doc.querySelector<HTMLInputElement>('[name="external-slack-choice"][value="on"]')!;
    radio.click();
    assert.equal(dom.window.eval('ui.collect("external-slack-participants").on'), true);
    assert.equal(doc.querySelector<HTMLButtonElement>('[data-save="external-slack-participants"]')!.disabled, false);
    dom.window.eval('ui.status("external-slack-participants","Saving","saving")');
    doc.querySelector<HTMLInputElement>('[name="external-slack-choice"][value="off"]')!.click();
    dom.window.eval('ui.commit("external-slack-participants",{on:true})');
    assert.equal(doc.getElementById("st-external-slack-participants")!.textContent, "Unsaved changes");
    assert.equal(doc.querySelector<HTMLInputElement>('[name="external-slack-choice"][value="off"]')!.checked, true);
  } finally {
    dom.window.close();
  }
});
test("Connector editor renders guides and keeps fields and focus stable while typing", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'ui.connectors.catalog=[{provider:"github",setupGuide:{url:"https://example.com",console:"GitHub",steps:["Create app"]},redirectPath:"github",scopes:["repo"]}];ui.connectors.render()',
    );
    const doc = dom.window.document;
    doc.getElementById("add-oauth-app")!.click();
    const input = doc.getElementById("conn-client-id") as HTMLInputElement;
    input.value = "my client";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(doc.activeElement, input);
    assert.equal(dom.window.eval("ui.connectors.draft.clientId"), "my client");
    assert.match(
      doc.getElementById("conn-guide")!.textContent!,
      /Callback URL: http:\/\/localhost\/v1\/connectors\/oauth\/github/,
    );
    assert.equal(doc.getElementById("conn-editor")!.classList.contains("hidden"), false);
    doc.getElementById("conn-reset")!.click();
    assert.equal(doc.getElementById("conn-editor")!.classList.contains("hidden"), true);
  } finally {
    dom.window.close();
  }
});
const PICKER_CATALOG =
  '[{provider:"github",setupGuide:{url:"https://example.com",console:"GitHub",steps:["Create app"]},redirectPath:"github/callback",scopes:["repo"]},{provider:"zoom",configured:true,setupGuide:{url:"https://example.com",console:"Zoom",steps:["Create app"]},redirectPath:"zoom/callback",scopes:[]}]';
function configurePicker(dom: JSDOM, connectors: string) {
  dom.window.eval(
    `ui.configure({api:async(m,p)=>p==="/api/connector-catalog"?{ok:true,data:{catalog:${PICKER_CATALOG}}}:{ok:true,data:{connectors:${connectors}}},orgScope:()=>"org:test",connectorName:id=>id})`,
  );
}
test("Connector picker lists the catalog, follows the draft, and locks while editing", async () => {
  const dom = setup();
  try {
    configurePicker(dom, '[{provider:"github",clientId:"gid"}]');
    await dom.window.eval("ui.loadConnectors()");
    const doc = dom.window.document;
    doc.getElementById("add-oauth-app")!.click();
    const select = doc.getElementById("conn-provider") as HTMLSelectElement;
    assert.deepEqual(
      [...select.options].map((o) => [o.value, o.textContent!.trim()]),
      [
        ["github", "github"],
        ["zoom", "zoom (configured)"],
      ],
    );
    assert.equal(select.value, "github");
    assert.equal(select.disabled, false);
    select.value = "zoom";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(dom.window.eval("ui.connectors.draft.provider"), "zoom");
    assert.match(doc.getElementById("conn-guide")!.textContent!, /oauth\/zoom\/callback/);
    dom.window.eval('ui.connectors.edit({provider:"github",clientId:"gid"})');
    assert.equal(select.value, "github");
    assert.equal(select.disabled, true);
    dom.window.eval('ui.connectors.edit({provider:"zoom",inherited:true})');
    assert.equal(select.value, "zoom");
    assert.equal(select.disabled, false);
  } finally {
    dom.window.close();
  }
});
test("Connector picker settles on a real provider when the catalog arrives after the editor opens", async () => {
  const dom = setup();
  try {
    const doc = dom.window.document;
    doc.getElementById("add-oauth-app")!.click();
    configurePicker(dom, "[]");
    await dom.window.eval("ui.loadConnectors()");
    const select = doc.getElementById("conn-provider") as HTMLSelectElement;
    assert.equal(dom.window.eval("ui.connectors.draft.provider"), "github");
    assert.equal(select.value, "github");
    assert.match(doc.getElementById("conn-guide")!.textContent!, /oauth\/github\/callback/);
  } finally {
    dom.window.close();
  }
});
test("Connector saves use captured payloads and retain edits made during a request", async () => {
  let resolve!: (value: any) => void;
  const bodies: unknown[] = [];
  configure({
    save: () => {},
    orgScope: () => "org:test",
    connectorName: (x) => x,
    api: async (method, _path, body) => {
      if (method === "PUT") {
        bodies.push(body);
        return new Promise((r) => (resolve = r));
      }
      return { ok: true, data: { catalog: [], connectors: [] } };
    },
  });
  const s = new ConnectorsState();
  s.edit({ provider: "github" });
  s.change("clientId", "first");
  s.change("clientSecret", "secret");
  const saving = s.save();
  s.change("clientId", "newer");
  resolve({ ok: true, data: {} });
  await saving;
  assert.deepEqual(bodies, [{ provider: "github", clientId: "first", clientSecret: "secret", enabled: true }]);
  assert.equal(s.draft.clientId, "newer");
  assert.equal(s.editor, true);
  assert.equal(s.saving, false);
});
test("Connector load ignores out of order responses and preserves the open editor", async () => {
  const pending: Array<(value: any) => void> = [];
  configure({
    save: () => {},
    orgScope: () => "org:test",
    connectorName: (x) => x,
    api: () => new Promise((r) => pending.push(r)),
  });
  const s = new ConnectorsState();
  const old = s.load();
  const latest = s.load();
  pending[2]({ ok: true, data: { catalog: [{ provider: "new" }] } });
  pending[3]({ ok: true, data: { connectors: [] } });
  await latest;
  s.edit({ provider: "new" });
  s.change("clientId", "draft");
  pending[0]({ ok: true, data: { catalog: [{ provider: "stale" }] } });
  pending[1]({ ok: true, data: { connectors: [] } });
  await old;
  assert.equal(s.catalog[0].provider, "new");
  assert.equal(s.draft.clientId, "draft");
});
test("Slack connection validates token drafts before submitting", async () => {
  let called = false;
  configure({
    save: () => {},
    orgScope: () => "org:test",
    connectorName: (x) => x,
    api: async () => {
      called = true;
      return { ok: true, data: {} };
    },
  });
  const s = new SlackInstallationState();
  s.botToken = "xoxb-example";
  await s.save();
  assert.equal(called, false);
  assert.equal(s.message, "Both Slack tokens are required.");
});

async function render(data: Record<string, unknown>) {
  const dom = new JSDOM(adminShell(), {
    runScripts: "outside-only",
    url: "http://localhost/settings/slack-settings",
  });
  dom.window.eval(
    integrationsBundle +
      ";window.ui=integrationsUI;ui.mountCards();ui.configure({api:async()=>({ok:true,data:" +
      JSON.stringify(data) +
      '}),orgScope:()=>"org:test",connectorName:x=>x});',
  );
  await dom.window.eval("ui.loadSlackInstallation()");
  const result = (id: string) => dom.window.document.getElementById(id) as any;
  test.after(() => dom.window.close());
  return result;
}

test("public QM leads with manifest setup and hides hosted actions and instructions", async () => {
  const el = await render({
    configured: false,
    source: "none",
    createUrl: "https://api.slack.com/apps?manifest_json=test",
  });
  assert.equal(el("slack-installation-start").classList.contains("hidden"), true);
  assert.equal(el("slack-own-app-guide").open, true);
  assert.equal(el("slack-own-app-label").textContent.trim(), "Set up Slack");
  assert.equal(el("slack-hosted-switch").classList.contains("hidden"), true);
  assert.match(el("slack-installation-description").textContent.trim(), /manifest/);
  assert.match(el("slack-installation-create").href, /manifest_json/);
});

test("hosted connection offers re-add and keeps custom setup secondary", async () => {
  const el = await render({
    configured: true,
    source: "service",
    installAvailable: true,
    teamName: "Development Acme",
  });
  assert.equal(el("slack-installation-start-label").textContent.trim(), "Re-add to Slack");
  assert.equal(el("slack-installation-start").disabled, false);
  assert.equal(el("slack-installation-state").textContent.trim(), "Development Acme");
  assert.equal(el("slack-own-app-label").textContent.trim(), "Use your own Slack app");
  assert.equal(el("slack-own-app-guide").open, false);
});

test("custom connection cannot be replaced by hosted OAuth without disconnecting", async () => {
  const el = await render({ configured: true, source: "admin", installAvailable: true });
  assert.equal(el("slack-installation-start").disabled, true);
  assert.equal(el("slack-installation-description").textContent.trim(), "Custom app");
});

test("managed credentials alone do not block retry of an unfinished route activation", async () => {
  const dom = new JSDOM('<template data-integrations-card="card-slack-installation"></template>', {
    runScripts: "outside-only",
    url: "http://localhost/settings/slack-settings?slack=install",
  });
  try {
    dom.window.eval(
      integrationsBundle +
        ';window.ui=integrationsUI;window.methods=[];ui.mountCards();ui.configure({api:async(method)=>{methods.push(method);return {ok:true,data:{configured:true,source:"service",installAvailable:true,setup:{connected:false}}}},orgScope:()=>"org:test"});',
    );
    await dom.window.eval("ui.loadSlackInstallation()");
    assert.deepEqual(JSON.parse(String(dom.window.eval("JSON.stringify(methods)"))), ["GET", "POST"]);
  } finally {
    dom.window.close();
  }
});
