import { validEmail } from "../../chassis/src/email.ts";
import { html, render, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { Building2, Globe, Lock, Search, X } from "lucide";
import { api } from "./core-bridge";
import { avatarTpl, closeFormMenus, menuSelect } from "./ui";
import { icon } from "./icons";
import { scopeChip } from "./contexts";
import { friendlyPrincipal } from "./deploy-view";
import { errMessage } from "../../chassis/src/errors";
import { PeopleSearch, peopleResults, type DirectoryMatch } from "./people-results";
import { appState } from "./shell-state";

interface Grant {
  scope: string;
  permission: "read" | "write";
}

type GeneralAccess = "restricted" | "org" | "public";

const isOrgGrant = (grant: Grant): boolean => grant.scope === "org" || grant.scope.startsWith("org:");

export async function openDeploymentPermissions(id: string, title: string, owner: string): Promise<void> {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog deployment-permissions-dialog";
  dialog.setAttribute("aria-labelledby", "deployment-permissions-heading");
  document.body.append(dialog);
  let grantees: Grant[] = [];
  let publicAccess = false;
  let externalSharing = true;
  let query = "";
  let access = "view";
  let selected: (DirectoryMatch & { email?: string }) | null = null;
  const names = new Map<string, string>();
  let busy = true;
  let loaded = false;
  let error = "";
  const endpoint = `/api/deployments/${encodeURIComponent(id)}/share`;
  const people = new PeopleSearch(
    () => draw(),
    (person) =>
      `personal:${person.principalId}` !== owner &&
      !grantees.some((grant) => grant.scope === `personal:${person.principalId}`),
  );
  const close = () => {
    people.clear();
    closeFormMenus();
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (closeFormMenus()) return;
    close();
  });
  const run = async (failure: string, task: () => Promise<void>) => {
    busy = true;
    error = "";
    draw();
    try {
      await task();
    } catch (e) {
      error = errMessage(e, failure);
    } finally {
      busy = false;
      if (dialog.isConnected) draw();
    }
  };
  const post = async (body: Record<string, unknown>) => {
    const response = await api<{ public: boolean; grantees: Grant[]; invitation?: { emailProblem?: string } }>(
      endpoint,
      { method: "POST", body: JSON.stringify(body) },
    );
    publicAccess = response.public;
    grantees = response.grantees;
    return response;
  };
  const change = async (scope: string, value: string, email?: string) => {
    if (busy) return;
    closeFormMenus();
    await run("Could not update permissions.", async () => {
      const response = await post({ ...(email ? { email } : { scope }), access: value });
      if (response.invitation?.emailProblem)
        error = `Access granted, but no invitation email was sent: ${response.invitation.emailProblem}`;
      selected = null;
      query = "";
      people.clear();
    });
  };
  const orgGrant = (): Grant | undefined => grantees.find(isOrgGrant);
  const generalAccess = (): GeneralAccess => {
    if (publicAccess) return "public";
    return orgGrant() ? "org" : "restricted";
  };
  const changeGeneral = async (next: GeneralAccess) => {
    if (busy || next === generalAccess() || (next === "public" && !externalSharing)) return;
    closeFormMenus();
    await run("Could not update general access.", async () => {
      if (next === "public") return void (await post({ public: true }));
      if (publicAccess) await post({ public: false });
      const grant = orgGrant();
      if (next === "org" && !grant) await post({ scope: "org", access: "view" });
      if (next === "restricted" && grant) await post({ scope: grant.scope, access: "none" });
    });
  };
  const orgName = (): string => appState.me?.companyName?.trim() || "Your organization";
  const generalAccessNote = (): string => {
    const level = generalAccess();
    if (level === "public") return "Anyone on the internet with the link can open. No sign-in required";
    if (level === "org") return `Anyone signed in to ${orgName()} can open`;
    return "Only people with access can open";
  };
  const emailCandidate = (): string | null => {
    const email = query.trim().toLowerCase();
    if (!externalSharing) return null;
    if (!validEmail(email)) return null;
    const taken = [owner, ...grantees.map((g) => g.scope)].some((s) => s.toLowerCase() === `personal:${email}`);
    return taken || people.matches.some((m) => m.principalId.toLowerCase() === email) ? null : email;
  };
  const permissionMenu = (value: string, label: string, update: (value: string) => void, removable = false) =>
    html`<fieldset class="permission-control" ?disabled=${busy}>
      ${menuSelect({
        value,
        ariaLabel: label,
        options: [
          { value: "view", label: "Can view" },
          { value: "manage", label: "Can manage" },
          ...(removable ? [{ value: "none", label: "Remove access" }] : []),
        ],
        onSelect: (next) => {
          if (next) update(next);
        },
      })}
    </fieldset>`;
  const draw = () =>
    render(
      html`
        <div class="project-dialog-head">
          <div>
            <h2 id="deployment-permissions-heading">App permissions</h2>
            <p>${title}</p>
          </div>
          <button class="chip-x" type="button" aria-label="Close" @click=${close}>${icon(X, 16)}</button>
        </div>
        ${
          loaded
            ? html` <div class="permission-search">
                ${
                  selected
                    ? html`<div class="permission-invite">
                        <div class="permission-person">
                          ${avatarTpl({
                            key: selected.principalId,
                            name: selected.displayName,
                            avatarUrl: selected.avatarUrl,
                          })}<span class="permission-person-label"
                            >${selected.displayName}<small>${selected.principalId}</small></span
                          >
                        </div>
                        <button
                          class="chip-x"
                          aria-label="Cancel selection"
                          ?disabled=${busy}
                          @click=${() => {
                            selected = null;
                            draw();
                          }}
                        >
                          ${icon(X, 14)}
                        </button>
                        <div class="permission-invite-actions">
                          ${
                            selected.email
                              ? html`<span class="permission-note">Can view</span>`
                              : permissionMenu(access, "New person's access", (value) => {
                                  access = value;
                                  draw();
                                })
                          }<button
                            class="btn primary"
                            ?disabled=${busy}
                            @click=${() => {
                              if (selected) {
                                names.set(`personal:${selected.principalId}`, selected.displayName);
                                void change(
                                  `personal:${selected.principalId}`,
                                  selected.email ? "view" : access,
                                  selected.email,
                                );
                              }
                            }}
                          >
                            Add
                          </button>
                        </div>
                      </div>`
                    : html`<form
                        @submit=${(event: SubmitEvent) => {
                          event.preventDefault();
                          if (query.trim()) void people.run(query.trim());
                        }}
                      >
                        <div class="project-member-search-row">
                          ${icon(Search, 16)}<input
                            id="app-people-query"
                            aria-label="Add people"
                            placeholder="Add people by name or email"
                            type="search"
                            autocomplete="off"
                            maxlength="254"
                            .value=${live(query)}
                            ?disabled=${busy}
                            @input=${(event: Event) => {
                              query = (event.currentTarget as HTMLInputElement).value;
                              people.schedule(query);
                            }}
                          />
                        </div>
                        ${peopleResults(people.matches, busy, (person) => {
                          selected = person;
                          closeFormMenus();
                          draw();
                        })}
                        ${
                          !people.searching && people.searchedQuery && emailCandidate()
                            ? html`
                                <button
                                  class="project-member-result"
                                  type="button"
                                  ?disabled=${busy}
                                  @click=${() => {
                                    const email = emailCandidate();
                                    if (!email) return;
                                    selected = { principalId: email, displayName: email, type: "guest", email };
                                    access = "view";
                                    closeFormMenus();
                                    draw();
                                  }}
                                >
                                  Add ${emailCandidate()} with view access
                                </button>
                                <p class="permission-note">
                                  They receive an app link by email and sign in with this address. This does not add
                                  them to your organization.
                                </p>
                              `
                            : nothing
                        }
                        ${people.searching ? html`<p class="permission-note" role="status">Searching…</p>` : nothing}
                        ${!people.searching && people.searchedQuery && !people.matches.length && !emailCandidate() ? html`<p class="permission-note">No additional people found.</p>` : nothing}
                      </form>`
                }
              </div>`
            : nothing
        }
        <div class="permission-section-label">People with access</div>
        <div class="project-member-list">
          <div class="permission-row">
            ${avatarTpl({ key: owner, name: owner.replace("personal:", "") })}<span class="permission-person-label"
              >${owner.startsWith("personal:") ? friendlyPrincipal(owner.slice(9)) : scopeChip(owner)}</span
            ><span class="permission-owner">Owner</span>
          </div>
          ${grantees.filter((grant) => generalAccess() !== "org" || !isOrgGrant(grant)).map((grant) => html`<div class="permission-row">${avatarTpl({ key: grant.scope, name: isOrgGrant(grant) ? orgName() : grant.scope.replace("personal:", "") })}<span class="permission-person-label">${isOrgGrant(grant) ? orgName() : (names.get(grant.scope) ?? (grant.scope.startsWith("personal:") ? grant.scope.slice(9) : scopeChip(grant.scope)))}${names.has(grant.scope) ? html`<small>${grant.scope.replace("personal:", "")}</small>` : nothing}</span>${permissionMenu(grant.permission === "write" ? "manage" : "view", `Access for ${grant.scope}`, (value) => void change(grant.scope, value), true)}</div>`)}
        </div>
        <div class="permission-section-label permission-general-label">General access</div>
        <div class="project-member-list">
          <div class="permission-row">
            <span class="project-member-avatar" aria-hidden="true"
              >${icon({ public: Globe, org: Building2, restricted: Lock }[generalAccess()], 16)}</span
            >
            <span class="permission-person-label">
              <fieldset class="permission-control general-access-control" ?disabled=${busy}>
                ${menuSelect({
                  value: generalAccess(),
                  ariaLabel: "General access",
                  className: "general-access-menu",
                  options: [
                    { value: "restricted", label: "Restricted" },
                    { value: "org", label: orgName() },
                    {
                      value: "public",
                      label: "Anyone with the link",
                      ...(externalSharing
                        ? {}
                        : { disabledHint: "An org admin must turn on external app sharing first." }),
                    },
                  ],
                  onSelect: (next) => {
                    if (next === "restricted" || next === "org" || next === "public") void changeGeneral(next);
                  },
                })}
              </fieldset>
              <small>${generalAccessNote()}</small>
            </span>
            ${(() => {
              const grant = generalAccess() === "org" ? orgGrant() : undefined;
              return grant
                ? permissionMenu(
                    grant.permission === "write" ? "manage" : "view",
                    `Access for ${orgName()}`,
                    (value) => void change(grant.scope, value),
                  )
                : nothing;
            })()}
          </div>
        </div>
        ${
          publicAccess
            ? html`<p class="share-external-warning" role="status">⚠️ Public. Anyone can open this app.</p>`
            : nothing
        }
        ${busy ? html`<p role="status">Loading…</p>` : nothing}
        ${error || people.error ? html`<p class="composer-error" role="alert">${error || people.error}</p>` : nothing}
        <div class="project-dialog-actions actions"><button class="btn" @click=${close}>Done</button></div>
      `,
      dialog,
    );
  draw();
  dialog.showModal();
  await run("Could not load permissions.", async () => {
    const response = await api<{ public: boolean; externalSharing?: boolean; grantees: Grant[] }>(endpoint);
    publicAccess = response.public;
    externalSharing = response.externalSharing !== false;
    grantees = response.grantees;
    loaded = true;
  });
}
