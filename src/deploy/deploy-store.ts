import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createPgPool, tenantCols, type PgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { jsonbStringify } from "../util/text.ts";
import {
  createDeployGitStore,
  type DeployGitStore,
  type DeployGitInputFile,
  type DeployGitStoreOptions,
  type DeployGitTreeFile,
} from "./deploy-git-store.ts";

export interface DeploymentVersion {
  version: number;
  createdAt: number;
  entrypoint: string;
  snapshotDir: string;
  homeDir?: string;
  image?: string;
  commit?: string;
  parentCommit?: string;
  env?: Record<string, string>;
}

export interface DeployEndpoint {
  host: string;
  port: number;
  publicUrl?: string;
  image?: string;
  tls?: boolean;
  httpVersion?: "1.1" | "2";
  proxyHeaders?: Record<string, string>;
  socksProxyPort?: number;
  renewAt?: number;
}

export function publicUrlOf(endpoint: DeployEndpoint | null | undefined): string | undefined {
  const raw = endpoint?.publicUrl;
  if (!raw) return raw ?? undefined;
  try {
    const u = new URL(raw);
    u.searchParams.delete("access");
    return u.toString();
  } catch {
    return raw;
  }
}

type DeploymentStatus = "running" | "stopped" | "archived";

interface DefaultAudienceSnapshot {
  sourceScopeId: ScopeId;
  granteeScopeIds: ScopeId[];
  snapshotAt: number;
}

export interface Deployment {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  defaultAudience?: DefaultAudienceSnapshot;
  name?: string;
  displayName?: string;
  currentVersion: number;
  status: DeploymentStatus;
  endpoint: DeployEndpoint | null;

  alwaysOn?: boolean;
  embedAncestors?: string[];
  public?: true;
  lastAccessAt?: number;
  appliedVersion?: number;
  versions: DeploymentVersion[];
}

export function currentVersionOf(d: Deployment | null): DeploymentVersion | undefined {
  return d?.versions.find((v) => v.version === d.currentVersion);
}

interface VersionInput {
  entrypoint: string;
  snapshotDir: string;
  homeDir?: string;
  env?: Record<string, string>;
  files?: DeployGitInputFile[];
}

export interface DeployStore {
  create(
    input: {
      id?: string;
      ownerScopeId: ScopeId;
      createdBy: string;
      name?: string;
      createdInScope?: ScopeId;
      alwaysOn?: boolean;
    } & VersionInput,
  ): Promise<Deployment>;
  addVersion(id: string, input: VersionInput): Promise<DeploymentVersion>;
  addVersionFromCommit(id: string, commit: string): Promise<DeploymentVersion | null>;
  get(id: string): Promise<Deployment | null>;
  getByName(name: string): Promise<Deployment | null>;
  list(): Promise<Deployment[]>;
  setCurrentVersion(id: string, version: number): Promise<void>;
  setVersionImage(id: string, version: number, image: string): Promise<void>;
  setStatus(id: string, status: DeploymentStatus): Promise<void>;
  setEndpoint(id: string, endpoint: DeployEndpoint | null): Promise<void>;
  setName(id: string, name: string): Promise<void>;
  setOwnerScope(id: string, ownerScopeId: ScopeId): Promise<void>;
  setDisplayName(id: string, displayName: string | undefined): Promise<void>;
  setAlwaysOn(id: string, alwaysOn: boolean): Promise<void>;
  setEmbedAncestors(id: string, embedAncestors: string[]): Promise<void>;
  setPublic(id: string, isPublic: boolean): Promise<void>;
  setDefaultAudience(id: string, snapshot: DefaultAudienceSnapshot): Promise<void>;
  setAppliedVersion(id: string, version: number): Promise<void>;
  touch(id: string, at: number): Promise<void>;
  versionOf(id: string, version: number): Promise<DeploymentVersion | null>;
  treeOf(id: string, version: number): Promise<DeployGitTreeFile[] | null>;
  commitTreeOf(id: string, commit: string): Promise<DeployGitTreeFile[]>;
  filesOf(id: string, version: number, paths?: string[]): Promise<DeployGitInputFile[] | null>;
  bundleOf(id: string, version: number): Promise<Uint8Array | null>;
  refOf(id: string, ref: string): Promise<string | null>;
  repoUrl(id: string): Promise<string>;
}

export interface DeployStoreBackings {
  databaseUrl: string;
  git?: DeployGitStoreOptions;
  touchDebounceMs?: number;
}

const CURRENT_REF = "refs/heads/current";
const versionRef = (version: number): string => `refs/versions/${version}`;
const NAME_INDEX = "deployments_name_unique";
const TOUCH_DEBOUNCE_MS = 60_000;

const DEPLOYMENTS: TableSpec = {
  table: "deployments",
  key: "id",
  keyIsField: true,
  columns: cols(`ownerScopeId text!, createdBy text!, createdInScope text, defaultAudience jsonb, name text,
    displayName text, currentVersion bigint!, status text!, endpoint jsonb, alwaysOn boolean,
    embedAncestors text[], public boolean, appliedVersion bigint, lastAccessAt bigint,
    versions jsonb!`),
};

const NAME_INDEX_SQL = `DO $$ BEGIN
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS ${NAME_INDEX} ON deployments (%sname) WHERE name IS NOT NULL',
        CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'deployments'::regclass
          AND attname = 'tenant_id' AND NOT attisdropped) THEN 'tenant_id, ' ELSE '' END);
    EXCEPTION WHEN unique_violation THEN RAISE WARNING 'deployments: duplicate names, no unique name index';
    END $$`;

export const DEPLOYMENTS_MIGRATION = mapToTableMigration("deploy/deployments/0001-typed", DEPLOYMENTS, {
  statements: [
    NAME_INDEX_SQL,
    `CREATE INDEX IF NOT EXISTS deployments_resource_search_gin ON deployments
      USING gin (to_tsvector('simple', coalesce(display_name, name, '') || ' ' || coalesce(name, '')))`,
  ],
});

const codec = tableCodec<Deployment>(DEPLOYMENTS);
const SELECT = `SELECT ${codec.columns},
  (SELECT a.last_access_at FROM deployment_access a WHERE a.id = deployments.id) AS touched_at FROM deployments`;

function fromRow(r: Record<string, unknown>): Deployment {
  const d = codec.row(r);
  return {
    ...d,
    endpoint: d.endpoint ?? null,
    ...(r.touched_at != null ? { lastAccessAt: Number(r.touched_at) } : {}),
  };
}

async function requireUniqueNames(q: PgPool["q"]): Promise<void> {
  const indexed = async () => !!(await q("SELECT to_regclass($1) AS index", [NAME_INDEX]))[0]?.index;
  if (await indexed()) return;
  const duplicates = await q(
    `SELECT name, count(*) AS n FROM deployments WHERE name IS NOT NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY 1`,
  );
  if (duplicates.length)
    throw new Error(
      `deployment names must be unique, but ${duplicates.map((row) => `${String(row.name)} (${String(row.n)} deployments)`).join(", ")} are shared; rename or delete the duplicates`,
    );
  await q(NAME_INDEX_SQL);
  if (!(await indexed())) throw new Error("deployments: unique name index missing after creation");
}

function uniqueNamePool(databaseUrl: string): Pick<PgPool, "q" | "query" | "pool"> {
  const db = createPgPool(databaseUrl, [DEPLOYMENTS_MIGRATION]);
  let checked: Promise<void> | null = null;
  const ready = () =>
    (checked ??= requireUniqueNames(db.q).catch((e) => {
      checked = null;
      throw e;
    }));
  return {
    q: async (...args) => (await ready(), db.q(...args)),
    query: async (...args) => (await ready(), db.query(...args)),
    pool: async () => (await ready(), db.pool()),
  };
}

function isNameConflict(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === "23505" && err?.constraint === NAME_INDEX;
}

async function named<T>(name: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isNameConflict(e)) throw new Error(`deployment name taken: ${name}`, { cause: e });
    throw e;
  }
}

async function makeVersion(
  git: DeployGitStore,
  deploymentId: string,
  version: number,
  input: VersionInput,
  parentCommit?: string,
): Promise<DeploymentVersion> {
  const commit = input.files
    ? await git.commit({
        deploymentId,
        version,
        files: input.files,
        ...(parentCommit ? { parent: parentCommit } : {}),
        message: `deploy v${version}`,
      })
    : undefined;
  return {
    version,
    createdAt: Date.now(),
    entrypoint: input.entrypoint,
    snapshotDir: input.snapshotDir,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(commit ? { commit } : {}),
    ...(parentCommit ? { parentCommit } : {}),
  };
}

async function setVersionRefs(git: DeployGitStore, id: string, v: DeploymentVersion): Promise<DeploymentVersion> {
  if (v.commit) {
    await git.setRef(id, versionRef(v.version), v.commit);
    await git.setRef(id, `refs/deploy-commits/${v.commit}`, v.commit);
  }
  return v;
}

type FieldSetters = Pick<
  DeployStore,
  | "setStatus"
  | "setEndpoint"
  | "setName"
  | "setOwnerScope"
  | "setDisplayName"
  | "setAlwaysOn"
  | "setEmbedAncestors"
  | "setPublic"
  | "setDefaultAudience"
>;

function fieldSetters(set: (id: string, column: string, value: unknown) => Promise<void>): FieldSetters {
  return {
    setStatus: (id, status) => set(id, "status", status),
    setEndpoint: (id, endpoint) => set(id, "endpoint", endpoint ? jsonbStringify(endpoint) : null),
    setName: (id, name) => named(name, () => set(id, "name", name)),
    setOwnerScope: (id, ownerScopeId) => set(id, "owner_scope_id", ownerScopeId),
    setDisplayName: (id, displayName) => set(id, "display_name", displayName || null),
    setAlwaysOn: (id, alwaysOn) => set(id, "always_on", alwaysOn),
    setEmbedAncestors: (id, embedAncestors) => set(id, "embed_ancestors", embedAncestors),
    setPublic: (id, isPublic) => set(id, "public", isPublic ? true : null),
    setDefaultAudience: (id, snapshot) => set(id, "default_audience", jsonbStringify(snapshot)),
  };
}

export function createDeployStore(backing: DeployStoreBackings): DeployStore {
  const db = uniqueNamePool(backing.databaseUrl);
  const { q, query } = db;
  const rows = typedTable<Deployment>(db, DEPLOYMENTS);
  const git = createDeployGitStore(backing.git);
  const touchDebounceMs = backing.touchDebounceMs ?? TOUCH_DEBOUNCE_MS;
  const lastTouch = new Map<string, number>();

  const load = async (id: string): Promise<Deployment | null> => {
    const rows = await q(`${SELECT} WHERE id = $1`, [id]);
    return rows.length ? fromRow(rows[0]!) : null;
  };
  const set = async (id: string, column: string, value: unknown): Promise<void> => {
    await q(`UPDATE deployments SET ${column} = $2 WHERE id = $1`, [id, value]);
  };
  const versionIn = async (id: string, version: number): Promise<DeploymentVersion | null | undefined> => {
    const d = await load(id);
    if (!d) return undefined;
    const v = d.versions.find((x) => x.version === version);
    if (!v) throw new Error(`no such version ${version}`);
    return v;
  };

  async function appendVersion(id: string, v: DeploymentVersion): Promise<DeploymentVersion> {
    await q(`UPDATE deployments SET versions = versions || $2::jsonb, current_version = $3 WHERE id = $1`, [
      id,
      jsonbStringify([v]),
      v.version,
    ]);
    return setVersionRefs(git, id, v);
  }

  async function committedVersion(id: string, version: number): Promise<DeploymentVersion | undefined> {
    const v = (await load(id))?.versions.find((x) => x.version === version);
    return v?.commit ? v : undefined;
  }

  return {
    async create(input) {
      const id = input.id ?? randomUUID();
      const v = await makeVersion(git, id, 1, input);
      const d: Deployment = {
        id,
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        ...(input.name ? { name: input.name } : {}),
        ...(input.createdInScope ? { createdInScope: input.createdInScope } : {}),
        ...(input.alwaysOn ? { alwaysOn: true } : {}),
        currentVersion: 1,
        status: "stopped",
        endpoint: null,
        versions: [v],
      };
      await named(d.name, () => rows.put(id, d));
      await setVersionRefs(git, id, v);
      return d;
    },
    async addVersion(id, input) {
      const d = await load(id);
      if (!d) throw new Error(`unknown deployment: ${id}`);
      return appendVersion(id, await makeVersion(git, id, d.versions.length + 1, input, currentVersionOf(d)?.commit));
    },
    async addVersionFromCommit(id, commit) {
      const d = await load(id);
      if (!d) throw new Error(`unknown deployment: ${id}`);
      const current = currentVersionOf(d);
      if (current?.commit === commit) return null;
      return appendVersion(id, {
        version: d.versions.length + 1,
        createdAt: Date.now(),
        entrypoint: current?.entrypoint ?? "",
        snapshotDir: current?.snapshotDir ?? "/unused",
        ...(current?.homeDir ? { homeDir: current.homeDir } : {}),
        ...(current?.env ? { env: current.env } : {}),
        commit,
        ...(current?.commit ? { parentCommit: current.commit } : {}),
      });
    },
    get: load,
    async getByName(name) {
      const rows = await q(`${SELECT} WHERE name = $1 ORDER BY id LIMIT 1`, [name]);
      return rows.length ? fromRow(rows[0]!) : null;
    },
    async list() {
      return (await q(`${SELECT} ORDER BY id`)).map(fromRow);
    },
    async setCurrentVersion(id, version) {
      if (await versionIn(id, version)) await set(id, "current_version", version);
    },
    async setVersionImage(id, version, image) {
      if (!(await versionIn(id, version))) return;
      await q(
        `UPDATE deployments SET versions = (
           SELECT jsonb_agg(CASE WHEN (v->>'version')::bigint = $2 THEN v || jsonb_build_object('image', $3::text) ELSE v END
             ORDER BY n)
           FROM jsonb_array_elements(versions) WITH ORDINALITY AS t(v, n))
         WHERE id = $1`,
        [id, version, image],
      );
    },
    ...fieldSetters(set),
    async setAppliedVersion(id, version) {
      const v = await versionIn(id, version);
      if (!v) return;
      await set(id, "applied_version", version);
      if (v.commit) await git.setRef(id, CURRENT_REF, v.commit);
      else await git.deleteRef(id, CURRENT_REF);
    },
    async touch(id, at) {
      const prev = lastTouch.get(id);
      if (prev !== undefined && at - prev < touchDebounceMs) return;
      const res = await query(
        `INSERT INTO deployment_access (id, last_access_at)
         SELECT d.id, $2::bigint FROM deployments d WHERE d.id = $1
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET last_access_at = GREATEST(deployment_access.last_access_at, EXCLUDED.last_access_at)`,
        [id, at],
      );
      if (res.rowCount > 0) lastTouch.set(id, at);
    },
    async versionOf(id, version) {
      return (await load(id))?.versions.find((v) => v.version === version) ?? null;
    },
    async treeOf(id, version) {
      const v = await committedVersion(id, version);
      return v ? git.treeOf(id, v.commit!) : null;
    },
    commitTreeOf: (id, commit) => git.treeOf(id, commit),
    async filesOf(id, version, paths) {
      const v = await committedVersion(id, version);
      return v ? git.filesOf(id, v.commit!, paths) : null;
    },
    async bundleOf(id, version) {
      const v = await committedVersion(id, version);
      return v ? git.bundle(id, v.commit!) : null;
    },
    refOf: (id, ref) => git.refOf(id, ref),
    repoUrl: (id) => git.repoUrl(id),
  };
}

export const deployCurrentGitRef = CURRENT_REF;
