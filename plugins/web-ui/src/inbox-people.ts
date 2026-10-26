import { html, nothing, type TemplateResult } from "lit";
import { Inbox as InboxGlyph, Mail } from "lucide";
import { appState } from "./shell-state";
import { splitMentions } from "./linkify";
import { splitSlackWire } from "./slack-text";
import { tip } from "./tooltip";
import { avatarTpl } from "./ui";
import { slackMark } from "./slack-mark";
import { icon } from "./icons";
import { type InboxItem, inboxState, type Participant } from "./inbox-model";

export function sourceIcon(entry: { source?: string; sources?: string[] }, size = 16): TemplateResult {
  const source = entry.source ?? entry.sources?.[0];
  let glyph: TemplateResult;
  if (source === "slack") glyph = slackMark(size);
  else glyph = icon(source === "gmail" ? Mail : InboxGlyph, size);
  return html`<span class="inbox-source-icon" aria-hidden="true">${glyph}</span>`;
}

export function sourceGlyph(item: InboxItem): TemplateResult {
  return sourceIcon(inboxState.selected.find((cron) => cron.id === item.cronId) ?? { source: item.source }, 14);
}

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function participantName(raw: string): string {
  return (raw.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? raw).trim();
}

export function participantKey(raw: string): string {
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
}

export function participantsOf(item: InboxItem): Participant[] {
  const slack = item.source === "slack";
  const found = new Map<string, Participant>((slack ? (item.participants ?? []) : []).map((p) => [p.key, p]));
  for (const message of [
    {
      author: item.from,
      authorId: slack ? (item.slack?.userId ?? item.participants?.[0]?.key) : undefined,
      avatarUrl: undefined,
    },
    ...(item.context ?? []),
  ]) {
    const name = participantName(message.author ?? "");
    if (!name) continue;
    const id = slack ? message.authorId : undefined;
    if (slack && !id && [...found.values()].some((person) => person.name === name)) continue;
    const key = id ?? participantKey(message.author);
    if (!found.has(key)) found.set(key, { key, name, avatarUrl: slack ? message.avatarUrl : undefined });
  }
  return [...found.values()];
}

const AVATARS_SHOWN = 4;

export function participantsTpl(item: InboxItem): TemplateResult | typeof nothing {
  const people = participantsOf(item);
  if (!people.length) return nothing;
  const shown = people.length > AVATARS_SHOWN ? people.slice(0, AVATARS_SHOWN - 1) : people;
  const rest = people.slice(shown.length);
  return html`<span class="inbox-avatars" aria-label=${`In this conversation: ${people.map((p) => p.name).join(", ")}`}>
    ${shown.map(avatarTpl)}
    ${
      rest.length
        ? html`<span class="inbox-avatar more" ${tip(rest.map((p) => p.name).join(", "))} aria-hidden="true"
            >+${rest.length}</span
          >`
        : nothing
    }
  </span>`;
}

export function slackTextTpl(item: InboxItem, text: string, opts: { links?: boolean } = {}): TemplateResult {
  if (item.source !== "slack") return html`${text}`;
  const me = appState.me?.user ?? "";
  const self = (me.split("@")[0] || me).trim().toLowerCase();
  const mentionChip = (handle: string): TemplateResult =>
    html`<span class="slack-mention ${handle.toLowerCase() === self ? "self" : ""}">@${handle}</span>`;
  const withMentions = (str: string): Array<TemplateResult | string> =>
    splitMentions(str).map((m) => (m.kind === "text" ? m.text : mentionChip(m.handle)));
  return html`${splitSlackWire(text).map((seg) => {
    if (seg.kind === "mention") return mentionChip(seg.handle);
    if (seg.kind === "link") {
      if (opts.links === false) return html`<span ${tip(seg.href)}>${withMentions(seg.label)}</span>`;
      return html`<a class="inbox-text-link" href=${seg.href} target="_blank" rel="noreferrer noopener"
        >${withMentions(seg.label)}</a
      >`;
    }
    return withMentions(seg.text);
  })}`;
}
