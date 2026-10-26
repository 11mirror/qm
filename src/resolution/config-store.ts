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
import { errMessage } from "../util/errors.ts";

/** The longest instruction text a scope may hold. */
export const MAX_INSTRUCTIONS_CHARS = 100_000;

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
interface ScopeConfigPresence {
  instructions: boolean;
  commandPolicy: boolean;
  approvalGrantModes: boolean;
  egress: boolean;
  unfulfilledInsights: boolean;
  externalSlackParticipants: boolean;
  runtime: boolean;
  branding: boolean;
}

export interface PersistedDeploymentIdentity {
  orgId: string;
}
export interface ScopedConfigStore {
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
  getCommandPolicy(id: ScopeId): CommandPolicy | null;
  setCommandPolicy(id: ScopeId, policy: CommandPolicy): Promise<void>;
  getApprovalGrantModes(id: ScopeId): ApprovalGrantModes;
  getApprovalGrantModesDurable(id: ScopeId): Promise<ApprovalGrantModes>;
  setApprovalGrantModes(id: ScopeId, modes: ApprovalGrantModes): Promise<void>;
  getEgress(id: ScopeId): EgressPolicy | null;
  setEgress(id: ScopeId, policy: EgressPolicy): Promise<void>;
  getUnfulfilledInsights(id: ScopeId): boolean;
  setUnfulfilledInsights(id: ScopeId, on: boolean): Promise<void>;
  getExternalSlackParticipants(id: ScopeId): boolean;
  setExternalSlackParticipants(id: ScopeId, on: boolean): Promise<void>;
  getExternalSlackParticipantsDurable(id: ScopeId): Promise<boolean>;
  getChannelHeaderPin(id: ScopeId): boolean;
  setChannelHeaderPin(id: ScopeId, on: boolean | null): Promise<void>;
  getChannelHeaderPinDurable(id: ScopeId): Promise<boolean>;
  getChannelHeaderPinOverrideDurable(id: ScopeId): Promise<boolean | null>;
  getChannelHeaderPinDefaultDurable(): Promise<boolean>;
  onChannelHeaderPinChanged(listener: (id: ScopeId) => void): void;
  getPurposeRuntime(purpose: RuntimePurpose): RuntimeSelection | undefined;
  getPurposeRuntimeDurable(purpose: RuntimePurpose): Promise<RuntimeSelection | undefined>;
  setPurposeRuntime(purpose: RuntimePurpose, selection: RuntimeSelection): Promise<void>;
  clearPurposeRuntime(purpose: RuntimePurpose): Promise<void>;
  getBaseModel(id: ScopeId): string | null;
  setBaseModel(id: ScopeId, modelId: string | null): Promise<void>;
  getRuntimeSelection(id: ScopeId): ScopedRuntimeSelection | null;
  setRuntimeSelection(id: ScopeId, selection: RuntimeSelection | null): Promise<void>;
  acknowledgeRuntimeSelection(id: ScopeId): Promise<void>;
  getRuntimeSelectionDurable(id: ScopeId): Promise<ScopedRuntimeSelection | null>;
  onRuntimeSelectionChanged(listener: (id: ScopeId) => void): void;
  getOrgAmbient(): boolean;
  setOrgAmbient(on: boolean): Promise<void>;
  getOrgAmbientDurable(): Promise<boolean>;
  getInteractiveFastMode(): boolean;
  setInteractiveFastMode(on: boolean): Promise<void>;
  getInteractiveFastModeDurable(): Promise<boolean>;
  getIndividualModelAuth(): boolean;
  setIndividualModelAuth(on: boolean): Promise<void>;
  getIndividualModelAuthDurable(principalId?: string): Promise<boolean>;
  setPersonalModelAuth(principalId: string, on: boolean, provider?: "anthropic" | "openai"): Promise<void>;
  getModelAccountDurable(principalId: string): Promise<ModelAccount>;
  getBaseModelOwnDurable(id: ScopeId): Promise<string | null>;
  getWebuiModels(id: ScopeId): string[] | null;
  setWebuiModels(id: ScopeId, ids: string[] | null): Promise<void>;
  getBaseModelDurable(id: ScopeId): Promise<string | null>;
  getWebuiModelsDurable(id: ScopeId): Promise<string[] | null>;
  getAckEmoji(id: ScopeId): string[] | null;
  setAckEmoji(id: ScopeId, names: string[] | null): Promise<void>;
  getAckEmojiDurable(id: ScopeId): Promise<string[] | null>;
  setSlackEmojiCatalog(id: ScopeId, emoji: Record<string, string>): Promise<void>;
  getSlackEmojiCatalogDurable(id: ScopeId): Promise<PersistedSlackEmojiCatalog | null>;
  getBranding(id: ScopeId): OrgBranding | null;
  setBranding(id: ScopeId, branding: OrgBranding | null): Promise<void>;
  getBrandingDurable(id: ScopeId): Promise<OrgBranding | null>;
  getBrowseMaxSteps(id: ScopeId): number | null;
  setBrowseMaxSteps(id: ScopeId, steps: number | null): Promise<void>;
  getBrowseModel(id: ScopeId): string | null;
  setBrowseModel(id: ScopeId, modelId: string | null): Promise<void>;
  getEmbeddingModelDurable(): Promise<string | null>;
  setEmbeddingModel(modelId: string | null): Promise<void>;
  getAutoFlaggerConfig(): AutoFlaggerConfig | null;
  setAutoFlaggerConfig(config: AutoFlaggerConfig | null): Promise<void>;
  setConnectorClient(id: ScopeId, provider: string, input: ConnectorClientInput): Promise<void>;
  listConnectorClients(id: ScopeId): Promise<PublicConnectorClient[]>;
  deleteConnectorClient(id: ScopeId, provider: string): Promise<void>;
  getConnectorClientSecret(id: ScopeId, provider: string): Promise<DecryptedConnectorClient | null>;
  scopeConfigPresence(id: ScopeId): Promise<ScopeConfigPresence>;
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
        console.error("[config] channel-header-pin listener failed:", errMessage(e));
      }
    }
  };
  const runtimeSelectionListeners = new Set<(id: ScopeId) => void>();
  const noteRuntimeSelectionChanged = (id: ScopeId): void => {
    for (const listener of runtimeSelectionListeners) {
      try {
        listener(id);
      } catch (e) {
        console.error("[config] runtime-selection listener failed:", errMessage(e));
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
    if (!baseModelStore.update || !baseModelStore.insertIfAbsent || !baseModelStore.deleteIf)
      throw new Error("base model store does not support atomic updates");
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
  const orgDefaultPolicy = defaultOrgPolicy();
  const orgDefaultEgress: EgressPolicy = { allowedHosts: [], deniedHosts: [] };
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
  const loadInstructionsCache = (id: ScopeId, stored: PersistedInstructions | null): void => {
    if (stored) instructionsCache.set(id, { content: stored.content, version: stored.version });
    else if (id === org) instructionsCache.set(org, defaultOrgInstructions);
    else instructionsCache.delete(id);
    if (stored?.history) instructionsHistory.set(id, stored.history);
    else instructionsHistory.delete(id);
  };
  const cloneInstructions = (stored: PersistedInstructions | null): InstructionsSnapshot =>
    stored ? structuredClone(stored) : null;
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

  return {
    async refreshSecurity(ids) {
      await Promise.all(
        ids.flatMap((id) => [
          writeQueue(`instructions:${id}`, async () => {
            const stored = await instructionsStore.get(id);
            if (stored) instructionsCache.set(id, { content: stored.content, version: stored.version });
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
    setInstructions(id, content, updatedBy) {
      return writeQueue(`instructions:${id}`, async () => {
        if (!instructionsStore.update) throw new Error("instructions store does not support atomic updates");
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
          if (!instructionsStore.update) throw new Error("instructions store does not support atomic updates");
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
    getCommandPolicy: (id) => settings.commandPolicies.get(id) ?? (id === org ? orgDefaultPolicy : null),
    setCommandPolicy: (id, policy) => settings.commandPolicies.set(id, policy),
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
    getEgress: (id) => settings.egressPolicies.get(id) ?? (id === org ? orgDefaultEgress : null),
    setEgress: (id, policy) => settings.egressPolicies.set(id, policy),
    getUnfulfilledInsights: (id) =>
      (settings.unfulfilledInsights.get(org) ?? false) || (settings.unfulfilledInsights.get(id) ?? false),
    setUnfulfilledInsights: (id, on) => settings.unfulfilledInsights.set(id, on),
    getExternalSlackParticipants: (id) =>
      (settings.externalSlackParticipants.get(org) ?? false) || (settings.externalSlackParticipants.get(id) ?? false),
    setExternalSlackParticipants: (id, on) => settings.externalSlackParticipants.set(id, on),
    getExternalSlackParticipantsDurable: async (id) =>
      ((await settings.externalSlackParticipants.durable(org)) ?? false) ||
      ((await settings.externalSlackParticipants.durable(id)) ?? false),
    getChannelHeaderPin: (id) => settings.channelHeaderPin.get(id) ?? settings.channelHeaderPin.get(org) ?? false,
    async setChannelHeaderPin(id, on) {
      await settings.channelHeaderPin.set(id, on);
      noteChannelHeaderPinChanged(id);
    },
    getChannelHeaderPinDurable: async (id) =>
      (await settings.channelHeaderPin.durable(id)) ??
      (id === org ? false : ((await settings.channelHeaderPin.durable(org)) ?? false)),
    getChannelHeaderPinOverrideDurable: async (id) => (await settings.channelHeaderPin.durable(id)) ?? null,
    getChannelHeaderPinDefaultDurable: async () => (await settings.channelHeaderPin.durable(org)) ?? false,
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
    getBaseModel: (id) => baseModels.get(id)?.modelId ?? null,
    async setBaseModel(id, modelId) {
      await writeQueue(`model:${id}`, async () => {
        const saved = await updateBaseModelRow(id, (current) => {
          if (modelId === null) return withoutRuntime(id, current);
          return { ...current, scopeId: id, modelId };
        });
        cacheBaseModel(id, saved);
      });
      noteRuntimeSelectionChanged(id);
    },
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
    getOrgAmbient: () => settings.orgAmbient.get(org) ?? true,
    setOrgAmbient: (on) => settings.orgAmbient.set(org, on),
    getOrgAmbientDurable: async () => (await settings.orgAmbient.durable(org)) ?? true,
    getInteractiveFastMode: () => settings.interactiveFastMode.get(org) ?? false,
    setInteractiveFastMode: (on) => settings.interactiveFastMode.set(org, on),
    getInteractiveFastModeDurable: async () => (await settings.interactiveFastMode.durable(org)) ?? false,
    getIndividualModelAuth: () => settings.individualModelAuth.get(org) ?? false,
    setIndividualModelAuth: (on) => settings.individualModelAuth.set(org, on),
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
    getBaseModelOwnDurable: async (id) => (await baseModelStore.get(id))?.modelId ?? null,
    getBaseModelDurable: async (id) =>
      (await baseModelStore.get(id))?.modelId ??
      (id === org ? null : ((await baseModelStore.get(org))?.modelId ?? null)),
    getWebuiModels: (id) => settings.webuiModels.get(id) ?? null,
    setWebuiModels: (id, ids) => settings.webuiModels.set(id, ids?.length ? ids : null),
    getWebuiModelsDurable: async (id) =>
      (await settings.webuiModels.durable(id)) ?? (await settings.webuiModels.durable(org)) ?? null,
    getAckEmoji: (id) => settings.ackEmoji.get(id) ?? null,
    setAckEmoji: (id, names) => settings.ackEmoji.set(id, names?.length ? names : null),
    getAckEmojiDurable: async (id) => (await settings.ackEmoji.durable(id)) ?? null,
    async setSlackEmojiCatalog(id, emoji) {
      await writeQueue(`slackEmojiCatalog:${id}`, () =>
        slackEmojiCatalogStore.put(id, { scopeId: id, emoji, updatedAt: Date.now() }),
      );
    },
    getSlackEmojiCatalogDurable: async (id) => (await slackEmojiCatalogStore.get(id)) ?? null,
    getBranding: (id) => settings.branding.get(id) ?? null,
    setBranding: (id, value) => settings.branding.set(id, value),
    getBrandingDurable: async (id) => (await settings.branding.durable(id)) ?? null,
    getBrowseMaxSteps: (id) => settings.browseMaxSteps.get(id) ?? null,
    setBrowseMaxSteps: (id, steps) => settings.browseMaxSteps.set(id, steps),
    getBrowseModel: (id) => settings.browseModels.get(id) ?? null,
    setBrowseModel: (id, modelId) => settings.browseModels.set(id, modelId),
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
    getAutoFlaggerConfig: () => settings.autoFlaggerConfigs.get(org) ?? null,
    setAutoFlaggerConfig: (config) => settings.autoFlaggerConfigs.set(org, config),
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
    async scopeConfigPresence(id) {
      const stores = {
        instructions: instructionsStore,
        commandPolicy: settings.commandPolicies.store,
        approvalGrantModes: settings.approvalGrantModes.store,
        egress: settings.egressPolicies.store,
        unfulfilledInsights: settings.unfulfilledInsights.store,
        externalSlackParticipants: settings.externalSlackParticipants.store,
        runtime: baseModelStore,
        branding: settings.branding.store,
      };
      const present = await Promise.all(
        Object.entries(stores).map(async ([key, store]) => [key, !!(await store.get(id))] as const),
      );
      return Object.fromEntries(present) as Record<keyof typeof stores, boolean>;
    },
    async refreshScope(id) {
      const [stored, baseModel] = await Promise.all([
        instructionsStore.get(id),
        baseModelStore.get(id),
        ...allSettings.map((setting) => setting.refresh(id)),
      ]);
      let refreshedInstructions = stored;
      const legacyHistory = legacyInstructionsHistory.get(id) ?? [];
      if (stored && stored.history === undefined && legacyHistory.length) {
        const mergedHistory = mergeInstructionsHistory(stored.history, legacyHistory);
        if (!isDeepStrictEqual(mergedHistory, stored.history ?? [])) {
          refreshedInstructions = instructionsStore.update
            ? await instructionsStore.update(id, (current) =>
                current.history !== undefined
                  ? current
                  : { ...current, history: mergeInstructionsHistory(current.history, legacyHistory) },
              )
            : { ...stored, history: mergedHistory };
        }
        legacyInstructionsHistory.delete(id);
      } else if (stored?.history !== undefined) {
        legacyInstructionsHistory.delete(id);
      }
      loadInstructionsCache(id, refreshedInstructions);
      if (baseModel) baseModels.set(id, baseModel);
      else baseModels.delete(id);
    },
  };
}
