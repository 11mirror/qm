import type { ErrorLog } from "../admin/error-log.ts";
import type { Harness } from "../harness/harness.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { ScopeId } from "../types.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { headSlice } from "../util/text.ts";
import { isOverheard, isReply, isUserMessage, type Item } from "../sessions/items.ts";
import { forModelContext } from "../harness/context-compaction.ts";
import { TitleRejected } from "./turn-error.ts";

function stripTurnBoilerplate(text: string): string {
  const kept = text
    .split("\n\n")
    .filter((p) => !/^\s*\[/.test(p))
    .join("\n\n")
    .trim();
  return kept || text.trim();
}

export function visibleTitleItemText(item: Item): string | undefined {
  const value = isUserMessage(item) && typeof item.body.display === "string" ? item.body.display : item.text;
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function renderTitleTranscript(entries: Item[]): string {
  const lines: string[] = [];
  for (const e of forModelContext([...entries])) {
    const user = isUserMessage(e);
    if (!user && !isReply(e)) continue;
    if (isOverheard(e)) continue;
    const raw = visibleTitleItemText(e);
    if (!raw) continue;
    const text = user ? stripTurnBoilerplate(raw) : raw;
    if (!text) continue;
    lines.push(`${user ? "User" : "Assistant"}:\n${text}`);
  }
  return lines.join("\n\n");
}

const SIDEBAR_TITLE_CHARS = 60;

function sidebarLabel(text: string): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > SIDEBAR_TITLE_CHARS ? `${headSlice(clean, SIDEBAR_TITLE_CHARS - 1).trimEnd()}…` : clean;
}

const fallbackSessionTitle = (text: string) => sidebarLabel(stripTurnBoilerplate(text));

export function createSessionTitles(deps: {
  sessions: SessionStore;
  harness: Harness;
  sessionStateBus?: SessionStateBus;
  errors?: ErrorLog;
}) {
  async function generateAndStore(
    sessionId: string,
    scopeId: ScopeId,
    transcript: string,
    principalId?: string,
    fallbackText?: string,
  ): Promise<string | undefined> {
    if (!transcript.trim()) return undefined;
    let title: string | undefined;
    try {
      title = await deps.harness.models.generateTitle?.(transcript);
    } catch (e) {
      deps.errors?.record(
        {
          category: "session_title",
          code: e instanceof TitleRejected ? `rejected_${e.rule}` : "generation_failed",
          message: errMessage(e),
          scopeLabel: scopeId,
          sessionId,
        },
        e,
      );
    }
    if (title) title = sidebarLabel(title);
    else if (fallbackText) title = fallbackSessionTitle(fallbackText);
    if (title) {
      if (principalId) await deps.sessions.updateParticipantView(sessionId, principalId, { title });
      else await deps.sessions.updateTitle(sessionId, title);
    }
    return title;
  }

  const announce = async (session: { id: string; threadRef: string }) =>
    deps.sessionStateBus?.emit({
      threadRef: session.threadRef,
      sessionId: session.id,
      participants: await deps.sessions.participantsOf(session.id),
      state: "metadata",
      at: Date.now(),
    });

  function titleFromFirstMessage(
    session: { id: string; threadRef: string },
    scopeId: ScopeId,
    text: string,
  ): Promise<void> | undefined {
    const fallback = fallbackSessionTitle(text);
    if (!fallback) return undefined;
    const write = deps.sessions.updateTitle(session.id, fallback);
    void write
      .then(() => announce(session).catch(swallowAs("session title: sidebar refresh", undefined)))
      .then(async () => {
        if (!deps.harness.models.generateTitle) return;
        if (await generateAndStore(session.id, scopeId, `User:\n${stripTurnBoilerplate(text)}`))
          await announce(session);
      })
      .finally(() => deps.errors?.flush())
      .catch(swallowAs("session title", undefined));
    return write;
  }

  return { generateAndStore, titleFromFirstMessage };
}
