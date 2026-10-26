import type { DurableMap } from "../persistence/durable-map.ts";
import { createOneTimeStore, type OneTimeResult } from "../persistence/one-time-store.ts";
import type { Destination, ScopeId } from "../types.ts";
import type { GrantMode } from "./keychain.ts";
import { swallowAs } from "../util/errors.ts";

export interface SecretDropField {
  key: string;
  label?: string;
  secret?: boolean;
}

export interface SecretDropRecord {
  ownerId: string;
  orgId?: string;
  service: string;
  envKey?: string;
  host?: string;
  fields?: SecretDropField[];
  purpose: string;
  requestedBy: string;
  audienceScopeId?: ScopeId;
  scopeVersion?: string;
  grantMode?: GrantMode;
  destination?: Destination;
  threadRef?: string;
  requiresToken?: boolean;
  createdAt: number;
}

type SecretDropResult = OneTimeResult<SecretDropRecord>;

export interface SecretDropStore {
  mint(rec: Omit<SecretDropRecord, "createdAt">, now?: number): Promise<{ dropId: string }>;
  peek(dropId: string, now?: number): Promise<SecretDropResult>;
  redeem(dropId: string, now?: number): Promise<SecretDropResult>;
  siblings(rec: SecretDropRecord, now?: number): Promise<SecretDropRecord[]>;
}

export const SECRET_DROP_TTL_MS = 7 * 24 * 60 * 60_000;

export function createSecretDropStore(
  backing: DurableMap<SecretDropRecord>,
  opts: { ttlMs?: number; now?: () => number } = {},
): SecretDropStore {
  const ttl = opts.ttlMs ?? SECRET_DROP_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  const drops = createOneTimeStore(backing, ttl, clock);
  return {
    ...drops,
    mint: async (rec, now) => ({ dropId: await drops.mint(rec, now) }),
    async siblings(rec, now) {
      const at = now ?? clock();
      const out: SecretDropRecord[] = [];
      for (const [id, r] of await backing.entries()) {
        if (at - r.createdAt > ttl) {
          void backing.delete(id).catch(swallowAs("secret drop: delete expired drop", undefined));
          continue;
        }
        if (
          r.orgId === rec.orgId &&
          r.audienceScopeId === rec.audienceScopeId &&
          r.threadRef === rec.threadRef &&
          r.service !== rec.service
        )
          out.push(r);
      }
      return out;
    },
  };
}
