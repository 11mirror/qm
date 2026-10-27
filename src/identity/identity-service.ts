import type { ActorAssertion, Principal } from "../types.ts";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { canonicalPerson, foldPrincipalId, personIds, personKey } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember } from "./external-members.ts";

interface IdentityProvider {
  resolve(actor: ActorAssertion): Principal;
  classify(externalId: string, isExternalGuest?: boolean): Principal;
}

type DeactivationSource = "manual" | "directory-sync";

interface DeactivationRecord {
  principalId: string;
  source: DeactivationSource;
  at: number;
}

interface DirectorySyncOutcome {
  deactivated: string[];
  reactivated: string[];
}

export interface IdentityService extends IdentityProvider {
  isInternal(p: Principal): boolean;
  audienceIsAllInternal(audience: Principal[]): boolean;
  deactivate(externalId: string, source?: DeactivationSource): Promise<void>;
  deactivationSource(externalId: string): DeactivationSource | undefined;
  reactivate(externalId: string): Promise<void>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  listExternalMembers(): Promise<ExternalMember[]>;
  externalMember(principalId: string): ExternalMember | undefined;
  putExternalMember(m: ExternalMember): Promise<void>;
  removeExternalMember(principalId: string): Promise<void>;
  hydrate(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
}

const DEACTIVATED_PRINCIPALS: TableSpec = {
  table: "deactivated_principals",
  key: "id",
  columns: {
    principalId: { type: "text", required: true },
    source: { type: "text", required: true },
    at: { type: "bigint", required: true },
  },
};

const EXTERNAL_MEMBERS: TableSpec = {
  table: "external_members",
  key: "id",
  columns: {
    email: { type: "text", required: true },
    role: { type: "text", required: true },
    expiresAt: { type: "bigint" },
    kind: { type: "text" },
    inviteId: { type: "text" },
    invitedBy: { type: "text", required: true },
    createdAt: { type: "bigint", required: true },
    updatedAt: { type: "bigint", required: true },
  },
};

export const DEACTIVATED_PRINCIPALS_MIGRATION = mapToTableMigration(
  "identity/deactivated-principals/0001-typed",
  DEACTIVATED_PRINCIPALS,
);
export const EXTERNAL_MEMBERS_MIGRATION = mapToTableMigration("identity/external-members/0001-typed", EXTERNAL_MEMBERS);

const deactivationCodec = tableCodec<DeactivationRecord>(DEACTIVATED_PRINCIPALS);
const memberCodec = tableCodec<ExternalMember>(EXTERNAL_MEMBERS);

export function actorAssertionActive(
  identity: Pick<IdentityService, "classify" | "isInternal">,
  actor: ActorAssertion | undefined,
): boolean {
  return !!actor?.externalId && identity.isInternal(identity.classify(actor.externalId, actor.isExternalGuest));
}

export function createIdentityService(
  databaseUrl: string,
  opts: {
    directorySyncProtected?: readonly string[];
    principalLinks?: { refresh(force?: boolean): Promise<void> };
  } = {},
): IdentityService {
  const { q } = createPgPool(databaseUrl, [DEACTIVATED_PRINCIPALS_MIGRATION, EXTERNAL_MEMBERS_MIGRATION]);
  const deactivated = new Map<string, DeactivationRecord>();
  const externals = new Map<string, ExternalMember>();
  const directorySyncProtected = opts.directorySyncProtected ?? [];
  const REFRESH_TTL_MS = 10_000;
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  const keptByDirectorySync = (key: string): boolean =>
    directorySyncProtected.some((id) => personKey(id) === key) || externals.has(key);
  const storeKeys = (externalId: string): string[] => personIds(externalId).map(foldPrincipalId).filter(Boolean);

  async function load(overwrite: boolean): Promise<void> {
    await opts.principalLinks?.refresh(true);
    const [deactivations, members] = await Promise.all([
      q(`SELECT ${deactivationCodec.columns} FROM deactivated_principals ORDER BY id`).then(deactivationCodec.rows),
      q(`SELECT ${memberCodec.columns} FROM external_members ORDER BY id`).then(memberCodec.rows),
    ]);
    if (overwrite) {
      deactivated.clear();
      externals.clear();
    }
    for (const r of deactivations) {
      const key = personKey(r.principalId);
      if (deactivated.get(key)?.source !== "manual" && (r.source === "manual" || overwrite || !deactivated.has(key)))
        deactivated.set(key, r);
    }
    for (const m of members) {
      const key = personKey(m.email);
      if (overwrite || !externals.has(key)) externals.set(key, { ...m, expiresAt: m.expiresAt ?? null });
    }
  }

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const id = canonicalPerson(externalId);
    const key = personKey(externalId);
    const record = deactivated.get(key);
    const external = externals.get(key);
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !keptByDirectorySync(key)) ||
      (external !== undefined && !externalMemberActive(external));
    const type: Principal["type"] = inactive || isExternalGuest ? "guest" : "internal";
    return { id, type };
  }

  async function deactivate(externalId: string, source: DeactivationSource = "manual"): Promise<void> {
    const key = personKey(externalId);
    const existing = deactivated.get(key);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId: externalId, source, at: Date.now() };
    deactivated.set(key, record);
    await q(
      `INSERT INTO deactivated_principals (${deactivationCodec.columns}) VALUES (${deactivationCodec.placeholders})
       ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${deactivationCodec.updates}`,
      deactivationCodec.values(foldPrincipalId(externalId), record),
    );
  }

  async function reactivate(externalId: string): Promise<void> {
    deactivated.delete(personKey(externalId));
    await q(`DELETE FROM deactivated_principals WHERE id = ANY($1::text[])`, [storeKeys(externalId)]);
  }

  async function refresh(force = false): Promise<void> {
    const now = Date.now();
    if (refreshP) return refreshP;
    if (!force && now - refreshedAt < REFRESH_TTL_MS) return;
    refreshP = load(true)
      .then(() => {
        refreshedAt = Date.now();
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
  }

  return {
    classify,
    deactivate,
    deactivationSource(externalId: string): DeactivationSource | undefined {
      return deactivated.get(personKey(externalId))?.source;
    },
    reactivate,
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      for (const id of removedIds) {
        if (keptByDirectorySync(personKey(id)) || deactivated.has(personKey(id))) continue;
        await deactivate(id, "directory-sync");
        outcome.deactivated.push(id);
      }
      for (const id of presentIds) {
        if (deactivated.get(personKey(id))?.source !== "directory-sync") continue;
        await reactivate(id);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...externals.values()];
    },
    externalMember(principalId: string): ExternalMember | undefined {
      return externals.get(personKey(principalId));
    },
    async putExternalMember(m: ExternalMember): Promise<void> {
      externals.set(personKey(m.email), m);
      await q(
        `INSERT INTO external_members (${memberCodec.columns}) VALUES (${memberCodec.placeholders})
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${memberCodec.updates}`,
        memberCodec.values(foldPrincipalId(m.email), m),
      );
    },
    async removeExternalMember(principalId: string): Promise<void> {
      externals.delete(personKey(principalId));
      await q(`DELETE FROM external_members WHERE id = ANY($1::text[])`, [storeKeys(principalId)]);
    },
    hydrate(): Promise<void> {
      if (!hydrateP) hydrateP = load(false);
      return hydrateP;
    },
    refresh,
    resolve(actor: ActorAssertion): Principal {
      const p = classify(actor.externalId, actor.isExternalGuest);
      return {
        ...p,
        ...(actor.teamIds ? { teamIds: actor.teamIds } : {}),
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
      };
    },
    isInternal(p: Principal): boolean {
      return p.type === "internal";
    },
    audienceIsAllInternal(audience: Principal[]): boolean {
      return audience.length > 0 && audience.every((p) => p.type === "internal");
    },
  };
}
