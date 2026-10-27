import assert from "node:assert/strict";
import test from "node:test";
import { artifactsFixture, tick } from "../support/admin-artifacts.ts";

test("pack registration draft is collected from state with advanced fields", async () => {
  const { dom, root, c, skills } = artifactsFixture();
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true };
  };
  skills.packs(root, [], c);
  const fields = root.querySelectorAll<HTMLInputElement>("input");
  for (const [i, value] of ["https://example.com/skills", "main", "private/*, drafts/*", "deploy-token"].entries()) {
    fields[i].value = value;
    fields[i].dispatchEvent(new dom.window.Event("input"));
  }
  assert.match(root.querySelector(".linkish")!.textContent!, /Advanced •/);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Register")!.click();
  await tick();
  assert.equal(calls[0][2].ref, "main");
  assert.equal(JSON.stringify(calls[0][2].config.exclude), '["private/*","drafts/*"]');
  dom.window.close();
});

test("pack selection follows target scopes and supports partial imports", async () => {
  const { dom, root, c, skills } = artifactsFixture();
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return args[0] === "GET"
      ? {
          ok: true,
          data: {
            candidates: [
              { upstreamName: "a", eligible: true, importedScopes: ["org:acme"] },
              { upstreamName: "b", eligible: true, importedScopes: [] },
            ],
          },
        }
      : { ok: true, data: { imported: [] } };
  };
  c.scopeRows = () => [{ scopeId: "personal:alice" }];
  await skills.browsePack({ id: "pack", url: "example" }, root, c);
  assert.equal(root.querySelector<HTMLInputElement>('[data-name="a"]')!.disabled, true);
  root.querySelector<HTMLButtonElement>(".scopepick .rowbtn")!.click();
  root.querySelector<HTMLButtonElement>('.scope-option[title="personal:alice"]')!.click();
  assert.equal(root.querySelector<HTMLInputElement>('[data-name="a"]')!.disabled, false);
  const b = root.querySelector<HTMLInputElement>('[data-name="b"]')!;
  b.checked = false;
  b.dispatchEvent(new dom.window.Event("change"));
  [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Import selected")!.click();
  await tick();
  const post = calls.find((args) => args[0] === "POST");
  assert.equal(JSON.stringify(post[2].selected), '["a"]');
  assert.equal(JSON.stringify(post[2].scopeIds), '["org:acme","personal:alice"]');
  dom.window.close();
});

test("skill removal network failures keep the current view and report an error", async () => {
  const { dom, c, skills } = artifactsFixture();
  let reloads = 0;
  let message = "";
  dom.window.confirm = () => true;
  dom.window.alert = (value) => {
    message = String(value);
  };
  c.reload = () => {
    reloads++;
  };
  c.api = async () => {
    throw new Error("offline");
  };
  await skills.removeSkill({ id: "skill", ownerScopeId: c.scope }, c);
  assert.equal(reloads, 0);
  assert.equal(message, "Could not remove skill.");
  dom.window.close();
});

test("pack registration preserves newer edits after its request completes", async () => {
  const { dom, root, c, skills } = artifactsFixture();
  let complete: (value: any) => void = () => {};
  let reloads = 0;
  c.reload = () => {
    reloads++;
  };
  c.api = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  skills.packs(root, [], c);
  const input = root.querySelector<HTMLInputElement>("input")!;
  input.value = "https://example.com/submitted";
  input.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Register")!.click();
  input.value = "https://example.com/newer";
  input.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true });
  await tick();
  assert.equal(root.querySelector<HTMLInputElement>("input")!.value, "https://example.com/newer");
  assert.equal(reloads, 0);
  assert.match(root.querySelector(".status")!.textContent!, /newer changes/);
  dom.window.close();
});
