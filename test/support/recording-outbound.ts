import { createOutbound, type Outbound, type OutboundPost } from "../../src/surfaces/outbound.ts";

const SURFACES = ["slack", "group", "principal"] as const;

export interface PostLog {
  posts: OutboundPost[];
  pending(type: string): Promise<OutboundPost[]>;
  waitFor(match: (post: OutboundPost) => unknown): Promise<OutboundPost>;
}

export function recordSurfacePosts(outbound: Pick<Outbound, "register">, types: readonly string[] = SURFACES): PostLog {
  const posts: OutboundPost[] = [];
  const waiters = new Set<() => void>();
  outbound.register(types, async (post) => {
    posts.push(post);
    for (const wake of waiters) wake();
  });
  return {
    posts,
    pending: async (type) => posts.filter((p) => p.destination.type === type),
    waitFor: (match) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const hit = posts.find(match);
          if (!hit) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          const seen = posts.map((p) => JSON.stringify(p.text)).join(", ");
          reject(new Error(`no matching post within 15s; posts so far: [${seen}]`));
        }, 15_000);
        waiters.add(check);
        check();
      }),
  };
}

export function recordingOutbound(types: readonly string[] = [...SURFACES, "web"]): Outbound & PostLog {
  const sent = new Set<string>();
  const once = async (key: string, fn: () => Promise<void>) => {
    if (sent.has(key)) return false;
    sent.add(key);
    await fn();
    return true;
  };
  const outbound = createOutbound({ idempotency: { once } });
  return Object.assign(outbound, recordSurfacePosts(outbound, types));
}
