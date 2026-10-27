import { createIdempotencyStore, type IdempotencyRecord } from "../idempotency/idempotency-store.ts";
import { type RecentDmPosts, rememberDmPost } from "../surfaces/recent-dm-posts.ts";
import { createOutbound, type QueuedPost, createWebSender } from "../surfaces/outbound.ts";
import { scopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { createSlackSurface } from "../chat-surface/slack.ts";
import { createSurfaceRegistry } from "../chat-surface/registry.ts";
import { createHttpChatSurface } from "../chat-surface/http-chat.ts";
import type { Config } from "../config.ts";
import type { Stores } from "./stores.ts";
import type { Runs } from "./runs.ts";
import type { Late } from "./late.ts";

export function buildOutbound(
  w: Pick<Stores, "artifactMap" | "pgArtifactMap" | "sessions"> &
    Pick<Runs, "sessionStateBus"> & { config: Config; late: Late },
) {
  const { artifactMap, sessions, sessionStateBus, config, late, pgArtifactMap } = w;

  const idempotency = createIdempotencyStore(artifactMap<IdempotencyRecord>("idempotency"));
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
  outbound.register(["web"], createWebSender(transcripts));
  const slackSurface = createSlackSurface();
  const chatSurfaces = createSurfaceRegistry({
    surfaces: [
      slackSurface,
      ...(config.chatSurfaces ?? []).map((surface) =>
        createHttpChatSurface(surface, { mirror: (events) => late.app.ingestSurfaceEvents(events, surface.surface) }),
      ),
    ],
    outbound,
    turn: (request) => late.app.turn(request),
  });
  pgArtifactMap.pool.registerMigration({
    id: "delivery/store/0007-drop",
    statements: ["DROP TABLE IF EXISTS deliveries"],
  });
  return { outbound, chatSurfaces, recentDmPosts, slackSurface, idempotency };
}

export type OutboundModule = ReturnType<typeof buildOutbound>;
