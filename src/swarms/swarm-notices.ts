import type { SessionMailbox } from "../sessions/session-mailbox.ts";
import { mapBounded } from "../util/async.ts";
import { reportFailureAs } from "../util/errors.ts";
import { xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import type { StrandedSwarmPost, SwarmBoard, SwarmBoardPost, SwarmNoticeContext } from "./swarm-board.ts";

const NOTICE_CHARS = 2_000;
const NOTIFY_CONCURRENCY = 8;
const SWEEP_PAGE = 200;
const NOTIFY_GRACE_MS = 60_000;

export interface SwarmNoticeDeps {
  board: Pick<SwarmBoard, "subscribers" | "markNotified">;
  mailbox: Pick<SessionMailbox, "send">;
}

function renderNotice(swarmId: string, post: SwarmBoardPost): string {
  const body =
    post.body.length > NOTICE_CHARS ? `${post.body.slice(0, NOTICE_CHARS)}… [read_post for the rest]` : post.body;
  return [
    `<swarm-board-post swarm="${swarmId}" channel="${xmlAttrEscape(post.channel)}" postId="${post.id}"${
      post.threadId ? ` replyTo="${post.threadId}"` : ""
    } from="${xmlAttrEscape(post.authorName)}" fromSessionId="${post.authorId}">`,
    xmlEscape(body),
    "</swarm-board-post>",
  ].join("\n");
}

export async function notifySubscribers(
  deps: SwarmNoticeDeps,
  ctx: SwarmNoticeContext,
  post: SwarmBoardPost,
): Promise<number> {
  const notice = renderNotice(post.swarmId, post);
  const notified = (await deps.board.subscribers(post.swarmId, post.channel)).filter((id) => id !== post.authorId);
  await mapBounded(notified, NOTIFY_CONCURRENCY, (recipientId) =>
    deps.mailbox.send({
      id: `swarm-post-${post.id}-${recipientId}`,
      recipientId,
      senderId: post.authorId,
      actor: ctx.actor,
      text: notice,
      audience: ctx.audience,
      createdAt: post.createdAt,
    }),
  );
  await deps.board.markNotified(post.swarmId, post.id);
  return notified.length;
}

export interface SwarmNoticeSweep {
  sweep(now?: number): Promise<number>;
}

export function createSwarmNoticeSweep(
  deps: SwarmNoticeDeps & { board: Pick<SwarmBoard, "stranded"> },
): SwarmNoticeSweep {
  async function redeliver(post: StrandedSwarmPost): Promise<number> {
    const notified = await notifySubscribers(deps, post.notice, post);
    console.error(`[swarm] post ${post.id} on board ${post.swarmId} still owed ${notified} notice(s) — delivered them`);
    return notified;
  }
  return {
    async sweep(now = Date.now()) {
      const before = now - NOTIFY_GRACE_MS;
      let cursor = { createdAt: 0, id: "" };
      let recovered = 0;
      for (;;) {
        const batch = await deps.board.stranded(cursor, before, SWEEP_PAGE);
        for (const post of batch)
          recovered += await redeliver(post).catch(
            reportFailureAs("swarm: redeliver stranded notices (the sweep retries)", 0, `post=${post.id}`),
          );
        const last = batch.at(-1);
        if (!last || batch.length < SWEEP_PAGE) return recovered;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
    },
  };
}
