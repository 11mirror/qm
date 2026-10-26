import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId, type ScopeId } from "../src/types.ts";
import { testConfigStore } from "./support/test-database.ts";

const org = scopeId("org", "acme");
const channel = "channel:C123" as ScopeId;
const other = "channel:C456" as ScopeId;

async function freshStore() {
  const store = testConfigStore("acme", {});
  await store.hydrate!();
  return store;
}

test("channel header pin defaults off with no org setting", async () => {
  const store = await freshStore();
  assert.equal(store.setting("channelHeaderPin", channel), false);
  assert.equal(await store.settingDurable("channelHeaderPin", channel), false);
  assert.equal(await store.settingDurable("channelHeaderPin"), false);
});

test("an org default of on applies to channels without an explicit choice", async () => {
  const store = await freshStore();
  await store.setSetting("channelHeaderPin", true, org);
  assert.equal(store.setting("channelHeaderPin", channel), true);
  assert.equal(await store.settingDurable("channelHeaderPin", channel), true);
  assert.equal(await store.settingDurable("channelHeaderPin"), true);
  assert.equal(await store.settingOwnDurable("channelHeaderPin", channel), null);
});

test("an explicit channel off beats an org default of on", async () => {
  const store = await freshStore();
  await store.setSetting("channelHeaderPin", true, org);
  await store.setSetting("channelHeaderPin", false, channel);
  assert.equal(store.setting("channelHeaderPin", channel), false);
  assert.equal(await store.settingDurable("channelHeaderPin", channel), false);
  assert.equal(await store.settingOwnDurable("channelHeaderPin", channel), false);
  // other channels still follow the default
  assert.equal(await store.settingDurable("channelHeaderPin", other), true);
});

test("clearing a channel override reverts it to the org default", async () => {
  const store = await freshStore();
  await store.setSetting("channelHeaderPin", true, org);
  await store.setSetting("channelHeaderPin", false, channel);
  await store.setSetting("channelHeaderPin", null, channel);
  assert.equal(await store.settingDurable("channelHeaderPin", channel), true);
  assert.equal(await store.settingOwnDurable("channelHeaderPin", channel), null);
});

test("changing the org default notifies listeners with the org scope", async () => {
  const store = await freshStore();
  const seen: ScopeId[] = [];
  store.onChannelHeaderPinChanged((id) => seen.push(id));
  await store.setSetting("channelHeaderPin", true, org);
  await store.setSetting("channelHeaderPin", true, channel);
  assert.deepEqual(seen, [org, channel]);
});

test("explicit overrides survive a scope refresh", async () => {
  const store = await freshStore();
  await store.setSetting("channelHeaderPin", true, org);
  await store.setSetting("channelHeaderPin", false, channel);
  await store.refreshScope(channel);
  assert.equal(store.setting("channelHeaderPin", channel), false);
  await store.setSetting("channelHeaderPin", null, channel);
  await store.refreshScope(channel);
  assert.equal(store.setting("channelHeaderPin", channel), true);
});
