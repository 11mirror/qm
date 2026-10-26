import { createOutbound, type Outbound, type OutboundPost } from "../../src/surfaces/outbound.ts";

const SURFACES = ["slack", "group", "principal"] as const;

export interface PostLog {
  posts: OutboundPost[];
  pending(type: string): Promise<OutboundPost[]>;
}

export function recordSurfacePosts(outbound: Pick<Outbound, "register">, types: readonly string[] = SURFACES): PostLog {
  const posts: OutboundPost[] = [];
  outbound.register(types, async (post) => {
    posts.push(post);
  });
  return { posts, pending: async (type) => posts.filter((p) => p.destination.type === type) };
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
