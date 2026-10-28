# Batch 35 main ports

Base: `2837f61e2`. Main target: `365dc7017`.

## #2730 passage-anchored side chats

Adapted to the split chat core, draw and mount modules, class-based composer, route-result API and typed transcript items. The side-chat controller is a class with bounded methods rather than a 571-line factory. Existing session-store queries use the tenant-scoped pool and the API's tenant context. Viewer and write checks protect list and expansion. No settings or new tables.

Persisted/API shape: Session gains optional `sideChat: { entrySeq: number, quote: string, occurrence: number, expanded: boolean }`; fork accepts the same anchor without `expanded`. `sessions` gains nullable `side_chat JSONB`; existing tenant_id, tenant primary key and RLS remain unchanged. Expand migration `sessions/store/0054-side-chats` adds the column and partial index `sessions_side_chat_origin(forked_from_session_id) WHERE side_chat IS NOT NULL`. No rows are rewritten or deleted. Example (invented): before `side_chat = NULL`; after fork `{"entrySeq":0,"quote":"durable queue","occurrence":0,"expanded":false}`; after promotion only `expanded` becomes `true`.

Visible English changes (old → new, #2730):

- No passage action → `Ask about`; while opening → `Opening…` and accessible `Opening side chat`.
- No anchor action → `Open side chat`, `Open side chat: {quote}`, and numbered `{n}. {title or Side chat}` choices.
- No panel → `Side chat`; composer placeholder → `Ask about…` inside this panel only.
- No panel controls → `Collapse side chat`, `Expand side chat`, `Close side chat`, tooltip `Close side chat · Esc`, `Remove excerpt`, `Open as session`, and `Dismiss error`.
- No side-chat failure text → `Could not load side chats.`, `Could not open side chat.`, `Could not start side chat.`, `Could not expand side chat.`, and `This message is still saving. Try again in a moment.`
- No anchor validation error → `sideChat needs entrySeq, quote, and occurrence` and `sideChat needs a nonempty quote and an entrySeq inside the forked range`.
- Ordinary first prompt → optional blockquoted selected passage followed by the raw draft, only on a side chat's first send. Failed-send restoration keeps the raw draft, not the prefixed text.

Checks: root typecheck and web-ui source/server/test typechecks pass. Changed TypeScript eslint and code ratchets pass. Four targeted browser behavior tests pass (selection/reopen/expand, earlier inherited assistant reply, overlapping anchors and navigation, attachment retry). Root Postgres behavior tests added but not yet run; full suite deferred until the confirmed test box. Live browser smoke remains pending.

## #2740 one live step

Adapted to `live-work.ts` and split chat draw/mount modules, typed items and wrapped work-activity events. Keeps one live step line with icon and elapsed time; live folds start closed, remember manual opening, crossfade on step changes and do not animate when an unrelated finished head redraws. Step-less turns use one in-message Thinking line. #2718 and its revert #2739 are historical prerequisites superseded by this complete re-land, not separate implementations. No persistence/settings changes.

Visible English changes (old → new, #2740): live `Working for {time}` → latest tool's existing activity/purpose label with elapsed time; step-less standalone `Thinking` → the same `Thinking` in the message; a current posting step → `Posting message`; an agent/session step → its existing session label and target. Existing finished, stopped and approval text remains unchanged.

Checks: web-ui typecheck, changed-file eslint and two targeted browser behavior tests pass. Full suite and live smoke pending.

## #2272 client transcript cache

Adapted to typed item pages and the split chat refresh/mount architecture. LRU holds 40 transcript pages in browser memory; revisits mount immediately and reconcile in the background, with generation, active-agent, stream and pagination-anchor guards. Auth gates and session reset clear the cache. Read-only and continuable sessions share one mount helper. Existing StyleUp `pageAnchor` and read-only page mounting replace duplicate helpers from main. Cache timing metadata is deferred to the #2270 trace port because the baseline does not yet have session-switch timing. No persisted data or settings. No visible English changes.

Checks: web-ui typecheck, changed-file eslint and all eight cache tests pass (capacity, change detection, instant revisit, unchanged view, approval refresh, read-only refresh, failure eviction, signout).
