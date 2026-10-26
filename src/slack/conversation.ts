import { resolveMentions } from "./mrkdwn.ts";
import type { ConversationTurn, OverheardMessage } from "../types.ts";
export { resolveMentions } from "./mrkdwn.ts";
import { encodeTs, summarizeReactions, type ReactionTally } from "./reactions.ts";
import { utcMinute } from "../util/time.ts";
import { MAX_ATTACHMENTS_PER_TURN } from "./attachments.ts";

const MAX_CONTEXT_MESSAGE_CHARS = 600;

export function compareSlackTimestamps(a: { ts: string }, b: { ts: string }): number {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  return 0;
}

export function buildContextWindow(
  scanned: readonly RecentMessage[],
  opts: { count: number; match?: string; scanHasMore?: boolean; nameById?: ReadonlyMap<string, string> },
) {
  const asc = [...scanned].sort(compareSlackTimestamps);
  const needle = opts.match?.trim().toLowerCase();
  const matched = needle ? asc.filter((m) => (m.text ?? "").toLowerCase().includes(needle)) : asc;
  const count = Math.max(1, Math.floor(opts.count));
  const kept = matched.slice(-count);
  const messages = kept.map((m) => {
    const time = formatSlackTs(m.ts);
    return {
      ts: m.ts,
      ...(time ? { time } : {}),
      author: m.isSelf ? "you" : m.name || "someone",
      text: clipMessage(resolveMentions(m.text ?? "", opts.nameById), MAX_CONTEXT_MESSAGE_CHARS),
      ...(m.parentTs ? { threadTs: m.parentTs } : {}),
      ...(m.files?.length ? { files: m.files } : {}),
      ...(m.reactions ? { reactions: m.reactions } : {}),
    };
  });
  const droppedMatches = matched.length > kept.length;
  let nextBefore = opts.scanHasMore ? asc[0]?.ts : undefined;
  if (droppedMatches) nextBefore = kept[0]?.ts;
  const selfTs = kept.filter((m) => m.isSelf).map((m) => m.ts);
  return {
    messages,
    hasMore: Boolean(opts.scanHasMore) || droppedMatches,
    ...(nextBefore ? { nextBefore } : {}),
    ...(selfTs.length ? { selfTs } : {}),
  };
}

export interface RecentMessage {
  ts: string;
  name: string;
  text: string;
  authorId?: string;
  isTrigger?: boolean;
  isBot?: boolean;
  isSelf?: boolean;
  parentTs?: string;
  reactions?: ReactionTally[];
  files?: string[];
}

export const MAX_RECENT_MESSAGES = 20;
const MAX_RECENT_MESSAGE_CHARS = 300;
const MAX_TURN_MESSAGE_CHARS = 4000;

const isUsable = (m: RecentMessage): boolean => Boolean(m.ts && (m.name || m.text?.trim() || m.files?.length));

export function recentWindow(
  candidates: readonly RecentMessage[],
  limit: number = MAX_RECENT_MESSAGES,
): RecentMessage[] {
  const usable = candidates.filter(isUsable);
  if (!usable.length) return [];
  const window = Math.max(1, Math.floor(limit));
  const sorted = [...usable].sort(compareSlackTimestamps);
  const byTs = new Map(sorted.map((m) => [m.ts, m] as const));
  const chosen = new Map<string, RecentMessage>(sorted.slice(-window).map((m) => [m.ts, m] as const));
  for (const m of Array.from(chosen.values())) {
    if (m.parentTs && !chosen.has(m.parentTs) && byTs.has(m.parentTs)) chosen.set(m.parentTs, byTs.get(m.parentTs)!);
  }
  return [...chosen.values()].sort(compareSlackTimestamps);
}

function arrangeForDisplay(messages: readonly RecentMessage[]): Array<{ message: RecentMessage; isReply: boolean }> {
  const present = new Set(messages.map((m) => m.ts));
  const isChild = (m: RecentMessage): boolean => Boolean(m.parentTs && present.has(m.parentTs));
  return messages
    .filter((m) => !isChild(m))
    .sort(compareSlackTimestamps)
    .flatMap((root) => [
      { message: root, isReply: false },
      ...messages
        .filter((m) => isChild(m) && m.parentTs === root.ts)
        .sort(compareSlackTimestamps)
        .map((message) => ({ message, isReply: true })),
    ]);
}

interface ConversationMember {
  id: string;
  name: string;
  mentionId?: string;
  isYou?: boolean;
  isBot?: boolean;
}

export interface ConversationView {
  contextNote?: string;
  channel: { name?: string; kind: "dm" | "channel" | "group"; isPrivate?: boolean };
  members: readonly ConversationMember[];
  membersOmitted?: number;
  messages: readonly RecentMessage[];
  here: { kind: "thread"; youOpenedIt: boolean; starterName?: string; openerText?: string } | { kind: "top-level" };
  files: ReadonlyArray<{ name: string }>;
  omittedFiles: ReadonlyArray<{ name: string; reason: "too-big" | string }>;
  nameById?: ReadonlyMap<string, string>;
}

const clipMessage = (t: string, max: number = MAX_RECENT_MESSAGE_CHARS): string => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export function formatSlackTs(ts: string): string {
  const sec = Number(ts);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  return utcMinute(sec * 1000);
}

export function renderConversationView(view: ConversationView) {
  const msgs = view.messages.filter(isUsable);
  const allowedTs = new Set<string>(msgs.map((m) => m.ts));
  const shown = (m: RecentMessage, max?: number): string =>
    clipMessage(resolveMentions(m.text ?? "", view.nameById), max);

  const display = arrangeForDisplay(msgs).filter(({ message: m }) => !m.isTrigger);
  const priorTurns = mergeConsecutiveTurns(
    display.map(({ message: m, isReply }): ConversationTurn => {
      const id = encodeTs(m.ts);
      const reacted = summarizeReactions(m.reactions);
      const text = `${id ? `[${id}] ` : ""}${isReply ? "(reply) " : ""}${shown(m, MAX_TURN_MESSAGE_CHARS)}${m.files?.length ? ` (files: ${m.files.join(", ")})` : ""}${reacted ? ` — reactions: ${reacted}` : ""}`;
      return m.isSelf ? { role: "assistant", text } : { role: "user", name: m.name || "someone", text };
    }),
  );

  const overheard: OverheardMessage[] = display.flatMap(({ message: m }) => {
    const text = shown(m, MAX_TURN_MESSAGE_CHARS);
    if (!text && !m.files?.length) return [];
    return [
      {
        ts: m.ts,
        role: m.isSelf ? ("self" as const) : ("user" as const),
        ...(m.isSelf ? {} : { name: m.name || "someone" }),
        text,
        ...(m.files?.length ? { files: m.files } : {}),
      },
    ];
  });

  let where = `You are in ${view.channel.name ? `#${view.channel.name}` : "a channel"}${view.channel.isPrivate ? " (private)" : ""}.`;
  if (view.channel.kind === "dm") where = "This is a direct message.";
  else if (view.channel.kind === "group") where = "This is a group direct message.";
  const mentionable = (m: ConversationMember): string => {
    const mentionId = m.mentionId ?? (/^[A-Z0-9]+$/i.test(m.id) ? m.id : undefined);
    const tags = [mentionId ? `<@${mentionId}>` : "", m.isBot ? "agent" : ""].filter(Boolean);
    return `@${m.name}${tags.length ? ` (${tags.join(", ")})` : ""}`;
  };
  const who = view.members.length
    ? "People here: " +
      view.members.map((m) => (m.isYou ? "you" : mentionable(m))).join(", ") +
      (view.membersOmitted ? `, and ${view.membersOmitted} others` : "") +
      "."
    : "";
  let here: string;
  if (view.here.kind === "top-level") here = "You are replying to a top-level message (not in a thread).";
  else if (view.here.youOpenedIt) here = "You are replying in a thread you started.";
  else here = `You are replying in a thread${view.here.starterName ? ` @${view.here.starterName} started` : ""}.`;
  const fileNames = view.files.map((f) => f.name).filter((n) => n.trim());
  const shownFileNames = fileNames.slice(0, MAX_ATTACHMENTS_PER_TURN);
  const moreFileNames = fileNames.length - shownFileNames.length;
  const fileLine = shownFileNames.length
    ? "Files referenced in this conversation: " +
      shownFileNames.join(", ") +
      (moreFileNames > 0 ? ` (+${moreFileNames} more).` : ".")
    : "";
  const omittedLine = view.omittedFiles.length
    ? "Files too big to view this turn: " + view.omittedFiles.map((f) => f.name).join(", ") + "."
    : "";

  const header = [fileLine, omittedLine, where, who, here, view.contextNote].filter(Boolean).join(" ");

  const detectContext = msgs
    .filter((m) => !m.isBot && !m.isSelf && !m.isTrigger)
    .map((m) => `${m.name || "someone"}: ${shown(m)}`)
    .join("\n");
  const detectOpener =
    view.here.kind === "thread" && view.here.youOpenedIt
      ? clipMessage(view.here.openerText ?? "") || undefined
      : undefined;

  return { header, priorTurns, overheard, allowedTs, detectContext, ...(detectOpener ? { detectOpener } : {}) };
}

export function mergeConsecutiveTurns(turns: readonly ConversationTurn[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  const inlineName = (t: ConversationTurn): string => (t.role === "user" && t.name ? `${t.name}: ${t.text}` : t.text);
  for (const t of turns) {
    const prev = out.at(-1);
    if (prev?.role !== t.role) {
      out.push(
        t.role === "user" && t.name ? { role: "user", name: t.name, text: t.text } : { role: t.role, text: t.text },
      );
      continue;
    }
    if (prev.name !== undefined) {
      prev.text = inlineName(prev);
      delete prev.name;
    }
    prev.text = `${prev.text}\n${inlineName(t)}`;
  }
  return out;
}
