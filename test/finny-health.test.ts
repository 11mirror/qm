import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createServer } from "../src/api/server.ts";
import { readFinnyHealth, type FinnyCredentialMetadataReader } from "../src/finny/health.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

function reader(values: Record<string, { enabled: boolean; secret?: string }>): FinnyCredentialMetadataReader {
  return {
    async listServiceCredentials() {
      return Object.entries(values).map(([slug, value]) => ({
        slug,
        name: slug,
        delivery: "broker",
        host: `${slug}.internal`,
        deployments: false,
        enabled: value.enabled,
        hasSecret: Boolean(value.secret),
        updatedAt: 1,
      }));
    },
  };
}

test("Finny health separates credential configuration from untested connectivity", async () => {
  const status = await readFinnyHealth({
    credentialReader: reader({
      "finny-netsuite": { enabled: true, secret: "never-return-this" },
      "finny-hindsight": { enabled: false, secret: "also-never-return-this" },
    }),
    orgScopeId: "org:test",
  });

  assert.deepEqual(status, {
    configuration: "configured",
    dependencies: {
      netsuite: { required: true, presence: "configured_enabled", connectivity: "not_checked" },
      hindsight: { required: false, presence: "configured_disabled", connectivity: "not_checked" },
    },
  });
  assert.equal(JSON.stringify(status).includes("never-return-this"), false);
});

test("Finny health blocks configuration only when required NetSuite is absent", async () => {
  const status = await readFinnyHealth({
    credentialReader: reader({ "finny-hindsight": { enabled: true, secret: "secret" } }),
    orgScopeId: "org:test",
  });

  assert.equal(status.configuration, "blocked_external");
  assert.deepEqual(status.dependencies.netsuite, {
    required: true,
    presence: "not_configured",
    connectivity: "not_checked",
  });
  assert.deepEqual(status.dependencies.hindsight, {
    required: false,
    presence: "configured_enabled",
    connectivity: "not_checked",
  });
});

test("Finny health distinguishes an unavailable credential store from missing credentials", async () => {
  const status = await readFinnyHealth({ orgScopeId: "org:test" });

  assert.equal(status.configuration, "blocked_external");
  assert.equal(status.dependencies.netsuite.presence, "credential_store_unavailable");
  assert.equal(status.dependencies.hindsight.presence, "credential_store_unavailable");
  assert.equal(status.dependencies.netsuite.connectivity, "not_checked");
});

test("Finny health rejects an unauthenticated HTTP request", async (t) => {
  const built = buildApp(testConfig({ signingSecret: "finny-health-secret".repeat(3) }));
  const server = createServer(built.app, { signingSecret: "finny-health-secret".repeat(3) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await built.runtime.stop();
  });

  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/finny/health`);
  assert.equal(response.status, 401);
});
