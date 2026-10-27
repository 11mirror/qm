import { PeopleSearch, peopleResults, type DirectoryMatch } from "./people-results";
import { html, nothing, type TemplateResult } from "lit";
import { Hash, Search, X, type IconNode } from "lucide";
import { api, type CoreContext } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { avatarTpl } from "./ui";
import { icon } from "./icons";
import { appState } from "./shell";
import { askConfirm } from "./dialog-focus";
import { iconBtn } from "./list-page";
import { tip } from "./tooltip";
import {
  contextsResetSeq,
  contextsState,
  drawContexts,
  projectFromResponse,
  projectPeople,
  setContexts,
  upsertProject,
} from "./contexts";

export const memberSearch = new PeopleSearch(
  () => drawContexts(),
  (match) => match.type === "internal",
);

function memberLabel(context: CoreContext, principalId: string): string {
  if (principalId === appState.me?.user) return "You";
  return context.project?.members.find((member) => member.principalId === principalId)?.displayName || principalId;
}

async function linkProjectSlackChannel(context: CoreContext): Promise<void> {
  const channel = contextsState.slackValue.trim().replace(/^#/, "");
  if (!channel || contextsState.slackBusy) return;
  await mutateProject(
    context,
    "slack",
    "/slack-channel",
    { method: "PUT", body: JSON.stringify({ channel }) },
    "Couldn't link that channel. You must be a member of it.",
    () => {
      contextsState.slackEditing = false;
      contextsState.slackValue = "";
    },
  );
}

async function unlinkProjectSlackChannel(context: CoreContext): Promise<void> {
  const linked = context.project?.slackChannel;
  if (!linked || contextsState.slackBusy) return;
  const confirmed = await askConfirm({
    id: "project-unlink",
    title: `Unlink #${linked.channelName} from ${context.name || "this project"}?`,
    confirm: "Unlink",
  });
  if (!confirmed) return;
  await mutateProject(context, "slack", "/slack-channel", { method: "DELETE" }, "Couldn't unlink the channel.");
}

async function mutateProject(
  context: CoreContext,
  kind: "member" | "slack",
  path: string,
  init: RequestInit,
  failure: string,
  onOk = () => {},
): Promise<void> {
  if (!context.project) return;
  const busy = kind === "member" ? "memberBusy" : "slackBusy";
  const error = kind === "member" ? "memberError" : "slackError";
  const resetSeq = contextsResetSeq;
  setContexts({ [busy]: true, [error]: "" });
  try {
    const project = projectFromResponse(
      await api(`/api/projects/${encodeURIComponent(context.project.id)}${path}`, init),
    );
    if (resetSeq !== contextsResetSeq) return;
    if (!project) throw new Error("Core returned an invalid project");
    upsertProject(project);
    onOk();
  } catch (e) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState[error] = errMessage(e, failure);
  } finally {
    if (resetSeq === contextsResetSeq) setContexts({ [busy]: false });
  }
}

export function projectSlackSection(context: CoreContext): TemplateResult {
  const linked = context.project!.slackChannel;
  const channels = [
    ...new Set(
      contextsState.list
        .filter((c) => c.kind === "channel" && c.name)
        .map((c) => c.name!.replace(/^#/, ""))
        .sort(),
    ),
  ];
  let body = html`
    <button
      class="btn project-slack-link"
      type="button"
      ?disabled=${contextsState.slackBusy}
      @click=${() => setContexts({ slackEditing: true, slackError: "" })}
    >
      ${icon(Hash, 15)}<span>Link a channel</span>
    </button>
    <p class="context-hint">
      Give this project a home channel on Slack. The agent will post updates there, and everyone in the channel joins
      the project.
    </p>
  `;
  if (linked)
    body = html`
      <div class="project-member-row">
        <span class="context-glyph" aria-hidden="true">${icon(Hash, 15)}</span>
        <span class="project-member-name" dir="auto">${linked.channelName}</span>
        ${projectBtn(`Unlink #${linked.channelName}`, X, () => void unlinkProjectSlackChannel(context), contextsState.slackBusy, "project-icon-button danger")}
      </div>
      <p class="context-hint">
        The agent posts this project's updates to #${linked.channelName}, and everyone in the channel is in the project.
      </p>
    `;
  else if (contextsState.slackEditing)
    body = html`
      <form
        class="project-slack-form"
        @submit=${(e: Event) => {
          e.preventDefault();
          void linkProjectSlackChannel(context);
        }}
      >
        <div class="project-member-search-row">
          ${icon(Hash, 16)}
          <input
            type="text"
            data-focus-key="project-slack-channel"
            autocomplete="off"
            maxlength="200"
            placeholder="channel name"
            list="project-slack-channels"
            aria-label="Slack channel to link"
            .value=${contextsState.slackValue}
            ?disabled=${contextsState.slackBusy}
            @input=${(e: Event) => {
              contextsState.slackValue = (e.target as HTMLInputElement).value;
            }}
          />
        </div>
        <datalist id="project-slack-channels">
          ${channels.map((name) => html`<option value=${name}></option>`)}
        </datalist>
        <div class="project-slack-actions">
          <button class="btn primary" type="submit" ?disabled=${contextsState.slackBusy}>Link</button>
          <button
            class="btn"
            type="button"
            ?disabled=${contextsState.slackBusy}
            @click=${() => setContexts({ slackEditing: false, slackValue: "", slackError: "" })}
          >
            Cancel
          </button>
        </div>
      </form>
    `;
  return html`
    <section class="context-panel project-slack" aria-labelledby="project-slack-title">
      <div class="context-panel-heading">
        <h2 class="context-panel-title" id="project-slack-title">Slack channel</h2>
      </div>
      ${body}
      ${contextsState.slackError ? html`<div class="project-member-status error" aria-live="polite">${contextsState.slackError}</div>` : nothing}
    </section>
  `;
}

export function projectMembersSection(context: CoreContext): TemplateResult {
  const project = context.project!;
  const pickerOpen = contextsState.memberProjectId === project.id;
  const searchingOrBusy = memberSearch.searching || contextsState.memberBusy;
  const memberError = contextsState.memberError || memberSearch.error;
  return html`
    <section class="context-panel project-members" aria-labelledby="project-people-title">
      <div class="context-panel-heading">
        <h2 class="context-panel-title" id="project-people-title">People</h2>
        <span class="context-panel-count">${projectPeople(context).length}</span>
      </div>
      <div class="project-member-list">
        ${projectPeople(context).map((principalId) => {
          const label = memberLabel(context, principalId);
          const member = project.members.find((m) => m.principalId === principalId);
          const viaChannel = Boolean(member?.viaChannel);
          return html`
            <div class="project-member-row">
              ${avatarTpl({ key: principalId, name: label, avatarUrl: member?.avatarUrl })}
              <span class="project-member-name" dir="auto">${label}</span>
              ${principalId === project.ownerId ? html`<span class="badge">Owner</span>` : nothing}
              ${
                viaChannel && project.slackChannel
                  ? html`<span class="badge" ${tip("Joined via the linked Slack channel")}
                      ><bdi>#${project.slackChannel.channelName}</bdi></span
                    >`
                  : nothing
              }
              ${
                project.ownerId === appState.me?.user && principalId !== project.ownerId && !viaChannel
                  ? projectBtn(
                      `Remove ${label}`,
                      X,
                      () => void removeProjectMember(context, principalId),
                      searchingOrBusy,
                      "project-icon-button danger",
                    )
                  : nothing
              }
            </div>
          `;
        })}
      </div>
      ${pickerOpen ? memberPicker(context) : nothing}
      ${memberError ? html`<div class="project-member-status error" aria-live="polite">${memberError}</div>` : nothing}
    </section>
  `;
}

const projectBtn = (
  label: string,
  glyph: IconNode,
  onClick: () => void,
  disabled: boolean,
  cls = "project-icon-button",
) => iconBtn(label, glyph, onClick, { cls, size: 15, disabled });

function memberPicker(context: CoreContext): TemplateResult {
  const members = new Set(projectPeople(context));
  const matches = memberSearch.matches.filter((match) => !members.has(match.principalId));
  const searchingOrBusy = memberSearch.searching || contextsState.memberBusy;
  let memberStatus = "";
  if (memberSearch.searching) memberStatus = "Searching…";
  else if (contextsState.memberBusy) memberStatus = "Working…";
  else if (!contextsState.memberError && memberSearch.searchedQuery && matches.length === 0)
    memberStatus = memberSearch.matches.length
      ? "Everyone matching is already in this project."
      : `No matches for “${memberSearch.searchedQuery}”.`;
  return html`
    <form class="project-member-picker" @submit=${(event: SubmitEvent) => void searchProjectMembers(event, context)}>
      <label for="project-member-search">Add people</label>
      <div class="project-member-search-row">
        ${icon(Search, 16)}
        <input
          id="project-member-search"
          data-focus-key="project-member-search"
          name="query"
          type="search"
          autocomplete="off"
          maxlength="80"
          placeholder="Search by name or handle"
          .value=${contextsState.memberQuery}
          ?disabled=${contextsState.memberBusy}
          @input=${(event: InputEvent) => {
            contextsState.memberQuery = (event.currentTarget as HTMLInputElement).value;
            clearSlackDraft();
            setContexts({ memberError: "" }, contextsState.memberError !== "");
            memberSearch.schedule(contextsState.memberQuery, 2);
          }}
        />
        ${iconBtn("Search", Search, undefined, { cls: "project-icon-button", size: 15, submit: true, disabled: searchingOrBusy })}
        ${projectBtn("Close", X, () => resetMemberPicker(null, true), contextsState.memberBusy)}
      </div>
      ${peopleResults(matches, searchingOrBusy, (match) => void addProjectMember(context, match))}
      <div class="project-member-status" aria-live="polite">${memberStatus}</div>
    </form>
  `;
}

export function resetMemberPicker(projectId: string | null, draw = false): void {
  memberSearch.clear();
  setContexts({ memberProjectId: projectId, memberQuery: "", memberError: "" }, false);
  clearSlackDraft();
  if (draw) drawContexts();
}

function clearSlackDraft(): void {
  setContexts({ slackEditing: false, slackValue: "", slackBusy: false, slackError: "" }, false);
}

export function toggleMemberPicker(context: CoreContext): void {
  resetMemberPicker(contextsState.memberProjectId === context.project?.id ? null : (context.project?.id ?? null), true);
  if (contextsState.memberProjectId)
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-member-search")?.focus());
}

async function searchProjectMembers(event: SubmitEvent, context: CoreContext): Promise<void> {
  event.preventDefault();
  if (!context.project || contextsState.memberBusy) return;
  const input = (event.currentTarget as HTMLFormElement).elements.namedItem("query") as HTMLInputElement | null;
  const query = input?.value.trim() ?? "";
  setContexts({ memberQuery: query, memberError: "" }, false);
  if (query.length >= 2) return memberSearch.run(query);
  memberSearch.clear();
  setContexts({ memberError: "Enter at least two characters." });
}

async function addProjectMember(context: CoreContext, member: DirectoryMatch): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  memberSearch.cancel();
  await mutateProject(
    context,
    "member",
    "/members",
    { method: "POST", body: JSON.stringify({ memberId: member.principalId }) },
    "Couldn't add that person.",
    () => {
      memberSearch.clear();
      setContexts({ memberQuery: "" }, false);
    },
  );
}

async function removeProjectMember(context: CoreContext, principalId: string): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  const label = memberLabel(context, principalId);
  const confirmed = await askConfirm({
    id: "project-member-remove",
    title: `Remove ${label} from ${context.name || "this project"}?`,
    confirm: "Remove",
  });
  if (!confirmed) return;
  memberSearch.cancel();
  await mutateProject(
    context,
    "member",
    `/members/${encodeURIComponent(principalId)}`,
    { method: "DELETE" },
    "Couldn't remove that person.",
  );
}
