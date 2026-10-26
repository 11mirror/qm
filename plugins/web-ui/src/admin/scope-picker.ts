import { el, stacked } from "./dom.ts";
import { scopeKind } from "./format.ts";

export interface ScopeChoice {
  scopeId: string;
  label: string;
}

export function scopeMultiSelect(
  choices: ScopeChoice[],
  selected: Set<string>,
  onChange: () => void,
  dirLabel: (id: string) => string,
) {
  const row = "display:flex; align-items:center; gap:6px; flex-wrap:wrap;";
  const pick = el("div.scopepick", { style: row });
  const labelOf = (id: string) => choices.find((c) => c.scopeId === id)?.label || dirLabel(id) || id;
  const orgFirst = (ids: string[]) =>
    ids.sort((a: string, b: string) => {
      if (scopeKind(a) === "org") return -1;
      if (scopeKind(b) === "org") return 1;
      return a.localeCompare(b);
    });
  const changed = () => {
    renderChips();
    renderList();
    onChange();
  };
  const chips = el("div", { style: row });
  const renderChips = (): void => {
    if (!selected.size)
      return chips.replaceChildren(
        el("span", { style: "font-size:12px; color:var(--muted);", textContent: "no scopes selected" }),
      );
    chips.replaceChildren(
      ...orgFirst([...selected]).map((id) => {
        const remove = el("button", {
          type: "button",
          textContent: "✕",
          "aria-label": "Remove " + labelOf(id),
          style:
            "border:none; background:transparent; cursor:pointer; color:var(--muted); font-size:11px; line-height:1; padding:0 1px;",
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            selected.delete(id);
            changed();
          },
        });
        const style =
          "display:inline-flex; align-items:center; gap:5px; padding:2px 5px 2px 9px; border:1px solid var(--border); border-radius:12px; background:var(--subtle); font-size:12px; white-space:nowrap;";
        return el("span", { style, title: id }, el("span", labelOf(id)), remove);
      }),
    );
  };
  const addBtn = el("button.rowbtn", {
    type: "button",
    textContent: "+ Add scope ▾",
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
  });
  const filter = el("input", {
    type: "text",
    placeholder: "Filter scopes…",
    autocapitalize: "none",
    style:
      "width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--border); border-radius:var(--radius); font:inherit;",
  }) as HTMLInputElement;
  filter.spellcheck = false;
  const list = el("div.scope-list", { role: "listbox" });
  const bulkLink = (text: string, onclick: () => void) =>
    el("button", {
      type: "button",
      textContent: text,
      style:
        "border:none; background:transparent; cursor:pointer; color:var(--text); font:inherit; font-size:12px; text-decoration:underline; text-underline-offset:2px; padding:0;",
      onclick,
    });
  const bulk = el(
    "div",
    { style: "display:flex; gap:14px; padding:8px 10px; border-top:1px solid var(--border);" },
    bulkLink("Select all", () => {
      choices.forEach((c) => selected.add(c.scopeId));
      changed();
    }),
    bulkLink("Clear", () => {
      selected.clear();
      changed();
    }),
  );
  const renderList = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = choices.filter((c) => !q || c.label.toLowerCase().includes(q) || c.scopeId.toLowerCase().includes(q));
    if (!shown.length) return list.replaceChildren(el("div.scope-note", "No scopes match."));
    list.replaceChildren(
      ...shown.map((c) => {
        const on = selected.has(c.scopeId);
        const name = el("span.scope-name", {}, stacked(c.label, c.label === c.scopeId ? "" : c.scopeId));
        return el(
          "button.scope-option" + (on ? " selected" : ""),
          {
            type: "button",
            role: "option",
            "aria-selected": String(on),
            title: c.scopeId,
            onclick: () => {
              if (selected.has(c.scopeId)) selected.delete(c.scopeId);
              else selected.add(c.scopeId);
              changed();
              filter.focus();
            },
          },
          name,
          el("span.count", on ? "✓" : ""),
        );
      }),
    );
  };
  const menu = el(
    "div.scope-menu hidden",
    { style: "left:0; right:auto; width:min(320px, 80vw);" },
    el("div.scope-filter", {}, filter),
    list,
    bulk,
  );
  let onDocClick: ((e: MouseEvent) => void) | null = null;
  const setOpen = (open: boolean) => {
    menu.classList.toggle("hidden", !open);
    addBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      filter.value = "";
      renderList();
      filter.focus();
      onDocClick = (e: MouseEvent) => {
        if (!pick.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener("click", onDocClick);
    } else if (onDocClick) {
      document.removeEventListener("click", onDocClick);
      onDocClick = null;
    }
  };
  addBtn.onclick = (e) => {
    e.stopPropagation();
    setOpen(menu.classList.contains("hidden"));
  };
  filter.addEventListener("input", renderList);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      addBtn.focus();
    }
  });
  pick.append(chips, addBtn, menu);
  renderChips();
  return pick;
}
