import "../../../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInsecureTestServer } from "../../../../src/api/server.ts";
import { buildApp } from "../../../support/build-app.ts";
import { testConfig } from "../../../support/test-config.ts";
import { listenLocal } from "../../../support/listen-local.ts";
import { start, get, getJson } from "../../../support/admin-observability.ts";

test("session deep links resolve by id even when the scope filter does not match", async () => {
  const s = start();
  try {
    const sess = await s.built.sessions.getOrCreateByThread("dm:U9:t1", "dm", "personal:U9");
    const mismatched = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(sess.id)}?scope=${encodeURIComponent("personal:someone-else")}`,
    );
    assert.equal(mismatched.status, 200, "a stale or mismatched scope param cannot break a session link");
    const body = (await mismatched.json()) as any;
    assert.equal(body.session.id, sess.id);
    assert.equal(body.session.scopeId, "personal:U9");

    const llm = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(sess.id)}/llm?scope=${encodeURIComponent("personal:someone-else")}`,
    );
    assert.equal(llm.status, 200);
  } finally {
    await s.close();
  }
});

test("the Files view is the document store (write-tool artifacts), not the sandbox backup", async () => {
  const built = buildApp(testConfig());
  const scope = "channel:C_FILE_FIXTURE";
  await built.files.put({
    id: "deck-1",
    ownerScopeId: scope,
    createdBy: "U1",
    name: "slides.pdf",
    path: "decks/slides.pdf",
    mimetype: "application/pdf",
    data: Buffer.from("%PDF-1.4 deck"),
    direction: "out",
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    runs: built.runs,
    workspace: built.workspace,
    files: built.files,
    sandboxBackend: "sprites",
  });
  const base = listenLocal(server);
  try {
    const list = await getJson(base, `/v1/admin/files?scope=${encodeURIComponent(scope)}`);
    const names = (list.files as { name: string }[]).map((f) => f.name);
    assert.deepEqual(names, ["slides.pdf"], "the document is listed; the sandbox backup is never flattened into Files");
    const doc = list.files[0] as { mimetype: string; scopeId: string; openable: boolean };
    assert.equal(doc.mimetype, "application/pdf");
    assert.equal(doc.scopeId, scope);
    assert.ok(doc.openable);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("the files listing filters by name server-side with q", async () => {
  const s = start();
  const scope = "org:default-org";
  const doc = (id: string, name: string) => ({
    id,
    ownerScopeId: scope,
    createdBy: "U1",
    name,
    path: `notes/${name}`,
    mimetype: "text/plain",
    data: Buffer.from(name),
    direction: "out" as const,
  });
  try {
    await s.built.files.put(doc("q-art-1", "Quarterly Report.pdf"));
    await s.built.files.put(doc("q-art-2", "notes.txt"));
    await s.built.files.put(doc("q-art-3", "report-draft.txt"));

    const hit = await getJson(s.base, `/v1/admin/files?scope=${encodeURIComponent(scope)}&q=REPORT`);
    assert.deepEqual(
      (hit.files as { name: string }[]).map((f) => f.name).sort(),
      ["Quarterly Report.pdf", "report-draft.txt"],
      "q matches names case-insensitively",
    );
    const miss = await getJson(s.base, `/v1/admin/files?scope=${encodeURIComponent(scope)}&q=missing`);
    assert.deepEqual(miss.files, []);
    const all = await getJson(s.base, `/v1/admin/files?scope=${encodeURIComponent(scope)}&q=`);
    assert.equal((all.files as unknown[]).length, 3, "a blank q lists everything");
  } finally {
    await s.close();
  }
});

test("a saved document is read and downloaded by artifact id", async () => {
  const built = buildApp(testConfig());
  const scope = "personal:U1";
  await built.files.put({
    id: "csv-1",
    ownerScopeId: scope,
    createdBy: "U1",
    name: "report.csv",
    path: "reports/report.csv",
    mimetype: "text/csv",
    data: Buffer.from("a,b\n1,2"),
    direction: "out",
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    runs: built.runs,
    workspace: built.workspace,
    files: built.files,
    sandboxBackend: "sprites",
  });
  const base = listenLocal(server);
  try {
    const list = await getJson(base, `/v1/admin/files?scope=${encodeURIComponent(scope)}`);
    const f = (list.files as { id: string; name: string }[]).find((x) => x.name === "report.csv")!;
    assert.ok(f, "the document is listed for its owning scope");
    const read = await getJson(base, `/v1/admin/files/read?id=${encodeURIComponent(f.id)}`);
    assert.equal(read.content, "a,b\n1,2", "content is served from the document store");
    const download = await get(base, `/v1/admin/files/download?id=${encodeURIComponent(f.id)}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /report\.csv/);
    assert.equal(
      Buffer.from(await download.arrayBuffer()).toString("utf8"),
      "a,b\n1,2",
      "bytes are downloadable by id",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("admin observability enforces scope grants (authz is the boundary)", async () => {
  const s = start();
  try {
    const UMA = { "x-admin-actor": "user-uma@default-org" };
    assert.equal((await get(s.base, "/v1/admin/sessions?scope=org:default-org", UMA)).status, 403);
    assert.equal(
      (await get(s.base, "/v1/admin/runs?scope=org:default-org", { "x-admin-actor": "nobody@default-org" })).status,
      403,
    );
    assert.equal((await get(s.base, "/v1/admin/files")).status, 400);
    assert.equal((await get(s.base, "/v1/admin/sessions/does-not-exist?scope=org:default-org")).status, 404);
  } finally {
    await s.close();
  }
});
