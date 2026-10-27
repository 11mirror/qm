import "./auto-fake-sprites.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./build-app.ts";
import type { TurnRequest } from "../../src/types.ts";
import { testConfig } from "./test-config.ts";
import type { SecurityScreener } from "../../src/security/security-screener.ts";

export function freshApp(securityScreener?: SecurityScreener) {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-wake-"));
  return buildApp(testConfig({ dataDir }), securityScreener ? { securityScreener } : {});
}

export const actor = { externalId: "U1" };
export function mention(text: string, channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    deliveryTarget: `slack:${channel}:${root}`,
    text,
    async: true,
    origin: { kind: "human" },
  };
}

export function overheard(text: string, channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U2" },
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    deliveryTarget: `slack:${channel}:${root}`,
    text,
    async: true,
    origin: { kind: "ambient", live: true },
  };
}

export function dm(text: string, channel: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "dm", threadRef: `dm:${channel}`, audience: [actor] },
    deliveryTarget: `slack:${channel}`,
    text,
    async: true,
    origin: { kind: "human" },
  };
}

// A web turn. Web is deliberately excluded from core-side mid-turn steering: on web a mid-turn
// message QUEUES by default — it is submitted as its own turn and waits for the session lock —
// and steering is a separate, explicit act on the queued row. So a turn that reaches core mid-run
// must stay a real second run; folding it into the live one would be the bug.
export function web(text: string, threadRef: string): TurnRequest {
  return {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef, audience: [actor] },
    text,
    async: true,
    origin: { kind: "human" },
  };
}

export function spawnedWorker(channel: string, askTs: string): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "jordan@acme.test", displayName: "Jordan" },
    conversation: { kind: "channel", threadRef: `slack:${channel}:ambient:${askTs}`, channelRef: channel },
    deliveryTarget: channel,
    text: "can you check the deploy?",
    surfaceTools: true,
    async: true,
    spawned: true,
    idempotencyKey: `ambient:acme:slack:${channel}:${askTs}`,
    origin: { kind: "human", messageTs: askTs },
  };
}
