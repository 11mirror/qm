import { html, type TemplateResult } from "lit";
import { Plus } from "lucide";
import { avatarTpl } from "./ui";
import { icon } from "./icons";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";

export interface DirectoryMatch {
  principalId: string;
  displayName: string;
  type: string;
  avatarUrl?: string;
}

export function peopleResults(
  matches: DirectoryMatch[],
  busy: boolean,
  select: (person: DirectoryMatch) => void,
): TemplateResult {
  return html`<div class="project-member-results">
    ${matches.slice(0, 8).map(
      (person) =>
        html` <button class="project-member-result" type="button" ?disabled=${busy} @click=${() => select(person)}>
          ${avatarTpl({ key: person.principalId, name: person.displayName, avatarUrl: person.avatarUrl })}
          <span class="project-member-name" dir="auto">${person.displayName}</span>${icon(Plus, 15)}
        </button>`,
    )}
  </div>`;
}

export class PeopleSearch {
  matches: DirectoryMatch[] = [];
  searching = false;
  searchedQuery = "";
  error = "";
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly keep: (match: DirectoryMatch) => boolean = () => true,
  ) {}

  cancel(): void {
    this.seq++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.searching = false;
  }

  clear(): boolean {
    const visible = this.searching || this.error !== "" || this.searchedQuery !== "" || this.matches.length > 0;
    this.cancel();
    this.matches = [];
    this.searchedQuery = "";
    this.error = "";
    return visible;
  }

  schedule(query: string, minLength = 1): void {
    const visible = this.clear();
    const term = query.trim();
    if (term.length >= minLength) this.timer = setTimeout(() => void this.run(term), 250);
    if (visible) this.onChange();
  }

  async run(query: string): Promise<void> {
    this.clear();
    const seq = this.seq;
    this.searching = true;
    this.onChange();
    try {
      const response = await api<{ matches?: DirectoryMatch[] }>(
        `/api/directory/resolve?q=${encodeURIComponent(query)}`,
      );
      if (seq !== this.seq) return;
      this.matches = (response.matches ?? []).filter(this.keep);
      this.searchedQuery = query;
    } catch (error) {
      if (seq !== this.seq) return;
      this.error = errMessage(error, "Couldn't search for people.");
    } finally {
      if (seq === this.seq) {
        this.searching = false;
        this.onChange();
      }
    }
  }
}
