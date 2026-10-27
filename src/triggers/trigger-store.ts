import type { Destination, ScopeId, TriggerBase } from "../types.ts";
import { tenantCols, type PgPool } from "../persistence/pg-pool.ts";
import { cols, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { samePerson } from "../directory/person.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";

export interface CreateTriggerInput {
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  destination?: Destination;
  ownerConsentedAt?: number;
}

export const TRIGGER_COLUMNS =
  cols(`ownerScopeId text!, owner text!, createdBy text!, ownerConsentedAt bigint, destination jsonb,
    enabled boolean!, createdAt bigint!, lastFiredAt bigint`);

export function contentPart(value: unknown): string {
  return canonicalJson(value);
}

export async function createDeduped<T extends { id: string }>(q: PgPool["q"], spec: TableSpec, record: T): Promise<T> {
  const codec = tableCodec<T>(spec);
  const rows = await q(
    `INSERT INTO ${spec.table} (${codec.columns}) VALUES (${codec.placeholders})
     ON CONFLICT (${tenantCols("id")}) DO UPDATE SET id = ${spec.table}.id RETURNING ${codec.columns}`,
    codec.values(record.id, record),
  );
  return codec.row(rows[0]!);
}

export function assertNoEscalation(input: { owner: string; createdBy: string; ownerConsentedAt?: number }): void {
  if (!samePerson(input.owner, input.createdBy) && !input.ownerConsentedAt) {
    throw new Error("assigning a different owner requires that owner's consent");
  }
}

export function buildTriggerBase(input: CreateTriggerInput, id: string, createdAt: number): TriggerBase {
  return {
    id,
    ownerScopeId: input.ownerScopeId,
    owner: input.owner,
    createdBy: input.createdBy,
    enabled: true,
    createdAt,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.ownerConsentedAt ? { ownerConsentedAt: input.ownerConsentedAt } : {}),
  };
}
