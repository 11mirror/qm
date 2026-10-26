import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/v1/surface-config"))
    return void res.end(JSON.stringify({ branding: { selfLabel: "Acme Assistant" }, modelProviderConfigured: true }));
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://127.0.0.1:19995",
  PORTAL_SESSION_SECRET: "page-scene-fixture-secret-at-least-32-characters",
  CORE_ORG_ID: "scene",
  CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}`,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  AUTH_BROKER_UPSTREAM: "",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});

test("portal pages show the desktop harbour scene, served without a session", async () => {
  const scene = await fetch(`${base}/auth/assets/becalmed-off-halfway-rock.webp`);
  assert.equal(scene.status, 200);
  assert.equal(scene.headers.get("content-type"), "image/webp");
  assert.ok((await scene.arrayBuffer()).byteLength > 100_000);

  let page = await fetch(`${base}/auth/signed-out`);
  let html = await page.text();
  for (let i = 0; i < 50 && !html.includes("Acme Assistant"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    page = await fetch(`${base}/auth/signed-out`);
    html = await page.text();
  }
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /img-src 'self'/);
  assert.match(html, /<img src="\/auth\/assets\/becalmed-off-halfway-rock\.webp"/);
  assert.match(html, /<span class="wordmark">Acme Assistant<\/span>/);
  assert.match(html, /<title>Signed out · Acme Assistant<\/title>/);
});
