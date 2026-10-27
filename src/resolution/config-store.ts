import type { CommandPolicy, EgressPolicy, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { defaultOrgPolicy } from "../policy/command-policy.ts";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";
import type { ApprovalGrantModes } from "../types.ts";
import {
  deriveConnectorKey,
  encryptSecret,
  decryptSecret,
  toPublicConnectorClient,
  type StoredConnectorClient,
  type ConnectorClientInput,
  type PublicConnectorClient,
  type DecryptedConnectorClient,
} from "../connectors/connector-client-store.ts";
import { reportFailure } from "../util/errors.ts";

/** The longest instruction text a scope may hold. */
export const MAX_INSTRUCTIONS_CHARS = 100_000;

export class InstructionsTooLargeError extends Error {
  constructor() {
    super(`instructions must be at most ${MAX_INSTRUCTIONS_CHARS} characters`);
  }
}

function assertInstructionsSize(content: string): void {
  if (content.length > MAX_INSTRUCTIONS_CHARS) throw new InstructionsTooLargeError();
}

export interface PersistedInstructions {
  scopeId: ScopeId;
  content: string;
  version: number;
  updatedAt?: number;
  updatedBy?: string;
  history?: PersistedInstructionsRevision[];
  mutationId?: string;
}
export interface PersistedInstructionsRevision {
  scopeId: ScopeId;
  content: string;
  version: number;
  updatedAt: number;
  updatedBy?: string;
}
type InstructionsSnapshot = PersistedInstructions | null;
type ScopedRow<K extends string, V> = { scopeId: ScopeId } & Record<K, V>;
export type PersistedApprovalGrantModes = ScopedRow<"modes", ApprovalGrantModes>;
export type PersistedEgressPolicy = ScopedRow<"policy", EgressPolicy>;
export type ModelAccount = "company" | "personal" | "anthropic" | "openai";

interface PersistedModelAccount extends PersistedScopedFlag {
  provider?: "anthropic" | "openai";
}

export type PersistedScopedFlag = ScopedRow<"on", boolean>;
export interface PersistedBaseModel {
  scopeId: ScopeId;
  embeddingModelId?: string;
  modelId?: string;
  cronRuntime?: RuntimeSelection;
  subagentRuntime?: RuntimeSelection;
  fallbackRuntime?: RuntimeSelection;
  orgRevision?: number;
  revision?: number;
  effortLevel?: string;
  fastMode?: boolean;
}
export type RuntimePurpose = "cron" | "subagent" | "fallback";

interface RuntimeSelection {
  modelId: string;
  effortLevel?: string;
  fastMode?: boolean;
}
interface ScopedRuntimeSelection extends RuntimeSelection {
  orgRevision: number;
  revision?: number;
}
interface PersistedSlackEmojiCatalog {
  scopeId: ScopeId;
  emoji: Record<string, string>;
  updatedAt: number;
}

export interface OrgBranding {
  accent?: string;
  mark?: string;
  markUrl?: string;
  selfLabel?: string;
  orgName?: string;
}
interface AutoFlaggerConfig {
  modelId: string;
  rubric: string;
}
export interface PersistedAutoFlaggerConfig extends AutoFlaggerConfig {
  scopeId: ScopeId;
}
export interface PersistedDeploymentIdentity {
  orgId: string;
}
export interface ScopedConfigStore {
  /** A per-scope setting as it applies at `id` (default: the org), read from the in-process cache. */
  setting<K extends ScopeSettingName>(name: K, id?: ScopeId): ScopeSettingValues[K];
  /** The same, read from the database. */
  settingDurable<K extends ScopeSettingName>(name: K, id?: ScopeId): Promise<ScopeSettingValues[K]>;
  /** What `id` itself stores, without inheritance or defaults. */
  settingOwnDurable<K extends ScopeSettingName>(name: K, id: ScopeId): Promise<ScopeSettingValue<K> | null>;
  /** Store a setting at `id` (default: the org); null clears it so `id` inherits again. */
  setSetting<K extends ScopeSettingName>(name: K, value: ScopeSettingValue<K> | null, id?: ScopeId): Promise<void>;
  refreshSecurity(ids: ScopeId[]): Promise<void>;
  getInstructions(id: ScopeId): string | null;
  /** Read a scope's instructions from the store (another instance may have written them) and refresh the cache. */
  getInstructionsDurable(id: ScopeId): Promise<string | null>;
  setInstructions(id: ScopeId, content: string, updatedBy?: string): Promise<number>;
  setInstructionsIfVersion(
    id: ScopeId,
    expectedVersion: number,
    content: string,
    updatedBy?: string,
  ): Promise<number | null>;
  instructionsVersion(id: ScopeId): number;
  instructionsHistory(id: ScopeId): PersistedInstructionsRevision[];
  captureInstructionsSnapshot(id: ScopeId): Promise<InstructionsSnapshot>;
  restoreInstructionsSnapshot(id: ScopeId, snapshot: InstructionsSnapshot): Promise<boolean>;
  restoreInstructionsCacheSnapshot(id: ScopeId, snapshot: InstructionsSnapshot): void;
  getApprovalGrantModes(id: ScopeId): ApprovalGrantModes;
  getApprovalGrantModesDurable(id: ScopeId): Promise<ApprovalGrantModes>;
  setApprovalGrantModes(id: ScopeId, modes: ApprovalGrantModes): Promise<void>;
  onChannelHeaderPinChanged(listener: (id: ScopeId) => void): void;
  getPurposeRuntime(purpose: RuntimePurpose): RuntimeSelection | undefined;
  getPurposeRuntimeDurable(purpose: RuntimePurpose): Promise<RuntimeSelection | undefined>;
  setPurposeRuntime(purpose: RuntimePurpose, selection: RuntimeSelection): Promise<void>;
  clearPurposeRuntime(purpose: RuntimePurpose): Promise<void>;
  getRuntimeSelection(id: ScopeId): ScopedRuntimeSelection | null;
  setRuntimeSelection(id: ScopeId, selection: RuntimeSelection | null): Promise<void>;
  acknowledgeRuntimeSelection(id: ScopeId): Promise<void>;
  getRuntimeSelectionDurable(id: ScopeId): Promise<ScopedRuntimeSelection | null>;
  onRuntimeSelectionChanged(listener: (id: ScopeId) => void): void;
  getIndividualModelAuthDurable(principalId?: string): Promise<boolean>;
  setPersonalModelAuth(principalId: string, on: boolean, provider?: "anthropic" | "openai"): Promise<void>;
  getModelAccountDurable(principalId: string): Promise<ModelAccount>;
  setSlackEmojiCatalog(id: ScopeId, emoji: Record<string, string>): Promise<void>;
  getSlackEmojiCatalogDurable(id: ScopeId): Promise<PersistedSlackEmojiCatalog | null>;
  getEmbeddingModelDurable(): Promise<string | null>;
  setEmbeddingModel(modelId: string | null): Promise<void>;
  setConnectorClient(id: ScopeId, provider: string, input: ConnectorClientInput): Promise<void>;
  listConnectorClients(id: ScopeId): Promise<PublicConnectorClient[]>;
  deleteConnectorClient(id: ScopeId, provider: string): Promise<void>;
  getConnectorClientSecret(id: ScopeId, provider: string): Promise<DecryptedConnectorClient | null>;
  refreshScope(id: ScopeId): Promise<void>;
  hydrate?(): Promise<void>;
}

export interface ConfigStoreMaps {
  connectorClients?: DurableMap<StoredConnectorClient>;
  instructions?: DurableMap<PersistedInstructions>;
  instructionsHistory?: DurableMap<PersistedInstructionsRevision>;
  commandPolicies?: DurableMap<ScopedRow<"policy", CommandPolicy>>;
  approvalGrantModes?: DurableMap<PersistedApprovalGrantModes>;
  egressPolicies?: DurableMap<PersistedEgressPolicy>;
  unfulfilledInsights?: DurableMap<PersistedScopedFlag>;
  externalSlackParticipants?: DurableMap<PersistedScopedFlag>;
  channelHeaderPin?: DurableMap<PersistedScopedFlag>;
  baseModels?: DurableMap<PersistedBaseModel>;
  orgAmbient?: DurableMap<PersistedScopedFlag>;
  interactiveFastMode?: DurableMap<PersistedScopedFlag>;
  individualModelAuth?: DurableMap<PersistedModelAccount>;
  webuiModels?: DurableMap<ScopedRow<"ids", string[]>>;
  ackEmoji?: DurableMap<ScopedRow<"names", string[]>>;
  slackEmojiCatalog?: DurableMap<PersistedSlackEmojiCatalog>;
  branding?: DurableMap<ScopedRow<"branding", OrgBranding>>;
  browseMaxSteps?: DurableMap<ScopedRow<"steps", number>>;
  browseModels?: DurableMap<ScopedRow<"modelId", string>>;
  autoFlaggerConfigs?: DurableMap<PersistedAutoFlaggerConfig>;
  deploymentIdentity?: DurableMap<PersistedDeploymentIdentity>;
}

const CONFIG_STORE_TABLES: Record<keyof ConfigStoreMaps, string> = {
  connectorClients: "connector_clients",
  instructions: "soul_configs",
  instructionsHistory: "soul_history",
  commandPolicies: "command_policies",
  approvalGrantModes: "approval_grant_modes",
  egressPolicies: "egress_policies",
  unfulfilledInsights: "unfulfilled_insights_flag",
  externalSlackParticipants: "external_slack_participants_flag",
  channelHeaderPin: "channel_header_pin_flag",
  baseModels: "base_model_configs",
  orgAmbient: "org_ambient_flag",
  interactiveFastMode: "interactive_fast_mode_flag",
  individualModelAuth: "individual_model_auth_flag",
  webuiModels: "webui_model_configs",
  ackEmoji: "ack_emoji",
  slackEmojiCatalog: "slack_emoji_catalog",
  branding: "branding_configs",
  browseMaxSteps: "browse_max_steps_configs",
  browseModels: "browse_model_configs",
  autoFlaggerConfigs: "auto_flagger_configs",
  deploymentIdentity: "deployment_identity",
};

export const configStoreMaps = (map: (table: string) => DurableMap<never>): Required<ConfigStoreMaps> =>
  Object.fromEntries(
    Object.entries(CONFIG_STORE_TABLES).map(([key, table]) => [key, map(table)]),
  ) as unknown as Required<ConfigStoreMaps>;

/** What each per-scope setting reads as; null means "not set here". */
export interface ScopeSettingValues {
  commandPolicy: CommandPolicy | null;
  egress: EgressPolicy | null;
  unfulfilledInsights: boolean;
  externalSlackParticipants: boolean;
  channelHeaderPin: boolean;
  orgAmbient: boolean;
  interactiveFastMode: boolean;
  individualModelAuth: boolean;
  webuiModels: string[] | null;
  ackEmoji: string[] | null;
  branding: OrgBranding | null;
  browseMaxSteps: number | null;
  browseModel: string | null;
  autoFlagger: AutoFlaggerConfig | null;
}
export type ScopeSettingName = keyof ScopeSettingValues;
export type ScopeSettingValue<K extends ScopeSettingName> = NonNullable<ScopeSettingValues[K]>;

interface ScopeSettingSpec<V> {
  /** The table-backed map that stores one row per scope. */
  map: Exclude<keyof ConfigStoreMaps, "connectorClients">;
  /** Where admins may set it: "org" settings are set on the org scope only. */
  target: "org" | "any";
  /** Stored once for the whole org, whatever scope is named. */
  orgOnly?: true;
  /** How a scope combines with the org: unset reads only the scope; "fallback" falls back to the org; "any" is on if either is. */
  inherit?: "fallback" | "any";
  /** The value at the org scope (with "fallback", everywhere) when nothing is stored. */
  orgDefault?: V;
  /** Rewrite a value before storing it; null clears the row. */
  normalize?: (value: V) => V | null;
}

const emptyAsNull = (items: string[]): string[] | null => (items.length ? items : null);

/** Every per-scope setting, declared once: the store's get/set and the admin resources come from here. */
export const SCOPE_SETTINGS: { [K in ScopeSettingName]: ScopeSettingSpec<ScopeSettingValue<K>> } = {
  commandPolicy: { map: "commandPolicies", target: "any", orgDefault: defaultOrgPolicy() },
  egress: { map: "egressPolicies", target: "any", orgDefault: { allowedHosts: [], deniedHosts: [] } },
  unfulfilledInsights: { map: "unfulfilledInsights", target: "any", inherit: "any" },
  externalSlackParticipants: { map: "externalSlackParticipants", target: "org", inherit: "any" },
  channelHeaderPin: { map: "channelHeaderPin", target: "org", inherit: "fallback", orgDefault: false },
  orgAmbient: { map: "orgAmbient", target: "org", orgOnly: true, orgDefault: true },
  interactiveFastMode: { map: "interactiveFastMode", target: "org", orgOnly: true, orgDefault: false },
  individualModelAuth: { map: "individualModelAuth", target: "org", orgOnly: true, orgDefault: false },
  webuiModels: { map: "webuiModels", target: "org", normalize: emptyAsNull },
  ackEmoji: { map: "ackEmoji", target: "org", normalize: emptyAsNull },
  branding: { map: "branding", target: "org" },
  browseMaxSteps: { map: "browseMaxSteps", target: "org" },
  browseModel: { map: "browseModels", target: "org" },
  autoFlagger: { map: "autoFlaggerConfigs", target: "org", orgOnly: true },
};

export function createConfigStore(
  orgId: string,
  opts: Required<ConfigStoreMaps> & {
    connectorSecretKey?: Buffer | string;
  },
): ScopedConfigStore {
  const instructionsCache = new Map<ScopeId, { content: string; version: number }>();
  const instructionsHistory = new Map<ScopeId, PersistedInstructionsRevision[]>();
  const legacyInstructionsHistory = new Map<ScopeId, PersistedInstructionsRevision[]>();
  const baseModels = new Map<ScopeId, PersistedBaseModel>();
  const instructionsStore = opts.instructions;
  const instructionsHistoryStore = opts.instructionsHistory;
  const baseModelStore = opts.baseModels;
  const slackEmojiCatalogStore = opts.slackEmojiCatalog;
  const deploymentIdentity = opts.deploymentIdentity;
  const writeQueue = createKeyedQueue();
  const save = (key: string, write: () => Promise<unknown>, apply: () => void): Promise<void> =>
    writeQueue(key, async () => {
      await write();
      apply();
    });
  type SettingKey = Exclude<keyof ConfigStoreMaps, "connectorClients">;
  type Row<M extends SettingKey> = NonNullable<ConfigStoreMaps[M]> extends DurableMap<infer R> ? R : never;
  const setting = <M extends SettingKey, T>(
    name: M,
    read: (row: Row<M>) => T,
    toRow: (id: ScopeId, value: T) => Row<M>,
    orgOnly = false,
  ) => {
    const store = opts[name] as DurableMap<Row<M>>;
    const cache = new Map<ScopeId, T>();
    const load = (id: ScopeId, row: Row<M> | null) => (row ? cache.set(id, read(row)) : cache.delete(id));
    const refresh = async (id: ScopeId) => {
      if (!orgOnly || id === org) load(id, await store.get(id));
    };
    return {
      store,
      refresh,
      reload: (id: ScopeId) => writeQueue(`${name}:${id}`, () => refresh(id)),
      get: (id: ScopeId) => cache.get(id),
      durable: async (id: ScopeId) => {
        const row = await store.get(id);
        return row ? read(row) : undefined;
      },
      set(id: ScopeId, value: T | null) {
        const row = value === null ? null : toRow(id, value);
        return save(
          `${name}:${id}`,
          () => (row ? store.put(id, row) : store.delete(id)),
          () => load(id, row),
        );
      },
      async hydrate() {
        if (orgOnly) await refresh(org);
        else for (const row of await store.all()) load((row as { scopeId: ScopeId }).scopeId, row);
      },
    };
  };
  const field = <M extends SettingKey, K extends Exclude<keyof Row<M>, "scopeId">>(name: M, key: K, orgOnly = false) =>
    setting(
      name,
      (row) => row[key],
      (id, value: Row<M>[K]) => ({ scopeId: id, [key]: value }) as Row<M>,
      orgOnly,
    );
  const settings = {
    commandPolicies: field("commandPolicies", "policy"),
    approvalGrantModes: field("approvalGrantModes", "modes"),
    egressPolicies: field("egressPolicies", "policy"),
    unfulfilledInsights: field("unfulfilledInsights", "on"),
    externalSlackParticipants: field("externalSlackParticipants", "on"),
    channelHeaderPin: field("channelHeaderPin", "on"),
    orgAmbient: field("orgAmbient", "on", true),
    interactiveFastMode: field("interactiveFastMode", "on", true),
    individualModelAuth: field("individualModelAuth", "on", true),
    webuiModels: field("webuiModels", "ids"),
    ackEmoji: field("ackEmoji", "names"),
    branding: field("branding", "branding"),
    browseMaxSteps: field("browseMaxSteps", "steps"),
    browseModels: field("browseModels", "modelId"),
    autoFlaggerConfigs: setting(
      "autoFlaggerConfigs",
      ({ modelId, rubric }): AutoFlaggerConfig => ({ modelId, rubric }),
      (id, config) => ({ scopeId: id, ...config }),
      true,
    ),
  } satisfies Partial<Record<SettingKey, unknown>>;
  const allSettings = Object.values(settings);
  const channelHeaderPinListeners = new Set<(id: ScopeId) => void>();
  const noteChannelHeaderPinChanged = (id: ScopeId): void => {
    for (const listener of channelHeaderPinListeners) {
      try {
        listener(id);
      } catch (e) {
        reportFailure("config: channel-header-pin listener", e);
      }
    }
  };
  const runtimeSelectionListeners = new Set<(id: ScopeId) => void>();
  const noteRuntimeSelectionChanged = (id: ScopeId): void => {
    for (const listener of runtimeSelectionListeners) {
      try {
        listener(id);
      } catch (e) {
        reportFailure("config: runtime-selection listener", e);
      }
    }
  };
  const connectorClients = opts.connectorClients;
  const connectorKey = deriveConnectorKey(opts.connectorSecretKey ?? randomBytes(32), "connector-clients");
  const connectorMapKey = (id: ScopeId, provider: string) => `${id}|${provider}`;

  const org = scopeId("org", orgId);
  const purposeFields = (id: ScopeId, row?: PersistedBaseModel | null) =>
    id === org
      ? {
          ...(row?.embeddingModelId ? { embeddingModelId: row.embeddingModelId } : {}),
          ...(row?.cronRuntime ? { cronRuntime: row.cronRuntime } : {}),
          ...(row?.subagentRuntime ? { subagentRuntime: row.subagentRuntime } : {}),
          ...(row?.fallbackRuntime ? { fallbackRuntime: row.fallbackRuntime } : {}),
        }
      : {};
  const withoutRuntime = (id: ScopeId, row: PersistedBaseModel | null): PersistedBaseModel => ({
    scopeId: id,
    ...purposeFields(id, row),
  });
  const updateBaseModelRow = async (
    id: ScopeId,
    fn: (row: PersistedBaseModel | null) => PersistedBaseModel,
  ): Promise<PersistedBaseModel | null> => {
    for (;;) {
      let saved = await baseModelStore.update(id, fn);
      if (!saved) {
        const fresh = fn(null);
        if (Object.keys(fresh).length <= 1) return null;
        if (!(await baseModelStore.insertIfAbsent(id, fresh))) continue;
        saved = fresh;
      }
      if (Object.keys(saved).length > 1) return saved;
      await baseModelStore.deleteIf(id, (row) => Object.keys(row).length <= 1);
      return null;
    }
  };
  const runtimeSelection = (row: PersistedBaseModel | null | undefined): ScopedRuntimeSelection | null => {
    if (row?.orgRevision === undefined || !row.modelId) return null;
    return {
      modelId: row.modelId,
      orgRevision: row.orgRevision ?? 0,
      ...(row.revision !== undefined ? { revision: row.revision } : {}),
      ...(row.effortLevel !== undefined ? { effortLevel: row.effortLevel } : {}),
      ...(row.fastMode !== undefined ? { fastMode: row.fastMode } : {}),
    };
  };
  const cacheBaseModel = (id: ScopeId, row: PersistedBaseModel | null): void => {
    if (row) baseModels.set(id, row);
    else baseModels.delete(id);
  };
  const setPurposeRuntime = async (purpose: RuntimePurpose, selection?: RuntimeSelection) => {
    await writeQueue(`model:${org}`, async () => {
      const key = `${purpose}Runtime` as const;
      const saved = await updateBaseModelRow(org, (current) => {
        const row: PersistedBaseModel = { ...current, scopeId: org };
        if (selection) row[key] = { ...selection };
        else delete row[key];
        return row;
      });
      cacheBaseModel(org, saved);
    });
  };
  const DEFAULT_APPROVAL_GRANT_MODES: ApprovalGrantModes = { session: true, always: true };
  const composeApprovalGrantModes = (orgModes: ApprovalGrantModes, scope?: ApprovalGrantModes): ApprovalGrantModes => ({
    session: orgModes.session && (scope?.session ?? true),
    always: orgModes.always && (scope?.always ?? true),
  });
  const defaultOrgInstructions = {
    content:
      "You are a helpful internal assistant for this organization. Be concise, accurate, and respect data boundaries: never reveal information to people who are not party to the current conversation.",
    version: 1,
  };
  instructionsCache.set(org, defaultOrgInstructions);

  let hydrated: Promise<void> | null = null;
  const loadInstructionsCache = (id: ScopeId, instructions: PersistedInstructions | null): void => {
    if (instructions) instructionsCache.set(id, { content: instructions.content, version: instructions.version });
    else if (id === org) instructionsCache.set(org, defaultOrgInstructions);
    else instructionsCache.delete(id);
    if (instructions?.history) instructionsHistory.set(id, instructions.history);
    else instructionsHistory.delete(id);
  };
  const cloneInstructions = (instructions: PersistedInstructions | null): InstructionsSnapshot =>
    instructions ? structuredClone(instructions) : null;
  const sameInstructions = (left: InstructionsSnapshot, right: InstructionsSnapshot): boolean =>
    isDeepStrictEqual(left, right);
  const mergeInstructionsHistory = (
    embedded: readonly PersistedInstructionsRevision[] | undefined,
    legacy: readonly PersistedInstructionsRevision[],
  ): PersistedInstructionsRevision[] => {
    const byVersion = new Map<number, PersistedInstructionsRevision>();
    for (const revision of legacy) byVersion.set(revision.version, revision);
    for (const revision of embedded ?? []) byVersion.set(revision.version, revision);
    return [...byVersion.values()].sort((a, b) => b.version - a.version);
  };
  const historyIncludingCurrent = (
    current: PersistedInstructions,
    legacy: readonly PersistedInstructionsRevision[],
  ): PersistedInstructionsRevision[] => {
    const history = mergeInstructionsHistory(current.history, legacy);
    if (!history.some((revision) => revision.version === current.version)) {
      history.push({
        scopeId: current.scopeId,
        content: current.content,
        version: current.version,
        updatedAt: current.updatedAt ?? 0,
        ...(current.updatedBy ? { updatedBy: current.updatedBy } : {}),
      });
      history.sort((a, b) => b.version - a.version);
    }
    return history;
  };

  type Access = {
    get(id: ScopeId): unknown;
    durable(id: ScopeId): Promise<unknown>;
    set(id: ScopeId, value: unknown): Promise<void>;
  };
  const access = (name: ScopeSettingName) => (settings as unknown as Record<string, Access>)[SCOPE_SETTINGS[name].map]!;
  const resolve = (name: ScopeSettingName, id: ScopeId, own: unknown, orgValue: () => unknown): unknown => {
    const { inherit, orgDefault } = SCOPE_SETTINGS[name];
    if (inherit === "any") return Boolean(orgValue()) || Boolean(own);
    if (own !== undefined) return own;
    if (id === org) return orgDefault ?? null;
    return inherit === "fallback" ? (orgValue() ?? orgDefault ?? null) : null;
  };

  return {
    setting: <K extends ScopeSettingName>(name: K, id: ScopeId = org) =>
      resolve(name, id, access(name).get(id), () => access(name).get(org)) as ScopeSettingValues[K],
    async settingDurable<K extends ScopeSettingName>(name: K, id: ScopeId = org) {
      const { inherit } = SCOPE_SETTINGS[name];
      const stored = access(name);
      if (inherit === "any" && id !== org && (await stored.durable(org))) return true as ScopeSettingValues[K];
      const own = await stored.durable(id);
      const orgValue =
        inherit === "fallback" && own === undefined && id !== org ? await stored.durable(org) : undefined;
      return resolve(name, id, own, () => orgValue) as ScopeSettingValues[K];
    },
    settingOwnDurable: async <K extends ScopeSettingName>(name: K, id: ScopeId) =>
      ((await access(name).durable(id)) ?? null) as ScopeSettingValue<K> | null,
    async setSetting(name, value, id = org) {
      const { normalize } = SCOPE_SETTINGS[name];
      await access(name).set(id, value !== null && normalize ? normalize(value as never) : value);
      if (name === "channelHeaderPin") noteChannelHeaderPinChanged(id);
    },
    async refreshSecurity(ids) {
      await Promise.all(
        ids.flatMap((id) => [
          writeQueue(`instructions:${id}`, async () => {
            const instructions = await instructionsStore.get(id);
            if (instructions)
              instructionsCache.set(id, { content: instructions.content, version: instructions.version });
            else if (id !== org) instructionsCache.delete(id);
          }),
          settings.commandPolicies.reload(id),
          settings.egressPolicies.reload(id),
        ]),
      );
    },
    hydrate() {
      if (!hydrated) {
        hydrated = (async () => {
          const identity = await deploymentIdentity.putIfAbsent("singleton", { orgId });
          if (identity.orgId !== orgId) throw new Error(`database belongs to org ${identity.orgId}, not ${orgId}`);
          for (const r of await instructionsStore.all()) {
            instructionsCache.set(r.scopeId, { content: r.content, version: r.version });
            if (r.history?.length) instructionsHistory.set(r.scopeId, r.history);
          }
          for (const r of await instructionsHistoryStore.all()) {
            const legacyRevisions = legacyInstructionsHistory.get(r.scopeId) ?? [];
            if (!legacyRevisions.some((revision) => revision.version === r.version)) legacyRevisions.push(r);
            legacyInstructionsHistory.set(r.scopeId, legacyRevisions);
            const revisions = instructionsHistory.get(r.scopeId) ?? [];
            if (!revisions.some((revision) => revision.version === r.version)) revisions.push(r);
            instructionsHistory.set(r.scopeId, revisions);
          }
          for (const revisions of legacyInstructionsHistory.values()) revisions.sort((a, b) => b.version - a.version);
          for (const revisions of instructionsHistory.values()) revisions.sort((a, b) => b.version - a.version);
          for (const r of await baseModelStore.all()) baseModels.set(r.scopeId, r);
          await Promise.all(allSettings.map((setting) => setting.hydrate()));
        })();
      }
      return hydrated;
    },
    getInstructions: (id) => instructionsCache.get(id)?.content ?? null,
    getInstructionsDurable(id) {
      return writeQueue(`instructions:${id}`, async () => {
        loadInstructionsCache(id, await instructionsStore.get(id));
        return instructionsCache.get(id)?.content ?? null;
      });
    },
    async setInstructions(id, content, updatedBy) {
      assertInstructionsSize(content);
      return writeQueue(`instructions:${id}`, async () => {
        const legacy = legacyInstructionsHistory.get(id) ?? [];
        const append = (current: PersistedInstructions): PersistedInstructions => {
          const revision: PersistedInstructionsRevision = {
            scopeId: id,
            content,
            version: current.version + 1,
            updatedAt: Date.now(),
            ...(updatedBy ? { updatedBy } : {}),
          };
          return {
            ...revision,
            history: [revision, ...historyIncludingCurrent(current, current.history === undefined ? legacy : [])],
            mutationId: randomBytes(12).toString("hex"),
          };
        };
        let saved = await instructionsStore.update(id, append);
        if (!saved) {
          const baseVersion = instructionsCache.get(id)?.version ?? 0;
          const revision: PersistedInstructionsRevision = {
            scopeId: id,
            content,
            version: baseVersion + 1,
            updatedAt: Date.now(),
            ...(updatedBy ? { updatedBy } : {}),
          };
          const mutationId = randomBytes(12).toString("hex");
          const candidate: PersistedInstructions = { ...revision, history: [revision], mutationId };
          const canonical = await instructionsStore.putIfAbsent(id, candidate);
          saved = canonical.mutationId === mutationId ? canonical : await instructionsStore.update(id, append);
        }
        if (!saved) throw new Error("instructions disappeared during atomic update");
        legacyInstructionsHistory.delete(id);
        loadInstructionsCache(id, saved);
        return saved.version;
      });
    },
    async setInstructionsIfVersion(id, expectedVersion, content, updatedBy) {
      assertInstructionsSize(content);
      return writeQueue(`instructions:${id}`, async () => {
        const version = expectedVersion + 1;
        const revision: PersistedInstructionsRevision = {
          scopeId: id,
          content,
          version,
          updatedAt: Date.now(),
          ...(updatedBy ? { updatedBy } : {}),
        };
        const legacyHistory = legacyInstructionsHistory.get(id) ?? [];
        const mutationId = randomBytes(12).toString("hex");
        const candidate: PersistedInstructions = { ...revision, history: [revision], mutationId };
        const durable = await instructionsStore.get(id);
        let saved: PersistedInstructions;
        if (!durable) {
          if ((instructionsCache.get(id)?.version ?? 0) !== expectedVersion) return null;
          const canonical = await instructionsStore.putIfAbsent(id, candidate);
          if (canonical.mutationId !== mutationId) return null;
          saved = canonical;
        } else {
          let accepted = false;
          const updated = await instructionsStore.update(id, (current) => {
            if (current.version !== expectedVersion) return current;
            accepted = true;
            return {
              ...candidate,
              history: [
                revision,
                ...historyIncludingCurrent(current, current.history === undefined ? legacyHistory : []),
              ],
            };
          });
          if (!accepted || !updated) return null;
          saved = updated;
        }
        instructionsCache.set(id, { content: saved.content, version: saved.version });
        instructionsHistory.set(id, saved.history ?? [revision]);
        legacyInstructionsHistory.delete(id);
        return saved.version;
      });
    },
    instructionsVersion: (id) => instructionsCache.get(id)?.version ?? 0,
    instructionsHistory: (id) => (instructionsHistory.get(id) ?? []).slice(0, 25),
    captureInstructionsSnapshot(id) {
      return writeQueue(`instructions:${id}`, async () => cloneInstructions(await instructionsStore.get(id)));
    },
    restoreInstructionsSnapshot(id, snapshot) {
      return writeQueue(`instructions:${id}`, async () => {
        try {
          if (snapshot) await instructionsStore.put(id, cloneInstructions(snapshot)!);
          else await instructionsStore.delete(id);
          const restored = await instructionsStore.get(id);
          loadInstructionsCache(id, restored);
          return sameInstructions(restored, snapshot);
        } catch (error) {
          loadInstructionsCache(id, await instructionsStore.get(id));
          throw error;
        }
      });
    },
    restoreInstructionsCacheSnapshot(id, snapshot) {
      loadInstructionsCache(id, cloneInstructions(snapshot));
    },
    getApprovalGrantModes(id) {
      const orgModes = settings.approvalGrantModes.get(org) ?? DEFAULT_APPROVAL_GRANT_MODES;
      if (id === org) return { ...orgModes };
      return composeApprovalGrantModes(orgModes, settings.approvalGrantModes.get(id));
    },
    async getApprovalGrantModesDurable(id) {
      const orgModes = (await settings.approvalGrantModes.durable(org)) ?? DEFAULT_APPROVAL_GRANT_MODES;
      if (id === org) return { ...orgModes };
      return composeApprovalGrantModes(orgModes, await settings.approvalGrantModes.durable(id));
    },
    setApprovalGrantModes: (id, modes) =>
      settings.approvalGrantModes.set(id, { session: !!modes.session, always: !!modes.always }),
    onChannelHeaderPinChanged(listener) {
      channelHeaderPinListeners.add(listener);
    },
    getPurposeRuntime: (purpose) => {
      const selection = baseModels.get(org)?.[`${purpose}Runtime`];
      return selection ? { ...selection } : undefined;
    },
    getPurposeRuntimeDurable: async (purpose) => {
      const selection = (await baseModelStore.get(org))?.[`${purpose}Runtime`];
      return selection ? { ...selection } : undefined;
    },
    setPurposeRuntime,
    clearPurposeRuntime: (purpose) => setPurposeRuntime(purpose),
    getRuntimeSelection: (id) => runtimeSelection(baseModels.get(id)),
    async setRuntimeSelection(id, selection) {
      await writeQueue(`model:${id}`, async () => {
        if (selection === null) {
          cacheBaseModel(id, await updateBaseModelRow(id, (row) => withoutRuntime(id, row)));
          return;
        }
        const orgRevision = id === org ? 0 : ((await baseModelStore.get(org))?.revision ?? 0);
        const saved = await updateBaseModelRow(id, (row) => {
          if (id !== org) return { scopeId: id, ...selection, orgRevision };
          const revision = (row?.revision ?? 0) + 1;
          return { scopeId: id, ...purposeFields(id, row), ...selection, revision, orgRevision: revision };
        });
        cacheBaseModel(id, saved);
      });
      noteRuntimeSelectionChanged(id);
    },
    async acknowledgeRuntimeSelection(id) {
      if (id === org) return;
      await writeQueue(`model:${id}`, async () => {
        const orgRevision = (await baseModelStore.get(org))?.revision ?? 0;
        const saved = await baseModelStore.merge(id, { orgRevision });
        if (saved) baseModels.set(id, saved);
      });
    },
    onRuntimeSelectionChanged(listener) {
      runtimeSelectionListeners.add(listener);
    },
    getRuntimeSelectionDurable: async (id) => runtimeSelection(await baseModelStore.get(id)),
    async getIndividualModelAuthDurable(principalId) {
      if (await settings.individualModelAuth.durable(org)) return true;
      return principalId
        ? ((await settings.individualModelAuth.durable(scopeId("personal", principalId))) ?? false)
        : false;
    },
    async getModelAccountDurable(principalId) {
      const row = await settings.individualModelAuth.store.get(scopeId("personal", principalId));
      if (row?.on) return row.provider ?? "personal";
      return (await settings.individualModelAuth.durable(org)) ? "personal" : "company";
    },
    async setPersonalModelAuth(principalId, on, provider) {
      const id = scopeId("personal", principalId);
      await settings.individualModelAuth.store.put(id, { scopeId: id, on, ...(on && provider ? { provider } : {}) });
    },
    async setSlackEmojiCatalog(id, emoji) {
      await writeQueue(`slackEmojiCatalog:${id}`, () =>
        slackEmojiCatalogStore.put(id, { scopeId: id, emoji, updatedAt: Date.now() }),
      );
    },
    getSlackEmojiCatalogDurable: async (id) => (await slackEmojiCatalogStore.get(id)) ?? null,
    getEmbeddingModelDurable: async () => (await baseModelStore.get(org))?.embeddingModelId ?? null,
    setEmbeddingModel: async (modelId) => {
      await writeQueue(`model:${org}`, async () => {
        const saved = await updateBaseModelRow(org, (current) => {
          const row: PersistedBaseModel = { ...current, scopeId: org };
          if (modelId) row.embeddingModelId = modelId;
          else delete row.embeddingModelId;
          return row;
        });
        cacheBaseModel(org, saved);
      });
    },
    async setConnectorClient(id, provider, input) {
      const rec: StoredConnectorClient = {
        scopeId: id,
        provider,
        clientId: input.clientId,
        secretEnc: encryptSecret(input.clientSecret, connectorKey),
        ...(input.scopes ? { scopes: input.scopes } : {}),
        ...(input.redirectAllowlist ? { redirectAllowlist: input.redirectAllowlist } : {}),
        ...(input.consentMode ? { consentMode: input.consentMode } : {}),
        ...(input.hostedDomain ? { hostedDomain: input.hostedDomain } : {}),
        enabled: input.enabled !== false,
        ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
        updatedAt: Date.now(),
      };
      await connectorClients.put(connectorMapKey(id, provider), rec);
    },
    listConnectorClients: async (id) =>
      (await connectorClients.all()).filter((r) => r.scopeId === id).map(toPublicConnectorClient),
    deleteConnectorClient: (id, provider) => connectorClients.delete(connectorMapKey(id, provider)),
    async getConnectorClientSecret(id, provider) {
      const rec = await connectorClients.get(connectorMapKey(id, provider));
      if (!rec) return null;
      return {
        clientId: rec.clientId,
        clientSecret: decryptSecret(rec.secretEnc, connectorKey),
        ...(rec.scopes ? { scopes: rec.scopes } : {}),
        ...(rec.redirectAllowlist ? { redirectAllowlist: rec.redirectAllowlist } : {}),
        ...(rec.consentMode ? { consentMode: rec.consentMode } : {}),
        ...(rec.hostedDomain ? { hostedDomain: rec.hostedDomain } : {}),
        enabled: rec.enabled,
      };
    },
    async refreshScope(id) {
      const [instructions, baseModel] = await Promise.all([
        instructionsStore.get(id),
        baseModelStore.get(id),
        ...allSettings.map((setting) => setting.refresh(id)),
      ]);
      let refreshedInstructions = instructions;
      const legacyHistory = legacyInstructionsHistory.get(id) ?? [];
      if (instructions && instructions.history === undefined && legacyHistory.length) {
        const mergedHistory = mergeInstructionsHistory(instructions.history, legacyHistory);
        if (!isDeepStrictEqual(mergedHistory, instructions.history ?? [])) {
          refreshedInstructions = instructionsStore.update
            ? await instructionsStore.update(id, (current) =>
                current.history !== undefined
                  ? current
                  : { ...current, history: mergeInstructionsHistory(current.history, legacyHistory) },
              )
            : { ...instructions, history: mergedHistory };
        }
        legacyInstructionsHistory.delete(id);
      } else if (instructions?.history !== undefined) {
        legacyInstructionsHistory.delete(id);
      }
      loadInstructionsCache(id, refreshedInstructions);
      if (baseModel) baseModels.set(id, baseModel);
      else baseModels.delete(id);
    },
  };
}
