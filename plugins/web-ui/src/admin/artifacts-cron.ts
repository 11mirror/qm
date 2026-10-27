import { html, nothing } from "lit";
import { card, empty, denseList as dense } from "./shared.ts";
import { destinationDetails, destinationSummary, fmtTime, plural, relTime } from "./format.ts";
import { fmtSchedule } from "./schedule.ts";
import type { Data } from "./artifacts.ts";
export const dot = (...parts: unknown[]) => parts.filter(Boolean).join(" · ");
export const cronStatus = (c: Data) => (c.archived && "archived") || (c.enabled === false ? "disabled" : "enabled");
const change = (k: Data, key: string) => (e: Event) => {
  k.draft[key] = (e.target as HTMLInputElement).value;
  k.draw();
};
async function save(k: Data, clear = false) {
  const { root, c, id, cron, draft } = k;
  if (k.saving) return;
  if (!clear && !draft.target.trim()) {
    root.querySelector('input[name="cron-target"]')?.focus();
    return alert("Target is required.");
  }
  const destination = clear
    ? null
    : {
        type: draft.type,
        target: draft.target.trim(),
        ...(draft.audienceScopeId.trim() ? { audienceScopeId: draft.audienceScopeId.trim() } : {}),
        ...(draft.type === "principal" && draft.onBehalfOf.trim() ? { onBehalfOf: draft.onBehalfOf.trim() } : {}),
      };
  const submitted = JSON.stringify(draft);
  k.saving = true;
  k.draw();
  try {
    const response = await c.api(
      "PUT",
      "/api/crons/" + encodeURIComponent(id) + "/destination?scope=" + encodeURIComponent(c.scope),
      { destination },
    );
    if (!response.ok) return alert(response.data?.message || "Could not update destination.");
    cron.destination = destination;
    c.invalidate();
    if (JSON.stringify(draft) === submitted) {
      k.editing = false;
      c.setCronEditing(null);
      await c.reload();
    }
  } catch {
    alert("Could not update destination.");
  } finally {
    k.saving = false;
    if (root.isConnected) k.draw();
  }
}
const facts = (cron: Data) => [
  ["Schedule", fmtSchedule(cron.schedule)],
  [
    "Destination",
    html`<span
      >${destinationSummary(cron.destination) + (destinationDetails(cron.destination) ? " · " + destinationDetails(cron.destination) : "")}</span
    >`,
  ],
  ["Owner", cron.owner || cron.createdBy || "None"],
  ["Status", cronStatus(cron)],
  ["Created", fmtTime(cron.createdAt)],
  ["Last fired", cron.lastFiredAt ? relTime(cron.lastFiredAt) : "never fired"],
  ["Id", cron.id],
];
function editCard(k: Data) {
  const { c, cron, draft } = k;
  return card(
    "Edit cron destination",
    cron.title || cron.action || cron.message || cron.id,
    html`<div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:10px">
        <label
          >Type<select .value=${draft.type} @change=${change(k, "type")}>
            <option value="slack" .selected=${draft.type === "slack"}>slack</option>
            <option value="principal" .selected=${draft.type === "principal"}>principal</option>
          </select></label
        ><label
          >Target<input
            name="cron-target"
            type="text"
            .value=${draft.target}
            placeholder=${draft.type === "principal" ? "principal id" : "Slack channel/thread id"}
            @input=${change(k, "target")} /></label
        ><label
          >Audience scope<input
            type="text"
            .value=${draft.audienceScopeId}
            placeholder=${draft.type === "principal" ? "personal:U123" : "channel:C123"}
            @input=${change(k, "audienceScopeId")} /></label
        ><label
          >On behalf of<input
            type="text"
            .value=${draft.onBehalfOf}
            ?disabled=${draft.type !== "principal"}
            @input=${change(k, "onBehalfOf")}
        /></label>
      </div>
      <div class="foot">
        <button type="button" class="primary" ?disabled=${k.saving} @click=${() => save(k)}>Save destination</button
        ><button
          type="button"
          ?disabled=${k.saving}
          @click=${() => {
            k.editing = false;
            c.setCronEditing(null);
            k.draw();
          }}
        >
          Cancel
        </button>
      </div>
    </div>`,
  );
}
export function cronTemplate(k: Data) {
  const { c, id, cron } = k;
  const prompt = cron.action || cron.message || "";
  return html`${k.editing ? editCard(k) : nothing}
    <div class="factlist">
      ${facts(cron)
        .filter(([, value]) => value != null && value !== "")
        .map(
          ([label, value]) =>
            html`<div class="fk">${label}</div>
              <div class="fv">${value}</div>`,
        )}
    </div>
    <div class="credential-actions" style="margin:0 0 18px">
      <button
        type="button"
        class="rowbtn"
        ?disabled=${k.saving}
        @click=${() => {
          Object.assign(k.draft, k.current());
          k.editing = true;
          c.setCronEditing(id);
          k.draw();
        }}
      >
        Edit destination</button
      ><button
        type="button"
        class="rowbtn danger"
        ?disabled=${k.saving || !cron.destination}
        @click=${() => save(k, true)}
      >
        Clear destination
      </button>
    </div>
    ${
      prompt
        ? card(
            cron.action ? "Prompt" : "Message",
            cron.action ? "Re-run as a fresh prompt at every fire." : "Delivered as-is at every fire.",
            html`<div>
              <p class=${"prompt-body" + (k.expanded ? "" : " clamped")}>${prompt}</p>
              ${
                k.needsToggle
                  ? html`<button
                      type="button"
                      class="prompt-toggle"
                      @click=${() => ((k.expanded = !k.expanded), k.draw())}
                    >
                      ${k.expanded ? "Show less" : "Show more"}
                    </button>`
                  : nothing
              }
            </div>`,
          )
        : nothing
    }${card(
      "Recent fires",
      "Each fire is a session. Click one to read its transcript. Dimmed fires delivered nothing.",
      html`<div>
        ${
          (k.error && empty(k.error)) ||
          (k.fires === null
            ? html`<div class="loadingline">Loading fires...</div>`
            : dense(
                k.fires,
                (s) => ({
                  name: relTime(s.createdAt || s.lastActivity),
                  preview: dot(
                    typeof s.delivered === "number" &&
                      (s.delivered ? "delivered" + (s.delivered > 1 ? " ×" + s.delivered : "") : "silent"),
                    plural(s.turns || 0, "turn"),
                    s.result || "(no messages)",
                  ),
                  time: plural(s.messages || 0, "entry", "entries"),
                  cls: typeof s.delivered === "number" && !s.delivered ? "dim" : "",
                  href: c.stateToUrl({ view: "history", scope: s.scopeId || c.scope, session: s.id }),
                }),
                (s) => c.go({ view: "history", scope: s.scopeId || c.scope, session: s.id }),
                "This cron has never fired.",
              ))
        }${k.total > 25 ? html`<button type="button" class="prompt-toggle" @click=${() => c.go({ view: "history", scope: c.scope, session: null, page: 1, historyKind: "cron", cron: id })}>${"All " + plural(k.total, "fire") + " →"}</button>` : nothing}
      </div>`,
    )}`;
}
