import { perTenant } from "../tenant.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";
import type { StoresModule } from "./stores.ts";
import { hasRows } from "../jobs/job-worker.ts";
import type { RunsModule } from "./runs.ts";
import type { Head } from "./late.ts";
import { createIdempotencyStore } from "../idempotency/idempotency-store.ts";
import { createRecentDmPosts } from "../surfaces/recent-dm-posts.ts";
import { createQueuedPosts } from "../surfaces/queued-posts.ts";
import { createOutbound, createWebSurface, type Outbound } from "../surfaces/outbound.ts";
import { scopeId } from "../types.ts";
import { createSlackSurface } from "../surfaces/slack-surface.ts";
import { createSurfaceRegistry, type SurfaceRegistry } from "../surfaces/registry.ts";
import { createHttpChatSurface } from "../surfaces/http-chat.ts";

type OutboundInputs = Pick<Head, "config" | "late"> & { stores: StoresModule; runs: RunsModule };

export function buildOutbound(deps: OutboundInputs) {
  const { databaseUrl, sessions, every } = deps.stores;
  const { sessionStateBus } = deps.runs;
  const { config, late } = deps;

  const idempotency = createIdempotencyStore(databaseUrl);
  const transcripts = { sessions, sessionStates: sessionStateBus };
  const recentDmPosts = createRecentDmPosts(databaseUrl);
  const retries = createQueuedPosts(databaseUrl);
  const outboundFor = perTenant(() =>
    createOutbound({
      idempotency,
      retries,
      afterSend: async (post, receipt) => {
        const recipientId = post.destination.target;
        const threadRef = receipt.recipientThreadRef;
        if (post.destination.type !== "principal" || !threadRef) return;
        const session = await sessions.getOrCreateByThread(
          threadRef,
          "dm",
          scopeId("personal", recipientId),
          undefined,
          "slack",
        );
        await sessions.addParticipant(session.id, recipientId);
        await recentDmPosts.remember(threadRef, {
          key: post.idempotencyKey,
          text: post.text,
          at: Date.now(),
          ...(post.destination.onBehalfOf ? { onBehalfOf: post.destination.onBehalfOf } : {}),
          ...(post.provenance?.trigger ? { trigger: post.provenance.trigger } : {}),
        });
      },
    }),
  );
  const slackSurface = createSlackSurface();
  const outbound: Outbound = {
    register: (types, sender) => outboundFor().register(types, sender),
    send: (post) => {
      surfacesFor();
      return outboundFor().send(post);
    },
    retryQueued: (now) => {
      surfacesFor();
      return outboundFor().retryQueued(now);
    },
  };
  const surfacesFor = perTenant(() =>
    createSurfaceRegistry({
      surfaces: [
        createWebSurface(transcripts),
        slackSurface,
        ...(tenantConfig(config).chatSurfaces ?? []).map((surface) =>
          createHttpChatSurface(surface, { mirror: (events) => late.app.ingestSurfaceEvents(events, surface.surface) }),
        ),
      ],
      outbound,
      turn: (request) => late.app.turn(request),
    }),
  );
  const chatSurfaces: SurfaceRegistry = {
    get: (name) => surfacesFor().get(name),
    label: (name) => surfacesFor().label(name),
    receives: (name) => surfacesFor().receives(name),
    receive: (name, request) => surfacesFor().receive(name, request),
  };
  every("queued-post-retry", 30_000, () => outbound.retryQueued(), { due: hasRows("queued_posts") });
  return { outbound, chatSurfaces, recentDmPosts, slackSurface, idempotency };
}

export type OutboundModule = ReturnType<typeof buildOutbound>;
