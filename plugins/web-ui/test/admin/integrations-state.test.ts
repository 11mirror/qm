import assert from "node:assert/strict";
import test from "node:test";
import { configure, ConnectorsState, SlackInstallationState } from "../../src/admin/integrations-state.ts";

const configureApi = (api: Parameters<typeof configure>[0]["api"]) =>
  configure({ save: () => {}, orgScope: () => "org:test", connectorName: (x) => x, api });

test("Connector saves use captured payloads and retain edits made during a request", async () => {
  let resolve!: (value: any) => void;
  const bodies: unknown[] = [];
  configureApi(async (method, _path, body) => {
    if (method === "PUT") {
      bodies.push(body);
      return new Promise((r) => (resolve = r));
    }
    return { ok: true, data: { catalog: [], connectors: [] } };
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
  configureApi(() => new Promise((r) => pending.push(r)));
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
  configureApi(async () => {
    called = true;
    return { ok: true, data: {} };
  });
  const s = new SlackInstallationState();
  s.botToken = "xoxb-example";
  await s.save();
  assert.equal(called, false);
  assert.equal(s.message, "Both Slack tokens are required.");
});
