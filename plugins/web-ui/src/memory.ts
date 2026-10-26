import { html } from "lit";
import { Pencil, Trash2 } from "lucide";
import { api } from "./core-bridge";
import { appState } from "./shell";
import { artifactPage, iconBtn, listPageTpl } from "./list-page";

interface Fact {
  id: string;
  text: string;
  createdAt: number;
}

let facts: Fact[] = [];
let busy = false;
let editing: { id: string; text: string } | null = null;
const page = artifactPage("memory", "memory-page", "memory");

export function resetMemoryState(): void {
  facts = [];
  page.notice = "";
  busy = false;
  page.query = "";
  editing = null;
}

async function change(method: "PATCH" | "DELETE", body: object, done: string): Promise<void> {
  busy = true;
  page.notice = "";
  drawMemory();
  const save = async () => {
    facts = (await api<{ facts?: Fact[] }>("/api/memory", { method, body: JSON.stringify(body) })).facts ?? [];
  };
  if (await page.attempt(save, "Failed to save memory.", done)) editing = null;
  busy = false;
  page.notice = page.takeFlash();
  drawMemory();
}

function edit(next: typeof editing): void {
  editing = next;
  drawMemory();
}

function factRow(fact: Fact) {
  const { text } = fact;
  if (editing?.id === fact.id)
    return html`<div class="list-row memory-fact editing">
      <textarea
        class="memory-text"
        data-focus-key="memory-edit"
        ?disabled=${busy}
        .value=${editing.text}
        @input=${(e: Event) => (editing = { id: fact.id, text: (e.target as HTMLTextAreaElement).value })}
      ></textarea>
      <div class="memory-actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${busy || !editing.text.trim()}
          @click=${() => void change("PATCH", { facts: [editing!] }, "Saved ✓")}
        >
          Save
        </button>
        <button class="btn" type="button" @click=${() => edit(null)}>Cancel</button>
      </div>
    </div>`;
  return html`<div class="list-row memory-fact">
    <div>
      <div>${text}</div>
      <div class="card-meta">Captured ${new Date(fact.createdAt).toISOString().slice(0, 10)}</div>
    </div>
    ${iconBtn("Edit this fact", Pencil, () => edit({ id: fact.id, text }), { size: 15 })}
    ${iconBtn("Forget this fact", Trash2, () => void change("DELETE", { ids: [fact.id] }, "Forgotten ✓"), { size: 15, disabled: busy })}
  </div>`;
}

function drawMemory(): void {
  page.paint(
    listPageTpl({
      title: "Memory",
      search: page.search("Search remembered facts", drawMemory),
      notice: page.notice || (page.loading ? "Loading…" : ""),
      rows: facts.filter((fact) => page.matches(fact.text)).map(factRow),
      empty: page.query ? "No remembered facts match this search." : "The agent hasn’t noted any facts yet.",
    }),
    drawMemory,
  );
}

export async function renderMemory(): Promise<void> {
  if (appState.currentView !== "memory") return;
  if (editing) return drawMemory();
  const load = page.refresh(
    async () => {
      facts = (await api<{ facts?: Fact[] }>("/api/memory")).facts ?? [];
    },
    "Failed to load memory.",
    true,
  );
  drawMemory();
  await load;
  drawMemory();
}
