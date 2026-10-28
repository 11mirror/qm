import { reportHandledError, reportRequestTiming, stopBrowserErrors } from "./browser-errors.ts";
import { stopAnalytics } from "./product-analytics.ts";
import type { RuntimeChange, RuntimeConfig } from "./runtime-config-cache.ts";
import type { ChatBrowseStatus } from "./session-list.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { swallow } from "../../chassis/src/errors.ts";
import { groupDmText } from "./group-dm-label.ts";
import { SIGNIN_REQUIRED_EVENT, signinRedirect } from "./signin-return.ts";
import { UI_OUTDATED_EVENT, UI_RELEASE_META, UI_VERSION_HEADER, uiVersion } from "../../chassis/src/ui-release.ts";
import type { GoalStripState } from "./goal-strip.ts";
import type { Item, RunActivityEntry, WorkActivity } from "./items.ts";
import type { PiAttachment } from "./attachments.ts";

const BASE_URL = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/$/, "");

export function withBase(path: string): string {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function fileContentUrl(id: string, name?: string): string {
  const base = `/api/files/${encodeURIComponent(id)}/content`;
  return withBase(name ? `${base}/${encodeURIComponent(name)}` : base);
}

export type WebUserMessage = AgentMessage & {
  role: "user" | "user-with-attachments";
  content: string | Array<{ type: string; text?: string }>;
  attachments?: PiAttachment[];
  clientTurnId?: string;
  sendFailure?: string;
  idempotencyKey?: string;
};

export interface DeliveredFile {
  name: string;
  mimetype?: string;
  sizeBytes?: number;
  artifactId?: string;
}

export interface CoreSession {
  id: string;
  type: "dm" | "channel" | "group";
  scopeId: string;
  threadRef: string;
  createdAt: number;
  title?: string | null;
  channelName?: string | null;
  archived?: boolean;
  pinned?: boolean;
  color?: string | null;
  unread?: boolean;
  lastActivityAt?: number;
  working?: boolean;
  awaitingInput?: boolean;
  lastTurnFailed?: boolean;
  canContinue?: boolean;
  backgroundJobs?: number;
  watches?: number;
  crons?: number;
  goal?: { objective: string; activeMs: number; runningSince?: number; floor?: Record<string, number> };
  forkedFrom?: { sessionId: string; title?: string | null };
  forkBoundarySeq?: number;
  sideChat?: { entrySeq: number; quote: string; occurrence: number; expanded: boolean };
  parentSessionId?: string;
  surface?: string;
  subagents?: { running: number; waiting: number };
}

export interface SessionPageQuery {
  limit: number;
  before?: string | null;
  status?: ChatBrowseStatus;
  surface?: string;
  scope?: string | null;
  q?: string;
}

export interface SessionPage {
  sessions: CoreSession[];
  pinned?: CoreSession[];
  nextCursor: string | null;
  hasArchived?: boolean;
}

export function fetchSessionPage(query: SessionPageQuery): Promise<SessionPage> {
  const qs = new URLSearchParams({ limit: String(query.limit) });
  if (query.before) qs.set("before", query.before);
  if (query.status && query.status !== "active") qs.set("status", query.status);
  if (query.surface) qs.set("surface", query.surface);
  if (query.scope) qs.set("scope", query.scope);
  if (query.q?.trim()) qs.set("q", query.q.trim());
  return api<SessionPage>(`/api/sessions?${qs.toString()}`);
}

function nullOn404<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });
}

export function fetchSessionChildren(id: string): Promise<CoreSession[] | null> {
  return nullOn404(api<{ sessions: CoreSession[] }>(sessionPath(id, "/children")).then((r) => r.sessions));
}

export function fetchSessionRow(ref: { id: string } | { threadRef: string }): Promise<CoreSession | null> {
  const qs = new URLSearchParams("id" in ref ? { id: ref.id } : { threadRef: ref.threadRef });
  return nullOn404(api<{ session: CoreSession }>(`/api/sessions/row?${qs.toString()}`).then((r) => r.session));
}

function sessionPath(id: string, suffix = ""): string {
  return `/api/sessions/${encodeURIComponent(id)}${suffix}`;
}

export interface SessionBackgroundView {
  jobs: Array<{ processId: string; command: string; purpose?: string; startedAt: number; expiresAt: number }>;
  watches: Array<{
    id: string;
    processId: string;
    command: string;
    pattern?: string;
    instructions?: string;
    createdAt: number;
    expiresAt: number;
    lastFiredAt?: number;
  }>;
  crons: Array<{
    id: string;
    title?: string;
    nextFireAt?: number;
    lastFire?: { firedAt: number; status?: string };
  }>;
}

export interface SessionBackgroundOutput {
  chunk: string;
  cursor: number;
  state: "running" | "exited";
  exitCode?: number;
}

export interface CoreContext {
  scopeId: string;
  kind: "personal" | "channel" | "group";
  name: string | null;
  isPrivate?: boolean;
  sessionCount: number;
  lastActivityAt: number | null;
  project?: CoreProject;
}

export interface CoreProject {
  id: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  channelMemberIds?: string[];
  scopeId: string;
  members: Array<{ principalId: string; displayName: string; avatarUrl?: string; viaChannel?: boolean }>;
  slackChannel?: { channelId: string; channelName: string; linkedBy?: string; linkedAt?: number };
  createdAt?: number;
  updatedAt?: number;
}

export function slackThreadUrl(workspaceUrl: string | null, threadRef: string): string | null {
  if (!workspaceUrl) return null;
  const m = threadRef.match(/^(?:dm|ch|grp):([A-Z0-9]+)(?::(\d+)\.(\d+))?$/i);
  if (!m) return null;
  return `${workspaceUrl}/archives/${m[1]}${m[2] ? `/p${m[2]}${m[3]}` : ""}`;
}

export function sharedContextLabel(scopeId: string | null, name: string | null): string | null {
  if (!scopeId) return null;
  if (scopeId.startsWith("channel:")) return name ? `#${name.replace(/^#/, "")}` : "Shared channel";
  if (scopeId.startsWith("group:")) return groupDmText(name) ?? name ?? "Group";
  return null;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

export async function updateSession(
  id: string,
  patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null; unread?: boolean },
): Promise<{ session: CoreSession }> {
  return api<{ session: CoreSession }>(sessionPath(id), {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export async function forkSession(
  id: string,
  upToSeq?: number,
  sideChat?: { entrySeq: number; quote: string; occurrence: number },
): Promise<{ session: CoreSession; items: Item[] }> {
  return api<{ session: CoreSession; items: Item[] }>(sessionPath(id, "/fork"), {
    method: "POST",
    body: JSON.stringify({ upToSeq, sideChat }),
  });
}

export const TAIL_TURNS = 25;

export interface SessionPin {
  id: string;
  text?: string;
  entrySeq?: number;
  preview?: string;
  addedBy: string;
  createdAt: number;
}

export interface TranscriptPage {
  session?: CoreSession;
  items: Item[];
  earlierItems?: number;
  pins?: SessionPin[];
  goal?: GoalStripState;
  runtime?: TurnRuntime;
}

export async function fetchTranscript(
  id: string,
  window: { tailTurns?: number; sinceSeq?: number; beforeSeq?: number } = {},
): Promise<TranscriptPage> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(window)) if (value !== undefined) qs.set(key, String(value));
  return api<TranscriptPage>(sessionPath(id, qs.size ? `?${qs.toString()}` : ""));
}

const resolvedCredentialApprovals = new Set<string>();

export function unresolvedApprovals(approvals: PendingApproval[]): PendingApproval[] {
  const pending = approvals.filter((approval) => !resolvedCredentialApprovals.has(approval.requestId));
  return pending.length === approvals.length ? approvals : pending;
}

export function fetchSessionApprovals(id: string): Promise<{ approvals: PendingApproval[] } | null> {
  return api<{ approvals: PendingApproval[] }>(sessionPath(id, "/approvals"))
    .then((result) => ({ approvals: unresolvedApprovals(result.approvals) }))
    .catch((error: unknown) => {
      reportHandledError("web:approvals_fetch", error);
      return null;
    });
}

export async function fetchItem(sessionId: string, seq: number): Promise<Item> {
  return (await api<{ item: Item }>(sessionPath(sessionId, `/items/${seq}`))).item;
}

export async function regenerateTitle(id: string): Promise<{ title: string | null }> {
  return api<{ title: string | null }>(sessionPath(id, "/title"), { method: "POST" });
}

export async function detachSession(id: string): Promise<{ detached: true }> {
  return api<{ detached: true }>(sessionPath(id, "/detach"), { method: "POST" });
}

export async function cancelSessionGoal(id: string): Promise<{ cancelled: true }> {
  return api<{ cancelled: true }>(sessionPath(id, "/goal/cancel"), { method: "POST" });
}
type WorkStatus = "thinking" | "working" | "complete" | "failed";
export interface WorkBlock {
  streamStartOffset?: number;
  status: WorkStatus;
  startedAt?: number;
  finishedAt?: number;
  stale?: boolean;
  activity: WorkActivity[];
  reasoning?: LiveReasoning[];
  attempt?: number;
  pendingApprovals?: PendingApproval[];
  goal?: GoalStripState;
  runtime?: TurnRuntime;
}

export interface LiveReasoning {
  step: string;
  index: number;
  text: string;
}

export interface TurnRuntime {
  modelId: string;
  label?: string;
  change?: { rule: string } | { agent: "task" | "scope" };
}

export function switchedDefault(runtime: TurnRuntime | null | undefined): boolean {
  return !!runtime?.change && "agent" in runtime.change && runtime.change.agent === "scope";
}

export function workPausedForApproval(work: WorkBlock): boolean {
  const last = work.activity.at(-1);
  if (!last || !("item" in last)) return false;
  const { kind, body } = last.item;
  return (
    kind === "Elicitation" || ((kind === "ToolResult" || kind === "ToolCall") && body.blocked === "needs_approval")
  );
}

export interface PendingApproval {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
  matched?: string;
  grantModes?: { session: boolean; always: boolean };
  blocksInput?: boolean;
}

export function approvalBlocksComposer(approval: PendingApproval): boolean {
  return approval.blocksInput !== false;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  scope?: "once" | "session" | "always";
}
export interface RunPoll {
  status: "pending" | "running" | "done" | "failed";
  goal?: GoalStripState;
  runtime?: TurnRuntime;
  input?: {
    runId: string;
    seq: number | null;
    text: string;
    createdAt: number;
    attachments?: Array<{ name: string; mimetype: string; sizeBytes: number }>;
  };
  result: {
    status: string;
    reply?: string;
    reason?: string;
    refusalKind?: string;
    stopped?: boolean;
    pendingApprovals?: PendingApproval[];
    attachments?: Array<{ name: string; mimetype?: string; sizeBytes?: number; artifactId?: string }>;
  } | null;
  partial?: string;
  partialStartOffset?: number;
  alive?: boolean;
  stale?: boolean;
  replyComplete?: boolean;
  activity?: RunActivityEntry[];
  reasoning?: LiveReasoning[];
  attempt?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}
export interface TurnOptions {
  effortLevel?: string;
  fastMode?: boolean;
  scopeId?: string | null;
  channelName?: string | null;
}

export interface ActiveRun {
  runId: string | null;
  run: RunPoll | null;
  queued: QueuedRun[];
}

export interface QueuedRun {
  runId: string;
  text: string;
  hasAttachments?: boolean;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface SigninRequired {
  reason?: "unauthenticated" | "not_allowed";
}

let onSigninRequired: ((detail: SigninRequired) => void) | null = null;

export function setSigninRequiredHandler(fn: (detail: SigninRequired) => void): void {
  onSigninRequired = fn;
}

const UI_VERSION = uiVersion(
  typeof document === "undefined"
    ? undefined
    : document.querySelector<HTMLMetaElement>(`meta[name="${UI_RELEASE_META}"]`)?.content,
);

export async function webFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const startMs = Date.now();
  const request = input instanceof Request ? input : null;
  const url = request?.url ?? String(input);
  const method = init?.method ?? request?.method ?? "GET";
  const headers = new Headers(init?.headers ?? request?.headers);
  headers.set(UI_VERSION_HEADER, UI_VERSION);
  const response = await fetch(input, { ...init, headers }).catch((error: unknown) => {
    reportRequestTiming(url, method, startMs, null);
    throw error;
  });
  reportRequestTiming(url, method, startMs, response.status);
  const json = (): Promise<{ error?: unknown; loginUrl?: unknown } | null> =>
    response
      .clone()
      .json()
      .catch(() => null);
  if (response.status === 409 && (await json())?.error === "ui_outdated")
    window.dispatchEvent(new Event(UI_OUTDATED_EVENT));
  if (response.status !== 401) return response;
  stopBrowserErrors();
  stopAnalytics();
  const body = await json();
  const redirect = signinRedirect(body?.loginUrl, window.location);
  if (redirect) window.location.assign(redirect);
  else {
    onSigninRequired?.((body ?? {}) as SigninRequired);
    window.dispatchEvent(new Event(SIGNIN_REQUIRED_EVENT));
  }
  return response;
}

export interface UiStateRecord {
  value: unknown;
  updatedAt: number;
}

export function fetchUiState(key: string): Promise<UiStateRecord> {
  return api<UiStateRecord>(`/api/ui-state?key=${encodeURIComponent(key)}`);
}

export function putUiState(
  key: string,
  value: unknown,
  updatedAt: number,
  init?: RequestInit,
): Promise<{ ok: boolean; updatedAt: number }> {
  return api("/api/ui-state", { method: "PUT", body: JSON.stringify({ key, value, updatedAt }), ...init });
}

const CHAT_PREF_DEFAULTS = { "pin-latest-prompt": true, "always-steer": false };

type ChatPrefKey = keyof typeof CHAT_PREF_DEFAULTS;

const CHAT_PREF_CACHE_PREFIX = "chat-pref:";

const chatPrefValues = new Map<ChatPrefKey, boolean>();
const chatPrefTouched = new Set<ChatPrefKey>();
const chatPrefListeners = new Set<() => void>();

function cachedChatPref(key: ChatPrefKey): boolean {
  try {
    const raw = localStorage.getItem(CHAT_PREF_CACHE_PREFIX + key);
    if (raw === "1" || raw === "0") return raw === "1";
  } catch {
    void 0;
  }
  return CHAT_PREF_DEFAULTS[key];
}

function readChatPref(key: ChatPrefKey): boolean {
  if (!chatPrefValues.has(key)) chatPrefValues.set(key, cachedChatPref(key));
  return chatPrefValues.get(key)!;
}

function applyChatPref(key: ChatPrefKey, value: boolean): void {
  const changed = readChatPref(key) !== value;
  chatPrefValues.set(key, value);
  try {
    if (value === CHAT_PREF_DEFAULTS[key]) localStorage.removeItem(CHAT_PREF_CACHE_PREFIX + key);
    else localStorage.setItem(CHAT_PREF_CACHE_PREFIX + key, value ? "1" : "0");
  } catch {
    void 0;
  }
  if (changed) for (const listener of chatPrefListeners) listener();
}

function writeChatPref(key: ChatPrefKey, value: boolean): void {
  chatPrefTouched.add(key);
  applyChatPref(key, value);
  void putUiState(key, value, Date.now()).catch((error: unknown) => reportHandledError("web:save_chat_pref", error));
}

export const pinLatestPrompt = (): boolean => readChatPref("pin-latest-prompt");
export const alwaysSteer = (): boolean => readChatPref("always-steer");
export const setPinLatestPrompt = (value: boolean): void => writeChatPref("pin-latest-prompt", value);
export const setAlwaysSteer = (value: boolean): void => writeChatPref("always-steer", value);

export function onChatPrefsChange(listener: () => void): () => void {
  chatPrefListeners.add(listener);
  return () => chatPrefListeners.delete(listener);
}

export async function loadChatPrefs(): Promise<void> {
  await Promise.all(
    (Object.keys(CHAT_PREF_DEFAULTS) as ChatPrefKey[]).map(async (key) => {
      try {
        const rec = await fetchUiState(key);
        if (chatPrefTouched.has(key)) return;
        applyChatPref(key, typeof rec.value === "boolean" ? rec.value : CHAT_PREF_DEFAULTS[key]);
      } catch (error) {
        reportHandledError("web:load_chat_pref", error);
      }
    }),
  );
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await webFetch(withBase(path), { headers: { "content-type": "application/json" }, ...init });
  const text = await r.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    swallow("web-ui: parse api response body", e);
  }
  if (!r.ok) {
    const details = body as { message?: string; reason?: string; error?: string } | null;
    const msg = details?.message ?? details?.reason ?? details?.error ?? `HTTP ${r.status}`;
    throw new ApiError(msg, r.status, body);
  }
  return body as T;
}

export async function fetchRuntimeConfig(scopeId?: string | null, account?: "company"): Promise<RuntimeConfig | null> {
  const params = new URLSearchParams({ ...(scopeId ? { scopeId } : {}), ...(account ? { account } : {}) });
  try {
    return await api<RuntimeConfig>(`/api/runtime-config${params.size ? `?${params}` : ""}`);
  } catch (e) {
    swallow("web-ui: fetch runtime config", e);
    return null;
  }
}

export async function updateRuntimeConfig(scopeId: string | null, change: RuntimeChange): Promise<RuntimeConfig> {
  return api<RuntimeConfig>("/api/runtime-config", {
    method: "PUT",
    body: JSON.stringify({ ...change, ...(scopeId ? { scopeId } : {}) }),
  });
}

export async function resolveApproval(decision: ApprovalDecision): Promise<string | null> {
  if (decision.requestId.startsWith("keychain:")) {
    if (resolvedCredentialApprovals.has(decision.requestId)) return "";
    const id = decision.requestId.slice("keychain:".length);
    let choice = "deny";
    if (decision.approved) choice = decision.scope === "always" ? "standing" : "once";
    const result = await api<{ ask: { status: string } }>(`/api/keychain/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision: choice }),
    });
    if (!["approved", "declined", "expired"].includes(result.ask?.status))
      throw new Error("The credential request is still pending. Please try again.");
    resolvedCredentialApprovals.add(decision.requestId);
    return "";
  }
  const submit = await nullOn404(
    api<{ runId?: string }>(`/api/approvals/${encodeURIComponent(decision.requestId)}`, {
      method: "POST",
      body: JSON.stringify({ approved: decision.approved, ...(decision.scope ? { scope: decision.scope } : {}) }),
    }),
  );
  if (!submit) return null;
  if (!submit.runId) throw new Error("Could not continue after the approval.");
  return submit.runId;
}

export function mintSendKey(): string {
  return crypto.randomUUID();
}

export function sendKeyOf(message: unknown): string | undefined {
  return (message as WebUserMessage | null)?.idempotencyKey || undefined;
}

export function userSendMessage(text: string, attachments?: unknown[]): AgentMessage {
  const base = attachments?.length
    ? { role: "user-with-attachments", content: text, attachments, timestamp: Date.now() }
    : { role: "user", content: text, timestamp: Date.now() };
  return { ...base, idempotencyKey: mintSendKey() } as unknown as AgentMessage;
}

export interface SessionStateEvent {
  threadRef: string;
  sessionId?: string;
  state: "working" | "awaiting_approval" | "idle" | "metadata" | "ui";
  at: number;
  ui?: unknown;
}

export interface InboxItemEvent {
  cronId: string;
  itemId: string;
  op: string;
}
