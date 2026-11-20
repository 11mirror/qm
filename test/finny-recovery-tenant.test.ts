import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { runSingleTenantFinnyRecovery } from "../src/finny/runtime-coordinator.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { boundTenant } from "../src/tenants/context.ts";

test("the complete Finny restart recovery pass runs under the boot tenant", async () => {
  const tenant = randomUUID();
  await bindBootTenant(async () => tenant);
  const observed: Array<string | undefined> = [];
  await runSingleTenantFinnyRecovery(async () => {
    observed.push(boundTenant());
    await Promise.resolve();
    observed.push(boundTenant());
  });
  assert.deepEqual(observed, [tenant, tenant]);
});
