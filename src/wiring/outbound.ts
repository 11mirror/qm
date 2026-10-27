import type { Head } from "./late.ts";
import { createIdempotencyStore } from "../idempotency/idempotency-store.ts";
import { type RecentDmPosts, rememberDmPost } from "../surfaces/recent-dm-posts.ts";
import { createOutbound, type QueuedPost, createWebSurface } from "../surfaces/outbound.ts";
import { scopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { createSlackSurface } from "../surfaces/slack-surface.ts";
import { createSurfaceRegistry } from "../surfaces/registry.ts";
import { createHttpChatSurface } from "../surfaces/http-chat.ts";
import type { StoresModule } from "./stores.ts";
import type { RunsModule } from "./runs.ts";

export function buildOutbound(w: Head & StoresModule & RunsModule) {
  const { artifactMap, databaseUrl, sessions, sessionStateBus, config, late } = w;

  const idempotency = createIdempotencyStore(databaseUrl);
  const transcripts = { sessions, sessionStates: sessionStateBus };
  const recentDmPosts = artifactMap<RecentDmPosts>("recent_dm_posts");
  const outbound = createOutbound({
    idempotency,
    retries: artifactMap<QueuedPost>("queued_posts"),
    afterSend: (post, receipt) => {
      const recipientId = post.destination.target;
      const threadRef = receipt.recipientThreadRef;
      if (post.destination.type !== "principal" || !threadRef) return;
      void (async () => {
        const session = await sessions.getOrCreateByThread(
          threadRef,
          "dm",
          scopeId("personal", recipientId),
          undefined,
          "slack",
        );
        await sessions.addParticipant(session.id, recipientId);
        await rememberDmPost(recentDmPosts, threadRef, {
          key: post.idempotencyKey,
          text: post.text,
          at: Date.now(),
          ...(post.destination.onBehalfOf ? { onBehalfOf: post.destination.onBehalfOf } : {}),
          ...(post.provenance?.trigger ? { trigger: post.provenance.trigger } : {}),
        });
      })().catch(swallowAs("outbound: remember DM post", undefined));
    },
  });
  const slackSurface = createSlackSurface();
  const chatSurfaces = createSurfaceRegistry({
    surfaces: [
      createWebSurface(transcripts),
      slackSurface,
      ...(config.chatSurfaces ?? []).map((surface) =>
        createHttpChatSurface(surface, { mirror: (events) => late.app.ingestSurfaceEvents(events, surface.surface) }),
      ),
    ],
    outbound,
    turn: (request) => late.app.turn(request),
  });
  return { outbound, chatSurfaces, recentDmPosts, slackSurface, idempotency };
}

export type OutboundModule = ReturnType<typeof buildOutbound>;
