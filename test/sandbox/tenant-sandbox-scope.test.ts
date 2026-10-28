import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantSandboxPrefix } from "../../plugins/chassis/src/tenant-settings.ts";
import { registerTenantSettings, tenantFor, withTenant } from "../../src/tenant.ts";
import { tenantConfig } from "../../src/tenants/tenant-config.ts";
import { createModalSandbox, MODAL_BODIES } from "../../src/sandbox/modal-sandbox.ts";
import { createSpritesSandbox, SPRITES_BODIES } from "../../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { loadConfig } from "../../src/config.ts";
import { scopeId } from "../../src/types.ts";
import { installFakeModal } from "../support/fake-modal.ts";
import { installFakeSprites, FAKE_SPRITES_TOKEN } from "../support/fake-sprites.ts";
import { testAdvisoryLock, testSandboxBodies } from "../support/test-database.ts";

const guestId = randomUUID();
const guest = tenantFor("org-guest", guestId, "guest");
registerTenantSettings([
  {
    id: guestId,
    slug: "guest",
    orgId: "org-guest",
    hosts: ["guest.example.test"],
    status: "active",
    oidcAdmin: false,
    secrets: {},
  },
]);
after(() => registerTenantSettings([]));

const config = loadConfig({
  SANDBOX_NAME_PREFIX: "qm-deploy",
});
const guestPrefix = tenantSandboxPrefix("qm-deploy", guestId);
const scope = scopeId("personal", "shared@example.com");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const workspace = () => createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "tenant-scope-ws-")));

test("a non-home tenant's Modal sandboxes are named under the deployment prefix and its tenant hash", async () => {
  const fake = installFakeModal();
  after(() => fake.cleanup());
  const sandbox = createModalSandbox(workspace(), {
    store: testSandboxBodies(MODAL_BODIES),
    advisoryLock: testAdvisoryLock(),
    client: fake.client,
    tenantConfig: () => tenantConfig(config),
  });
  const home = await sandbox.provision(layers);
  const forGuest = await withTenant(guest, () => sandbox.provision(layers));
  assert.match(home.id, /^qm-deploy-personal-/);
  assert.ok(forGuest.id.startsWith(`${guestPrefix}-personal-`));
  const sandboxId = fake.current(forGuest.id)!.sandboxId;
  assert.equal(fake.tagsOf(sandboxId)["qm-org"], "org-guest");
  assert.equal(fake.tagsOf(sandboxId)["qm-prefix"], guestPrefix);
});

test("a non-home tenant's sprites are named under the deployment prefix and its tenant hash", async () => {
  const fake = installFakeSprites();
  after(() => fake.cleanup());
  const sandbox = createSpritesSandbox(workspace(), {
    store: testSandboxBodies(SPRITES_BODIES),
    advisoryLock: testAdvisoryLock(),
    token: FAKE_SPRITES_TOKEN,
    baseUrl: fake.baseUrl,
    tenantConfig: () => tenantConfig(config),
  });
  const home = await sandbox.provision(layers);
  const forGuest = await withTenant(guest, () => sandbox.provision(layers));
  assert.match(home.id, /^qm-deploy-personal-/);
  assert.ok(forGuest.id.startsWith(`${guestPrefix}-personal-`));
  assert.deepEqual(fake.names().sort(), [home.id, forGuest.id].sort());
});
