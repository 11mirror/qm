import "../../../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerDeps } from "../../../../src/api/deps.ts";
import { createInsecureTestServer } from "../../../../src/api/server.ts";
import { cachedModelCatalog, selectableModelCatalog } from "../../../../src/model/model-catalog.ts";
import { serverDeps } from "../../../../src/wiring.ts";
import { buildApp } from "../../../support/build-app.ts";
import { testConfig } from "../../../support/test-config.ts";
import { listenLocal } from "../../../support/listen-local.ts";

function start() {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    config: built.config,
    environments: built.environments,
  });
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE_ADMIN = { "x-admin-actor": "admin-alice@default-org" };
const json = async (r: Response): Promise<any> => r.json();

test("the scope directory starts independent resource reads together", async () => {
  const s = start();
  const gate = Promise.withResolvers<void>();
  const started = new Set<string>();
  const ready = Promise.withResolvers<void>();
  const hold =
    <T>(name: string, read: () => Promise<T>) =>
    async () => {
      started.add(name);
      ready.resolve();
      await gate.promise;
      return read();
    };
  const app = s.built.app;
  app.listCrons = hold("crons", app.listCrons.bind(app));
  app.listDeployments = hold("deployments", app.listDeployments.bind(app));
  app.listSkills = hold("skills", app.listSkills.bind(app));
  app.listEnvironments = hold("environments", app.listEnvironments.bind(app));
  const request = fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN });
  try {
    await ready.promise;
    assert.deepEqual([...started].sort(), ["crons", "deployments", "environments", "skills"]);
  } finally {
    gate.resolve();
    await request;
    await s.close();
  }
});

test("the admin scope directory lists every known scope with labels and counts (powers the picker)", async () => {
  const s = start();
  try {
    const session = await s.built.sessions.getOrCreateByThread("T1", "channel", "channel:C9", "eng");
    await s.built.sessions.addParticipant(session.id, "U1");
    const { lease } = await s.built.sessions.acquireLease(session.id);
    await s.built.sessions.append(lease!, {
      kind: "UserMessage",
      text: "ship the board deck",
    });
    await s.built.sessions.releaseLease(lease!);
    await s.built.app.createCron({
      ownerScopeId: "channel:GONE",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "ping",
    });

    const r = await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN });
    assert.equal(r.status, 200);
    const first = await json(r);
    assert.equal(first.activityAsOf, undefined, "the first read does not wait for session counts");
    assert.equal(first.scopes.find((row: any) => row.scopeId === "channel:C9").sessions, undefined);
    let d = first;
    for (let i = 0; i < 50 && d.activityAsOf === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
      d = await json(await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN }));
    }
    assert.equal(typeof d.activityAsOf, "number", "a later read serves the counts the background refresh computed");
    const byId = new Map(d.scopes.map((row: any) => [row.scopeId, row]));

    assert.ok(byId.has("org:default-org"), "the org scope is always listed");
    assert.ok(byId.has("channel:C9"), "session scopes are listed");
    assert.ok(byId.has("personal:U1"), "every participant gets a personal-scope row");
    assert.ok(byId.has("personal:admin-alice"), "grant holders are listed even if they never spoke");
    assert.ok(byId.has("channel:GONE"), "artifact owners are listed even with no session");

    const c9: any = byId.get("channel:C9");
    assert.equal(c9.label, "#eng", "channel rows carry the human channel name");
    assert.equal(c9.sessions, 1);
    assert.equal(c9.lastMessage, undefined, "the directory carries no message previews");
    const gone: any = byId.get("channel:GONE");
    assert.equal(gone.crons, 1, "rows carry artifact counts");
    assert.equal(gone.sessions, 0);
    assert.equal(d.scopes[0].scopeId, "channel:C9", "most-active scopes sort first");

    assert.equal(
      (await fetch(`${s.base}/v1/admin/scopes`, { headers: { "x-admin-actor": "nobody@default-org" } })).status,
      403,
      "org_admin-only",
    );
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "scopes.read"),
      "the directory read is audited",
    );
  } finally {
    await s.close();
  }
});

test("scopes without a session label fall back to the org directory (people's names, channel names)", async () => {
  const s = start();
  try {
    await s.built.app.upsertDirectory([{ principalId: "U1", displayName: "Uma Ada", type: "internal" }]);
    await s.built.app.upsertChannels([
      { channelId: "C7", name: "random" },
      { channelId: "C8", name: "quiet" },
    ]);
    const session = await s.built.sessions.getOrCreateByThread("T7", "channel", "channel:C7");
    await s.built.sessions.addParticipant(session.id, "U1");
    await s.built.app.createCron({
      ownerScopeId: "channel:C8",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "ping",
    });

    const d = await json(await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN }));
    const byId = new Map(d.scopes.map((row: any) => [row.scopeId, row]));
    assert.equal(
      (byId.get("channel:C7") as any).label,
      "#random",
      "channel labels fall back to the directory channel name",
    );
    assert.equal(
      (byId.get("personal:U1") as any).label,
      "Uma Ada",
      "personal scopes are labelled with the person's display name",
    );
    assert.equal(
      (byId.get("channel:C8") as any).label,
      "#quiet",
      "artifact-only owner scopes get the directory fallback too",
    );
  } finally {
    await s.close();
  }
});

test("the admin scope directory exposes named environments and attached scopes", async () => {
  const s = start();
  try {
    await s.built.app.upsertChannels([
      { channelId: "A", name: "source" },
      { channelId: "B", name: "attached" },
    ]);
    await s.built.app.createEnvironment({ scopeId: "channel:A", name: "A-permanent", actorId: "U1" });
    await s.built.app.attachScope({ scopeId: "channel:B", environmentId: "channel:A", actorId: "U1" });

    const directory = await json(await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN }));
    const byId = new Map(directory.scopes.map((row: any) => [row.scopeId, row]));
    assert.deepEqual(directory.environments, [
      { id: "channel:A", name: "A-permanent", ownerActorId: "U1", attachedScopes: ["channel:B"] },
    ]);
    assert.equal((byId.get("channel:A") as any).environmentName, "A-permanent");
    assert.deepEqual((byId.get("channel:B") as any).environmentAttachment, {
      environmentId: "channel:A",
      environmentName: "A-permanent",
    });

    const attached = await json(await fetch(`${s.base}/v1/admin/scopes/channel:B`, { headers: ALICE_ADMIN }));
    assert.deepEqual(attached.environmentAttachment, {
      environmentId: "channel:A",
      environmentName: "A-permanent",
    });
  } finally {
    await s.close();
  }
});

const ADMIN = { "x-admin-actor": "admin-alice@default-org" };

function settingsLoadStart(overrides: Partial<ServerDeps> = {}) {
  const config = testConfig();
  const built = buildApp(config);
  const deps = { ...serverDeps(config, built), ...overrides };
  const server = createInsecureTestServer(built.app, deps);
  const base = listenLocal(server);
  return { built, deps, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const scopePath = "/v1/admin/scopes/org%3Adefault-org";

async function warm(base: string) {
  await (await fetch(base + scopePath + "?view=customize", { headers: ADMIN })).arrayBuffer();
}

test("settings projections preserve values while excluding unrelated payloads", async (t) => {
  const srv = settingsLoadStart();
  t.after(srv.close);
  await srv.built.config.setSetting("branding", { selfLabel: "Test assistant", accent: "#445566" }, "org:default-org");
  await srv.built.directory.replaceChannels([{ channelId: "C-settings", name: "settings-test" }]);
  const full = (await (await fetch(srv.base + scopePath, { headers: ADMIN })).json()) as Record<string, unknown>;
  for (const view of [
    "customize",
    "governance",
    "models",
    "credentials",
    "connectors",
    "slack-settings",
    "onboarding",
  ]) {
    const response = await fetch(srv.base + scopePath + "?view=" + view, { headers: ADMIN });
    assert.equal(response.status, 200, view);
    const projected = (await response.json()) as Record<string, unknown> & { branding: { selfLabel: string } };
    for (const [key, value] of Object.entries(projected)) assert.deepEqual(value, full[key], view + ":" + key);
    if (view !== "credentials") assert.equal("serviceCredentials" in projected, false, view);
    else
      assert.deepEqual(projected.directoryChannels, [
        { channelId: "C-settings", name: "settings-test", isPrivate: false },
      ]);
    assert.match(response.headers.get("server-timing") ?? "", /authorize;dur=/);
    if (["customize", "credentials", "connectors"].includes(view))
      assert.equal("baseModelOptions" in projected, false, view);
    if (view === "slack-settings") {
      for (const key of ["externalSlackParticipants", "channelHeaderPinDefault", "ackEmoji"])
        assert.equal(key in projected, true);
      assert.equal("orgAmbient" in projected, false);
    }
    if (view === "customize") {
      assert.equal(projected.branding.selfLabel, "Test assistant");
      assert.equal("orgAmbient" in projected, false);
      assert.equal("channelHeaderPinDefault" in projected, false);
      assert.equal("instructionsHistory" in projected, true);
      assert.equal("connectors" in projected, false);
    }
  }
});

test("Customize completes within 500 ms with unrelated model and connector services unavailable", async (t) => {
  const fail = () => {
    throw new Error("Unrelated dependency must not be called");
  };
  const srv = settingsLoadStart({ refreshModels: fail, modelCredentialFetch: fail });
  t.after(srv.close);
  await warm(srv.base);
  t.mock.method(srv.built.config, "listConnectorClients", fail);
  const started = performance.now();
  const response = await fetch(srv.base + scopePath + "?view=customize", { headers: ADMIN });
  assert.equal(response.status, 200);
  assert.equal(typeof ((await response.json()) as { instructions: string }).instructions, "string");
  assert.ok(performance.now() - started < 500);
});

test("each settings projection retains authorization before reading configuration", async (t) => {
  let reads = 0;
  const srv = settingsLoadStart({
    refreshModels: async () => {
      reads++;
    },
  });
  t.after(srv.close);
  t.mock.method(srv.built.config, "refreshScope", async () => {
    reads++;
  });
  for (const view of [
    "customize",
    "governance",
    "models",
    "credentials",
    "connectors",
    "slack-settings",
    "onboarding",
  ]) {
    const response = await fetch(srv.base + scopePath + "?view=" + view, {
      headers: { "x-admin-actor": "nobody@default-org" },
    });
    assert.equal(response.status, 403);
  }
  assert.equal(reads, 0);
  assert.equal((await fetch(srv.base + scopePath + "?view=toString", { headers: ADMIN })).status, 400);
});

test("Models settings do not wait for a cold external model catalog", async (t) => {
  const pending = Promise.withResolvers<Response>();
  const fetcher: typeof fetch = () => pending.promise;
  const srv = settingsLoadStart({ modelCredentialFetch: fetcher });
  t.after(srv.close);
  t.after(() => pending.resolve(Response.json({ data: [] })));
  t.mock.method(srv.built.modelCredentials, "availability", async () => ({
    anthropic: true,
    openai: true,
    openrouter: true,
  }));
  await srv.built.config.setRuntimeSelection("org:default-org", {
    modelId: "settings/previously-saved-model",
  });
  await warm(srv.base);
  const started = performance.now();
  const response = await fetch(srv.base + scopePath + "?view=models", {
    headers: ADMIN,
    signal: AbortSignal.timeout(500),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    baseModelOptions: { id: string }[];
    runtime: { modelId: string };
    modelCatalogRefreshing: boolean;
  };
  assert.ok(body.baseModelOptions.length > 0);
  assert.equal(body.runtime.modelId, "settings/previously-saved-model");
  assert.ok(body.baseModelOptions.some((model) => model.id === body.runtime.modelId));
  assert.equal(body.modelCatalogRefreshing, true);
  assert.ok(performance.now() - started < 500);
});

test("a configured base model the cold catalog cannot resolve stays listed without a guessed provider", async (t) => {
  const pending = Promise.withResolvers<Response>();
  const srv = settingsLoadStart({ modelCredentialFetch: () => pending.promise });
  t.after(srv.close);
  t.after(() => pending.resolve(Response.json({ data: [] })));
  t.mock.method(srv.built.modelCredentials, "availability", async () => ({
    anthropic: true,
    openai: true,
    openrouter: true,
  }));
  for (const modelId of ["settings/saved-base-model", "saved-base-model-without-vendor"]) {
    await srv.built.config.setRuntimeSelection("org:default-org", { modelId });
    const response = await fetch(srv.base + scopePath + "?view=models", { headers: ADMIN });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { baseModelOptions: { id: string; name: string; provider: string }[] };
    assert.deepEqual(
      body.baseModelOptions.find((model) => model.id === modelId),
      { id: modelId, name: `${modelId} (configured)`, provider: "" },
    );
  }
});

test("cached model catalogs refresh in the background and retain dynamic entries after expiry", async (t) => {
  let requests = 0;
  let release = Promise.withResolvers<Response>();
  const fetcher: typeof fetch = () => {
    requests++;
    return release.promise;
  };
  assert.ok(cachedModelCatalog(fetcher).models.length > 0);
  assert.ok(cachedModelCatalog(fetcher).models.length > 0);
  assert.equal(requests, 1);
  release.resolve(
    Response.json({
      data: [
        {
          id: "testing/settings-fast",
          name: "Settings test",
          context_length: 8192,
          pricing: { prompt: "0", completion: "0" },
          top_provider: { max_completion_tokens: 1024 },
          architecture: { input_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    }),
  );
  await selectableModelCatalog(fetcher);
  assert.ok(cachedModelCatalog(fetcher).models.some((m) => m.id === "testing/settings-fast"));
  const later = Date.now() + 6 * 60_000;
  t.mock.method(Date, "now", () => later);
  release = Promise.withResolvers<Response>();
  assert.ok(cachedModelCatalog(fetcher).models.some((m) => m.id === "testing/settings-fast"));
  assert.equal(requests, 2);
  release.reject(new Error("Catalog offline"));
  await selectableModelCatalog(fetcher);
  assert.ok(cachedModelCatalog(fetcher).models.some((m) => m.id === "testing/settings-fast"));
});
