import { validEmail } from "../../chassis/src/email.ts";
import { html, render, nothing, type TemplateResult } from "lit";
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

class DeploymentPermissions {
  private readonly opener = document.activeElement as HTMLElement | null;
  private readonly dialog = document.createElement("dialog");
  private readonly title: string;
  private readonly owner: string;
  private grantees: Grant[] = [];
  private publicAccess = false;
  private externalSharing = true;
  private query = "";
  private access = "view";
  private selected: (DirectoryMatch & { email?: string }) | null = null;
  private readonly names = new Map<string, string>();
  private busy = true;
  private loaded = false;
  private error = "";
  private readonly endpoint: string;
  private readonly people: PeopleSearch;

  constructor(id: string, title: string, owner: string) {
    this.title = title;
    this.owner = owner;
    this.dialog.className = "project-dialog deployment-permissions-dialog";
    this.dialog.setAttribute("aria-labelledby", "deployment-permissions-heading");
    document.body.append(this.dialog);
    this.endpoint = `/api/deployments/${encodeURIComponent(id)}/share`;
    this.people = new PeopleSearch(
      () => this.draw(),
      (person) =>
        `personal:${person.principalId}` !== this.owner &&
        !this.grantees.some((grant) => grant.scope === `personal:${person.principalId}`),
    );
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (closeFormMenus()) return;
      this.close();
    });
  }

  private readonly close = () => {
    this.people.clear();
    closeFormMenus();
    this.dialog.close();
    this.dialog.remove();
    if (this.opener?.isConnected) this.opener.focus();
  };
  private readonly run = async (failure: string, task: () => Promise<void>) => {
    this.busy = true;
    this.error = "";
    this.draw();
    try {
      await task();
    } catch (e) {
      this.error = errMessage(e, failure);
    } finally {
      this.busy = false;
      if (this.dialog.isConnected) this.draw();
    }
  };
  private readonly post = async (body: Record<string, unknown>) => {
    const response = await api<{ public: boolean; grantees: Grant[]; invitation?: { emailProblem?: string } }>(
      this.endpoint,
      { method: "POST", body: JSON.stringify(body) },
    );
    this.publicAccess = response.public;
    this.grantees = response.grantees;
    return response;
  };
  private readonly change = async (scope: string, value: string, email?: string) => {
    if (this.busy) return;
    closeFormMenus();
    await this.run("Could not update permissions.", async () => {
      const response = await this.post({ ...(email ? { email } : { scope }), access: value });
      if (response.invitation?.emailProblem)
        this.error = `Access granted, but no invitation email was sent: ${response.invitation.emailProblem}`;
      this.selected = null;
      this.query = "";
      this.people.clear();
    });
  };
  private readonly orgGrant = (): Grant | undefined => this.grantees.find(isOrgGrant);
  private readonly generalAccess = (): GeneralAccess => {
    if (this.publicAccess) return "public";
    return this.orgGrant() ? "org" : "restricted";
  };
  private readonly changeGeneral = async (next: GeneralAccess) => {
    if (this.busy || next === this.generalAccess() || (next === "public" && !this.externalSharing)) return;
    closeFormMenus();
    await this.run("Could not update general access.", async () => {
      if (next === "public") return void (await this.post({ public: true }));
      if (this.publicAccess) await this.post({ public: false });
      const grant = this.orgGrant();
      if (next === "org" && !grant) await this.post({ scope: "org", access: "view" });
      if (next === "restricted" && grant) await this.post({ scope: grant.scope, access: "none" });
    });
  };
  private readonly orgName = (): string => appState.me?.companyName?.trim() || "Your organization";
  private readonly generalAccessNote = (): string => {
    const level = this.generalAccess();
    if (level === "public") return "Anyone on the internet with the link can open. No sign-in required";
    if (level === "org") return `Anyone signed in to ${this.orgName()} can open`;
    return "Only people with access can open";
  };
  private readonly emailCandidate = (): string | null => {
    const email = this.query.trim().toLowerCase();
    if (!this.externalSharing) return null;
    if (!validEmail(email)) return null;
    const taken = [this.owner, ...this.grantees.map((g) => g.scope)].some(
      (s) => s.toLowerCase() === `personal:${email}`,
    );
    return taken || this.people.matches.some((m) => m.principalId.toLowerCase() === email) ? null : email;
  };
  private readonly permissionMenu = (
    value: string,
    label: string,
    update: (value: string) => void,
    removable = false,
  ) =>
    html`<fieldset class="permission-control" ?disabled=${this.busy}>
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
  readonly draw = () =>
    render(
      html`
        <div class="project-dialog-head">
          <div>
            <h2 id="deployment-permissions-heading">App permissions</h2>
            <p>${this.title}</p>
          </div>
          <button class="chip-x" type="button" aria-label="Close" @click=${this.close}>${icon(X, 16)}</button>
        </div>
        ${this.loaded ? this.searchTpl() : nothing}
        <div class="permission-section-label">People with access</div>
        <div class="project-member-list">
          <div class="permission-row">
            ${avatarTpl({ key: this.owner, name: this.owner.replace("personal:", "") })}<span
              class="permission-person-label"
              >${this.owner.startsWith("personal:") ? friendlyPrincipal(this.owner.slice(9)) : scopeChip(this.owner)}</span
            ><span class="permission-owner">Owner</span>
          </div>
          ${this.grantees.filter((grant) => this.generalAccess() !== "org" || !isOrgGrant(grant)).map((grant) => html`<div class="permission-row">${avatarTpl({ key: grant.scope, name: isOrgGrant(grant) ? this.orgName() : grant.scope.replace("personal:", "") })}<span class="permission-person-label">${isOrgGrant(grant) ? this.orgName() : (this.names.get(grant.scope) ?? (grant.scope.startsWith("personal:") ? grant.scope.slice(9) : scopeChip(grant.scope)))}${this.names.has(grant.scope) ? html`<small>${grant.scope.replace("personal:", "")}</small>` : nothing}</span>${this.permissionMenu(grant.permission === "write" ? "manage" : "view", `Access for ${grant.scope}`, (value) => void this.change(grant.scope, value), true)}</div>`)}
        </div>
        <div class="permission-section-label permission-general-label">General access</div>
        <div class="project-member-list">
          <div class="permission-row">
            <span class="project-member-avatar" aria-hidden="true"
              >${icon({ public: Globe, org: Building2, restricted: Lock }[this.generalAccess()], 16)}</span
            >
            <span class="permission-person-label">
              <fieldset class="permission-control general-access-control" ?disabled=${this.busy}>
                ${menuSelect({
                  value: this.generalAccess(),
                  ariaLabel: "General access",
                  className: "general-access-menu",
                  options: [
                    { value: "restricted", label: "Restricted" },
                    { value: "org", label: this.orgName() },
                    {
                      value: "public",
                      label: "Anyone with the link",
                      ...(this.externalSharing
                        ? {}
                        : { disabledHint: "An org admin must turn on external app sharing first." }),
                    },
                  ],
                  onSelect: (next) => {
                    if (next === "restricted" || next === "org" || next === "public") void this.changeGeneral(next);
                  },
                })}
              </fieldset>
              <small>${this.generalAccessNote()}</small>
            </span>
            ${(() => {
              const grant = this.generalAccess() === "org" ? this.orgGrant() : undefined;
              return grant
                ? this.permissionMenu(
                    grant.permission === "write" ? "manage" : "view",
                    `Access for ${this.orgName()}`,
                    (value) => void this.change(grant.scope, value),
                  )
                : nothing;
            })()}
          </div>
        </div>
        ${
          this.publicAccess
            ? html`<p class="share-external-warning" role="status">⚠️ Public. Anyone can open this app.</p>`
            : nothing
        }
        ${this.busy ? html`<p role="status">Loading…</p>` : nothing}
        ${this.error || this.people.error ? html`<p class="composer-error" role="alert">${this.error || this.people.error}</p>` : nothing}
        <div class="project-dialog-actions actions"><button class="btn" @click=${this.close}>Done</button></div>
      `,
      this.dialog,
    );

  private searchTpl(): TemplateResult {
    return html` <div class="permission-search">
      ${
        this.selected
          ? html`<div class="permission-invite">
              <div class="permission-person">
                ${avatarTpl({
                  key: this.selected.principalId,
                  name: this.selected.displayName,
                  avatarUrl: this.selected.avatarUrl,
                })}<span class="permission-person-label"
                  >${this.selected.displayName}<small>${this.selected.principalId}</small></span
                >
              </div>
              <button
                class="chip-x"
                aria-label="Cancel selection"
                ?disabled=${this.busy}
                @click=${() => {
                  this.selected = null;
                  this.draw();
                }}
              >
                ${icon(X, 14)}
              </button>
              <div class="permission-invite-actions">
                ${
                  this.selected.email
                    ? html`<span class="permission-note">Can view</span>`
                    : this.permissionMenu(this.access, "New person's access", (value) => {
                        this.access = value;
                        this.draw();
                      })
                }<button
                  class="btn primary"
                  ?disabled=${this.busy}
                  @click=${() => {
                    if (this.selected) {
                      this.names.set(`personal:${this.selected.principalId}`, this.selected.displayName);
                      void this.change(
                        `personal:${this.selected.principalId}`,
                        this.selected.email ? "view" : this.access,
                        this.selected.email,
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
                if (this.query.trim()) void this.people.run(this.query.trim());
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
                  .value=${live(this.query)}
                  ?disabled=${this.busy}
                  @input=${(event: Event) => {
                    this.query = (event.currentTarget as HTMLInputElement).value;
                    this.people.schedule(this.query);
                  }}
                />
              </div>
              ${peopleResults(this.people.matches, this.busy, (person) => {
                this.selected = person;
                closeFormMenus();
                this.draw();
              })}
              ${
                !this.people.searching && this.people.searchedQuery && this.emailCandidate()
                  ? html`
                      <button
                        class="project-member-result"
                        type="button"
                        ?disabled=${this.busy}
                        @click=${() => {
                          const email = this.emailCandidate();
                          if (!email) return;
                          this.selected = { principalId: email, displayName: email, type: "guest", email };
                          this.access = "view";
                          closeFormMenus();
                          this.draw();
                        }}
                      >
                        Add ${this.emailCandidate()} with view access
                      </button>
                      <p class="permission-note">
                        They receive an app link by email and sign in with this address. This does not add them to your
                        organization.
                      </p>
                    `
                  : nothing
              }
              ${this.people.searching ? html`<p class="permission-note" role="status">Searching…</p>` : nothing}
              ${!this.people.searching && this.people.searchedQuery && !this.people.matches.length && !this.emailCandidate() ? html`<p class="permission-note">No additional people found.</p>` : nothing}
            </form>`
      }
    </div>`;
  }

  async open(): Promise<void> {
    this.draw();
    this.dialog.showModal();
    await this.run("Could not load permissions.", async () => {
      const response = await api<{ public: boolean; externalSharing?: boolean; grantees: Grant[] }>(this.endpoint);
      this.publicAccess = response.public;
      this.externalSharing = response.externalSharing !== false;
      this.grantees = response.grantees;
      this.loaded = true;
    });
  }
}

export async function openDeploymentPermissions(id: string, title: string, owner: string): Promise<void> {
  await new DeploymentPermissions(id, title, owner).open();
}
