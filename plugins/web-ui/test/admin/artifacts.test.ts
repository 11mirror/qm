import assert from "node:assert/strict";
import test from "node:test";
import { artifactsFixture, tick } from "../support/admin-artifacts.ts";

test("memory edits one fact by id and redraws from the server's facts", async () => {
  const { dom, root, c, ui } = artifactsFixture();
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true, data: { facts: [{ id: "7", text: "edited" }] } };
  };
  ui.memory(root, { facts: [{ id: "7", text: "original" }] }, c);
  [...root.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Edit")!.click();
  const input = root.querySelector("textarea")!;
  input.value = "edited";
  input.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Save")!.click();
  await tick();
  assert.equal(
    JSON.stringify(calls[0]),
    JSON.stringify(["PATCH", "/api/memory?scope=personal%3Aalice", { facts: [{ id: "7", text: "edited" }] }]),
  );
  assert.match(root.querySelector(".memory-facts")!.textContent!, /edited/);
  assert.equal(root.querySelector("#st-memory")!.textContent, "Saved ✓");
  dom.window.close();
});

test("memory adds a new fact and clears the draft", async () => {
  const { dom, root, c, ui } = artifactsFixture();
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true, data: { facts: [{ id: "8", text: "new fact" }] } };
  };
  ui.memory(root, { facts: [] }, c);
  const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="New fact"]')!;
  input.value = "new fact";
  input.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Add")!.click();
  await tick();
  assert.equal(
    JSON.stringify(calls[0]),
    JSON.stringify(["POST", "/api/memory?scope=personal%3Aalice", { facts: ["new fact"] }]),
  );
  assert.match(root.querySelector(".memory-facts")!.textContent!, /new fact/);
  assert.equal(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="New fact"]')!.value, "");
  dom.window.close();
});

test("files search renders from query data and preserves keyboard opening", () => {
  const { dom, root, c, ui } = artifactsFixture();
  let opened = "";
  c.downloadFile = (row: any) => {
    opened = row.id;
  };
  ui.files(
    root,
    {
      files: [
        { id: "a", name: "alpha.txt", createdAt: 1 },
        { id: "b", name: "beta.txt", createdAt: 2 },
      ],
    },
    c,
  );
  c.shell.search.onInput("alpha");
  assert.equal(root.querySelectorAll(".dense-row").length, 1);
  root.querySelector(".dense-row")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(opened, "a");
  c.shell.search.onInput("missing");
  assert.match(root.textContent!, /No files match/);
  dom.window.close();
});

test("scope indexes hide full artifact lists until searching", () => {
  const { dom, root, c, ui } = artifactsFixture();
  c.index = true;
  c.deploymentHref = () => "https://example.com/app";
  ui.deployments(root, { deployments: [{ id: "app", name: "App", ownerScopeId: "personal:alice" }] }, c);
  assert.equal(root.querySelectorAll(".dense-list").length, 2);
  c.shell.search.onInput("App");
  const link = root.querySelector<HTMLAnchorElement>('.dense-row[target="_blank"]')!;
  assert.equal(link.href, "https://example.com/app");
  assert.equal(link.rel, "noopener");
  dom.window.close();
});

test("cron destination draft derives placeholders, disabled fields and API payload", async () => {
  const { dom, root, c, ui } = artifactsFixture();
  c.cron = "job";
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true, data: { sessions: [] } };
  };
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit destination")!.click();
  const select = root.querySelector("select")!;
  select.value = "principal";
  select.dispatchEvent(new dom.window.Event("change"));
  const inputs = root.querySelectorAll<HTMLInputElement>("input");
  assert.equal(inputs[0].placeholder, "principal id");
  assert.equal(inputs[2].disabled, false);
  inputs[0].value = "alice";
  inputs[0].dispatchEvent(new dom.window.Event("input"));
  inputs[2].value = "bob";
  inputs[2].dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.click();
  await tick();
  const put = calls.find((args) => args[0] === "PUT");
  assert.equal(
    JSON.stringify(put[2]),
    JSON.stringify({ destination: { type: "principal", target: "alice", onBehalfOf: "bob" } }),
  );
  dom.window.close();
});

test("stale async cron renders cannot replace a different page", async () => {
  const { dom, root, c, ui } = artifactsFixture();
  c.cron = "job";
  let complete: (value: any) => void = () => {};
  c.api = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  root.replaceChildren(dom.window.document.createTextNode("New page"));
  complete({ ok: true, data: { sessions: [] } });
  await tick();
  assert.equal(root.textContent, "New page");
  dom.window.close();
});

test("cancelled cron destination edits restore the saved destination on reopen", () => {
  const { dom, root, c, ui } = artifactsFixture();
  c.cron = "job";
  ui.crons(
    root,
    {
      crons: [
        { id: "job", title: "Daily", ownerScopeId: c.scope, destination: { type: "principal", target: "alice" } },
      ],
    },
    c,
  );
  const click = (text: string) =>
    [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === text)!.click();
  click("Edit destination");
  assert.equal(root.querySelector("select")!.value, "principal");
  const target = root.querySelector<HTMLInputElement>('input[name="cron-target"]')!;
  target.value = "bob";
  target.dispatchEvent(new dom.window.Event("input"));
  click("Cancel");
  click("Edit destination");
  assert.equal(root.querySelector<HTMLInputElement>('input[name="cron-target"]')!.value, "alice");
  dom.window.close();
});

test("cron destination saves preserve edits made while the request is pending", async () => {
  const { dom, root, c, ui } = artifactsFixture();
  c.cron = "job";
  let complete: (value: any) => void = () => {};
  let reloads = 0;
  c.reload = () => {
    reloads++;
  };
  c.api = async (method: string) =>
    method === "PUT"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : { ok: true, data: { sessions: [] } };
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit destination")!.click();
  const target = root.querySelector<HTMLInputElement>('input[name="cron-target"]')!;
  target.value = "submitted";
  target.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.click();
  target.value = "newer";
  target.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true });
  await tick();
  assert.equal(root.querySelector<HTMLInputElement>('input[name="cron-target"]')!.value, "newer");
  assert.equal(reloads, 0);
  assert.equal(
    [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.disabled,
    false,
  );
  dom.window.close();
});

test("file uploads post through the admin relay with the hash and name in the query", async () => {
  const { dom, c, ui } = artifactsFixture();
  c.apiBase = "/api/admin";
  Object.defineProperty(dom.window, "crypto", { value: globalThis.crypto });
  const sent: Array<{ url: string; init: any }> = [];
  dom.window.fetch = (async (url: string, init: any) => {
    sent.push({ url, init });
    return new dom.window.Response("{}", { status: 200 });
  }) as any;
  const box = ui.uploadBox(c);
  const input = box.querySelector("input[type=file]");
  const file = new dom.window.File(["hello"], "notes é.txt", { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new dom.window.Event("change"));
  for (let i = 0; i < 5 && !sent.length; i++) await tick();
  assert.equal(sent.length, 1);
  const url = new URL(sent[0]!.url, "http://localhost");
  assert.equal(url.pathname, "/api/admin/files/upload");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    scope: "personal:alice",
    sha: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    name: "notes é.txt",
  });
  assert.deepEqual({ ...sent[0]!.init.headers }, { "content-type": "text/plain" });
});
