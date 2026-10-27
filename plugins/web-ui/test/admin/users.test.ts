import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "../support/admin-fixture.ts";
import { UsersView } from "../../src/admin/users.ts";
function model() {
  const view = Object.create(UsersView.prototype) as UsersView;
  Object.assign(view, {
    pending: new Set(),
    refreshRequest: 0,
    root: { isConnected: true },
    draw: () => {},
    renderShell: () => {},
    data: {},
    email: "first@example.com",
    role: "member",
    inviteOpen: true,
  });
  return view;
}
test("user invitation keeps newer edited fields open when the submitted invitation succeeds", async () => {
  const view = model();
  let resolve!: (value: any) => void;
  view.services = {
    api: async (method: string) => (method === "POST" ? new Promise((r) => (resolve = r)) : { ok: true, data: {} }),
    clearCache: () => {},
  };
  const pending = view.invite();
  view.email = "next@example.com";
  resolve({ ok: true, data: { member: { email: "first@example.com" }, emailSent: true } });
  await pending;
  assert.equal(view.inviteOpen, true);
  assert.equal(view.email, "next@example.com");
});
test("overlapping roster refreshes cannot restore an older snapshot", async () => {
  const view = model();
  const pending: Array<(value: any) => void> = [];
  view.services = { api: () => new Promise((r) => pending.push(r)), clearCache: () => {} };
  const first = view.refresh(),
    second = view.refresh();
  pending[1]({ ok: true, data: { value: "latest" } });
  await second;
  pending[0]({ ok: true, data: { value: "older" } });
  await first;
  assert.equal(view.data.value, "latest");
});

test("roster refresh updates shell counts while retaining search focus and invitation drafts", async () => {
  const f = litFixture();
  const bar = f.document.createElement("div");
  bar.id = "shellbar";
  f.document.body.prepend(bar);
  const shells: any[] = [];
  let data = { users: [], grants: [], externalUsers: [] } as any;
  const view = f.ui.users.users(f.root, data, {
    defaultShell(shell: any) {
      shells.push(shell);
      bar.replaceChildren();
      const search = f.document.createElement("div");
      search.className = "shell-search";
      const input = f.document.createElement("input");
      input.value = shell.search.value;
      input.oninput = () => shell.search.onInput(input.value);
      search.append(input);
      bar.append(search);
    },
    api: async (_method: string, path: string) => ({ ok: true, data: path === "/api/users" ? data : { people: [] } }),
    clearCache() {},
  });
  f.root.querySelector<HTMLButtonElement>('[aria-label="Invite teammate"]')!.click();
  const email = f.root.querySelector<HTMLInputElement>("#users-email")!;
  email.value = "draft@example.com";
  email.dispatchEvent(new f.window.Event("input"));
  const search = bar.querySelector("input")!;
  search.value = "admin";
  search.dispatchEvent(new f.window.Event("input"));
  search.focus();
  search.setSelectionRange(2, 4);
  data = { users: [], grants: [{ role: "org_admin" }], externalUsers: [] };
  await view.refresh();
  view.draw();
  assert.equal(shells.at(-1).stats[1][0], 1);
  assert.equal(bar.querySelector("input"), search);
  assert.equal(f.document.activeElement, search);
  assert.equal(search.value, "admin");
  assert.equal(search.selectionStart, 2);
  assert.equal(search.selectionEnd, 4);
  assert.equal(f.root.querySelector("#users-email"), email);
  assert.equal(email.value, "draft@example.com");
  assert.equal(view.inviteOpen, true);
  bar.replaceChildren(f.document.createTextNode("Another view"));
  await view.refresh();
  assert.equal(bar.textContent, "Another view");
  f.dom.window.close();
});

for (const revoke of [false, true])
  test(`user-row ${revoke ? "revoke" : "promotion"} confirms and sends exact grant target`, async () => {
    const f = litFixture();
    const calls: any[] = [];
    let accepted = false;
    const user = {
      principalId: "alex+admin@example.com",
      admin: { isAdmin: revoke, scopeId: "org:test", role: "org_admin" },
    };
    const controller = f.ui.users.users(
      f.root,
      { users: [user], grants: [{ role: "org_admin" }, { role: "org_admin" }] },
      {
        defaultShell() {},
        orgScope: "org:test",
        confirm: (message: string) => {
          assert.ok(message.includes(user.principalId));
          return accepted;
        },
        clearCache() {},
        api: async (method: string, path: string, body: any) => {
          if (method !== "GET") calls.push([method, path, ...(body ? [body] : [])]);
          return { ok: true, data: path === "/api/users" ? { users: [user], grants: [] } : {} };
        },
      },
    );
    const event = new f.window.Event("click");
    await controller.admin(user, event);
    assert.equal(calls.length, 0);
    accepted = true;
    await controller.admin(user, event);
    assert.deepEqual(
      JSON.parse(JSON.stringify(calls[0])),
      revoke
        ? ["DELETE", "/api/grants/alex%2Badmin%40example.com?scope=org%3Atest&role=org_admin"]
        : ["POST", "/api/grants", { principalId: user.principalId, role: "org_admin", scopeId: "org:test" }],
    );
    assert.equal(controller.pending.size, 0);
    f.dom.window.close();
  });

test("admin promotion and admin invitations require confirmation before making a request", async () => {
  for (const approved of [false, true]) {
    for (const invite of [false, true]) {
      const requests: string[] = [];
      let message = "";
      const view = Object.create(UsersView.prototype) as UsersView;
      Object.assign(view, {
        data: {},
        email: "teammate@example.test",
        role: "org_admin",
        pending: new Set(),
        refreshRequest: 0,
        root: { isConnected: true },
        draw() {},
        renderShell() {},
        services: {
          orgScope: "org:qa",
          confirm(text: string) {
            message = text;
            return approved;
          },
          async api(method: string, path: string) {
            if (method === "POST") requests.push(path);
            return { ok: true, data: { member: { email: "teammate@example.test" }, emailSent: true } };
          },
          clearCache() {},
        },
      });
      if (invite) await view.invite();
      else await view.admin({ principalId: "teammate@example.test" }, { stopPropagation() {} } as Event);
      assert.match(message, /Make teammate@example.test an org admin/);
      assert.match(message, /manage users, permissions, and organization settings/);
      assert.deepEqual(requests, approved ? [invite ? "/api/users/invite" : "/api/grants"] : []);
    }
  }
});

test("teammate invitation form stays in Users and preserves draft through async counts", async () => {
  const f = litFixture();
  let resolve!: (v: any) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const controller = f.ui.users.users(
    f.root,
    { users: [], grants: [], externalUsers: [] },
    { defaultShell() {}, api: () => pending },
  );
  assert.deepEqual(
    [...f.root.querySelectorAll("h2")].map((e) => e.textContent),
    ["Users", "Invitations", "Company access"],
  );
  const invite = f.root.querySelector<HTMLButtonElement>('[aria-label="Invite teammate"]')!;
  invite.click();
  const input = f.root.querySelector<HTMLInputElement>("#users-email")!;
  input.value = "guest@example.com";
  input.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  resolve({ ok: true, data: { people: [] } });
  await pending;
  await Promise.resolve();
  assert.equal(controller.email, "guest@example.com");
  assert.equal(input, f.root.querySelector("#users-email"));
  assert.equal(input.value, "guest@example.com");
  assert.equal(input.closest("section")!.querySelector("h2")!.textContent, "Users");
  f.dom.window.close();
});
