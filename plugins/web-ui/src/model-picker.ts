import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Check, ChevronDown, ChevronRight, Plus, Sparkles, Star, X, Zap } from "lucide";
import { icon, modelMark } from "./icons.ts";
import { getRuntimeConfig, type RuntimeChange } from "./runtime-config-cache.ts";
import {
  EFFORT_LEVELS,
  effortLabel,
  defaultEffortForModel,
  defaultModelValue,
  getModelOptions,
  type EffortLevel,
  type ModelOption,
} from "./model-options.ts";
import { modelSupportsFastMode } from "./pi-models.ts";
import {
  LOADOUT_CAP,
  isUltrafastModel,
  ultrafastChoice,
  effortLevelsForModel,
  presetModelId,
  modelLoadoutOptions,
  type LoadoutEntry,
} from "./composer-loadout.ts";
import { tip } from "./tooltip.ts";
import { isPhone } from "./viewport.ts";
import { burstEffortConfetti } from "./effort-confetti.ts";

const EFFORT_PEAK_FLOOR = EFFORT_LEVELS.findIndex((option) => option.value === "xhigh");

function effortText(level: EffortLevel | string): TemplateResult | string {
  const label = effortLabel(level as EffortLevel);
  const rank = EFFORT_LEVELS.findIndex((option) => option.value === level);
  return rank >= EFFORT_PEAK_FLOOR ? html`<span class="effort-peak">${label}</span>` : label;
}

type RoutedRuntime = { modelId: string; label?: string; change?: { rule: string } | { agent: string } };

export type ModelCatalog = { options(): ModelOption[]; supportsFast(modelId: string): boolean; overridden(): boolean };

interface ModelPickerBindings<T> {
  host(): HTMLElement | null;
  redraw(): void;
  scopeKey(): string | null;
  state: { openMenu: string | null; menuQuery: string; effortLevel: EffortLevel };
  presets?: {
    entries(selected: ModelOption): LoadoutEntry[];
    save(entries: LoadoutEntry[]): void;
    add(option: ModelOption, target: T): void;
  };
  catalog?: ModelCatalog;
  activeEntry(selected: ModelOption): LoadoutEntry;
  apply(entry: LoadoutEntry, target: T): void;
  selectEffort(effort: EffortLevel, target: T): void;
  toggleFastMode(target: T): void;
  effectiveFastMode(): boolean;
  changeDefault(change: RuntimeChange, target: T, keepOpen?: boolean): Promise<unknown>;
  showDefaultAction?: boolean;
  showInheritAction?: boolean;
  inheritLabel?: string;
  emptyLabel?: string;
}

export function createModelPicker<T>(bindings: ModelPickerBindings<T>) {
  const { state: composerState, presets } = bindings;
  const loadoutMenuId = `model-picker-${crypto.randomUUID()}`;
  let loadoutSection: "effort" | "add" | null = null;
  let loadoutSectionHovered = false;
  let loadoutCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const catalog: ModelCatalog = bindings.catalog ?? {
    options: () => getModelOptions(bindings.scopeKey()),
    supportsFast: (modelId) => modelSupportsFastMode(bindings.scopeKey(), modelId),
    overridden: () => !!getRuntimeConfig(bindings.scopeKey())?.scopeOverride,
  };

  function seededLoadout(selected: ModelOption): LoadoutEntry[] {
    if (presets) return presets.entries(selected);
    return modelLoadoutOptions(catalog.options(), []).map((option) => ({
      value: option.value,
      effort: defaultEffortForModel(option.model),
      fast: false,
    }));
  }

  function focusSpeedControl(label: string): void {
    requestAnimationFrame(() => bindings.host()?.querySelector<HTMLElement>(`button[aria-label="${label}"]`)?.focus());
  }

  function toggleFastMode(target: T): void {
    bindings.toggleFastMode(target);
    focusSpeedControl("Fast");
  }

  function removeLoadoutEntry(value: string, selected: ModelOption): void {
    if (value === bindings.activeEntry(selected).value) return;
    const entries = seededLoadout(selected);
    const index = entries.findIndex((entry) => entry.value === value);
    const next = entries.filter((entry) => entry.value !== value);
    presets?.save(next);
    bindings.redraw();
    placeLoadout();
    requestAnimationFrame(() => {
      const rows = bindings.host()?.querySelectorAll<HTMLButtonElement>(".loadout-pick");
      rows?.[Math.max(0, Math.min(index, next.length - 1))]?.focus();
    });
  }

  function modelLabel(option: ModelOption): string {
    return isUltrafastModel(option.model.id)
      ? (catalog.options().find((candidate) => candidate.model.id === presetModelId(option.value))?.label ??
          option.label)
      : option.label;
  }

  function modelGlyph(option: ModelOption): TemplateResult {
    const provider = option.displayProvider ?? String(option.model.provider);
    return html`<span class="loadout-icon" data-provider=${provider} aria-hidden="true"
      >${modelMark(provider, 16) ?? icon(Sparkles, 16)}</span
    >`;
  }

  function loadoutRow(entry: LoadoutEntry, selected: ModelOption, agent: T): TemplateResult | typeof nothing {
    const option = catalog.options().find((option) => option.value === entry.value);
    if (!option) return nothing;
    const active = entry.value === bindings.activeEntry(selected).value;
    const settings = active ? bindings.activeEntry(selected) : entry;
    const isDefault = entry.value === defaultModelValue(bindings.scopeKey());
    const activeRuntimeConfig = getRuntimeConfig(bindings.scopeKey());
    const canMakeDefault =
      bindings.showDefaultAction !== false &&
      activeRuntimeConfig !== null &&
      (!isDefault ||
        settings.effort !== (activeRuntimeConfig.effective.effortLevel ?? defaultEffortForModel(option.model)) ||
        settings.fast !== (activeRuntimeConfig.effective.fastMode === true));
    return html` <div
      class="loadout-row ${active ? "active" : ""} ${canMakeDefault || isDefault ? "has-default-action" : ""}"
    >
      <button
        class="loadout-pick"
        type="button"
        role="menuitemradio"
        aria-checked=${active ? "true" : "false"}
        @click=${(event: MouseEvent) => {
          burstEffortConfetti(event, settings.effort);
          dismissSelection();
          bindings.apply(entry, agent);
        }}
      >
        ${modelGlyph(option)}
        <span class="loadout-model-copy">
          <span class="loadout-title">
            <span class="loadout-name">${modelLabel(option)}</span>
            ${isDefault ? html`<span class="loadout-default">my default</span>` : nothing}
          </span>
          <span class="loadout-details">
            <span>${effortText(settings.effort)}</span>
            ${isUltrafastModel(option.model.id) ? html`<span class="loadout-ultrafast-badge">${icon(Zap, 10)} Ultrafast</span>` : nothing}
            ${settings.fast ? html`<span class="loadout-bolt" aria-label="Fast">${icon(Zap, 10)}</span>` : nothing}
          </span>
        </span>
      </button>
      ${
        canMakeDefault
          ? html`<button
              class="loadout-make-default"
              data-default=${isDefault ? "true" : "false"}
              type="button"
              role="menuitem"
              aria-label=${`Make ${modelLabel(option)} default`}
              ${tip("Make default")}
              @click=${async (event: MouseEvent) => {
                const row = (event.currentTarget as HTMLElement).closest(".loadout-row");
                const change = { modelId: option.model.id, effortLevel: settings.effort, fastMode: settings.fast };
                await bindings.changeDefault(change, agent, true);
                row?.querySelector<HTMLElement>(".loadout-pick")?.focus();
                placeLoadout();
              }}
            >
              ${icon(Star, 14)}
            </button>`
          : nothing
      }
      ${isDefault && !canMakeDefault ? html`<span class="loadout-default-star" role="img" aria-label="My default" ${tip("My default")}>${icon(Star, 14)}</span>` : nothing}
      ${
        !active && presets
          ? html`<button
              class="loadout-remove"
              type="button"
              aria-label=${`Remove ${modelLabel(option)} from presets`}
              ${tip("Remove from presets")}
              @click=${() => removeLoadoutEntry(entry.value, selected)}
            >
              ${icon(X, 14)}
            </button>`
          : nothing
      }
    </div>`;
  }

  function cancelLoadoutClose(): void {
    if (loadoutCloseTimer !== null) clearTimeout(loadoutCloseTimer);
    loadoutCloseTimer = null;
  }

  function loadoutSubmenuHasFocus(): boolean {
    return bindings.host()?.querySelector<HTMLElement>(".loadout-submenu")?.matches(":focus-within") === true;
  }

  function queueLoadoutClose(): void {
    if (isPhone() || !loadoutSectionHovered || !loadoutSection || loadoutSubmenuHasFocus()) return;
    const section = loadoutSection;
    cancelLoadoutClose();
    loadoutCloseTimer = setTimeout(() => {
      loadoutCloseTimer = null;
      if (loadoutSection === section && !loadoutSubmenuHasFocus()) closeLoadoutSection(false);
    }, 140);
  }

  function trackLoadoutHover(e: MouseEvent): void {
    if (isPhone() || !loadoutSection) return;
    const target = e.target as HTMLElement;
    if (target.closest(`.loadout-submenu, [data-loadout-section="${loadoutSection}"]`)) cancelLoadoutClose();
    else queueLoadoutClose();
  }

  function openLoadoutSection(section: "effort" | "add", keyboard = false): void {
    cancelLoadoutClose();
    if (loadoutSection === section && !keyboard) return;
    loadoutSection = section;
    bindings.redraw();
    placeLoadout();
    if (keyboard)
      requestAnimationFrame(() => {
        const menu = bindings.host()?.querySelector<HTMLElement>(".loadout-submenu");
        const target =
          menu?.querySelector<HTMLElement>('input, [aria-checked="true"]') ??
          [...(menu?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])].find(
            (button) => button.offsetParent !== null,
          );
        target?.focus();
      });
  }

  function closeLoadoutSection(refocus = true): void {
    const previous = loadoutSection;
    resetSection();
    bindings.redraw();
    placeLoadout();
    if (previous && refocus)
      requestAnimationFrame(() =>
        bindings.host()?.querySelector<HTMLElement>(`[data-loadout-section="${previous}"]`)?.focus(),
      );
  }

  function loadoutSubmenu(agent: T, selected: ModelOption): TemplateResult | typeof nothing {
    if (!loadoutSection) return nothing;
    const effort = loadoutSection === "effort";
    const entries = seededLoadout(selected);
    const query = composerState.menuQuery.trim().toLocaleLowerCase();
    const addable = modelLoadoutOptions(catalog.options(), entries).filter(
      (option) =>
        !entries.some((entry) => presetModelId(entry.value) === presetModelId(option.value)) &&
        (!query || modelLabel(option).toLocaleLowerCase().includes(query)),
    );
    return html`<div
      class="loadout-submenu"
      role="menu"
      aria-label=${{ effort: "Effort levels", add: "Add models" }[loadoutSection]}
      @mouseenter=${() => cancelLoadoutClose()}
      @mouseleave=${() => queueLoadoutClose()}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "ArrowLeft" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeLoadoutSection();
        } else menuArrowKeys(e);
      }}
    >
      <button class="loadout-back" type="button" @click=${() => closeLoadoutSection()}>
        ${icon(ChevronDown, 13)} Back
      </button>
      ${
        effort
          ? effortLevelsForModel(selected.model).map(
              (level) =>
                html` <button
                  class="loadout-effort"
                  type="button"
                  role="menuitemradio"
                  aria-checked=${composerState.effortLevel === level.value ? "true" : "false"}
                  @click=${(event: MouseEvent) => {
                    burstEffortConfetti(event, level.value);
                    bindings.selectEffort(level.value, agent);
                    closeLoadoutSection();
                  }}
                >
                  <span>${effortText(level.value)}</span
                  >${composerState.effortLevel === level.value ? icon(Check, 15) : nothing}
                </button>`,
            )
          : nothing
      }
      ${
        loadoutSection === "add"
          ? html` <label class="loadout-search"
                ><span class="sr-only">Search models</span>
                <input
                  type="search"
                  data-focus-key=${`${loadoutMenuId}-search`}
                  placeholder="Search models…"
                  .value=${live(composerState.menuQuery)}
                  @input=${(e: InputEvent) => {
                    const input = e.currentTarget as HTMLInputElement;
                    const selection = [input.selectionStart, input.selectionEnd] as const;
                    composerState.menuQuery = input.value;
                    bindings.redraw();
                    positionLoadout();
                    const next = bindings.host()?.querySelector<HTMLInputElement>(".loadout-search input");
                    next?.focus();
                    if (selection[0] !== null && selection[1] !== null)
                      next?.setSelectionRange(selection[0], selection[1]);
                  }}
                />
              </label>
              ${addable.map(
                (option) =>
                  html`<button
                    class="menu-option"
                    type="button"
                    role="menuitem"
                    aria-label=${`Add ${modelLabel(option)} to presets`}
                    @click=${() => {
                      dismissSelection();
                      presets?.add(option, agent);
                    }}
                  >
                    ${modelGlyph(option)}<span class="menu-option-copy"
                      ><span>${modelLabel(option)}</span
                      >${isUltrafastModel(option.model.id) ? html`<span class="loadout-meta">Ultrafast · 6× cost</span>` : nothing}</span
                    ><span class="loadout-add-label" aria-hidden="true">Add</span>
                  </button>`,
              )}
              ${addable.length ? nothing : html`<div class="loadout-empty">No models found</div>`}`
          : nothing
      }
    </div>`;
  }

  function setMenu(next: string | null): void {
    resetSection();
    composerState.openMenu = next;
    bindings.redraw();
    placeLoadout();
  }

  function sectionButton(
    section: "effort" | "add",
    className: string,
    disabled: boolean,
    body: TemplateResult,
  ): TemplateResult {
    const open = loadoutSection === section;
    return html`<button
      class="${className} ${open ? "open" : ""}"
      type="button"
      role="menuitem"
      data-loadout-section=${section}
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      ?disabled=${disabled}
      @mouseenter=${() => {
        if (isPhone() || disabled) return;
        loadoutSectionHovered = true;
        openLoadoutSection(section);
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key !== "ArrowRight") return;
        e.preventDefault();
        loadoutSectionHovered = false;
        openLoadoutSection(section, true);
      }}
      @click=${(e: MouseEvent) => {
        loadoutSectionHovered = e.detail !== 0 && !isPhone();
        openLoadoutSection(section, e.detail === 0);
      }}
    >
      ${body}
    </button>`;
  }

  function speedToggle(
    name: "Fast" | "Ultrafast",
    on: boolean,
    disabled: boolean,
    shortcut: string,
    onClick: () => void,
  ): TemplateResult {
    const ultra = name === "Ultrafast";
    return html`<button
      class=${ultra ? "loadout-setting loadout-ultrafast" : "loadout-setting"}
      type="button"
      role="menuitemcheckbox"
      aria-label=${name}
      ?disabled=${disabled}
      aria-description=${ultra ? "Six times standard token cost. Turning on Ultrafast turns off Fast." : nothing}
      aria-checked=${on ? "true" : "false"}
      @click=${onClick}
    >
      <span class="loadout-setting-label">${ultra ? html`${icon(Zap, 14)} Ultrafast` : name}</span>
      <span class="loadout-setting-value">
        <span class="loadout-shortcut">${shortcut}</span>
        <span class="loadout-toggle ${on ? "on" : ""}" aria-hidden="true"><span class="loadout-knob"></span></span>
      </span>
    </button>`;
  }

  function render(
    agent: T,
    choice: ModelOption | undefined,
    disabled: boolean,
    routed?: RoutedRuntime,
  ): TemplateResult {
    const selected = choice ?? catalog.options()[0];
    if (!selected) return html`<span class="context-model-status">No models available</span>`;
    const open = composerState.openMenu === "loadout";
    const entries = seededLoadout(selected);
    const full = entries.length >= LOADOUT_CAP;
    const ultrafastOn = isUltrafastModel(selected.model.id);
    const ultrafastTarget = ultrafastChoice(catalog.options(), selected);
    const modelSupportsFast = catalog.supportsFast(presetModelId(selected.value));
    const fastAvailable = !!choice && (!ultrafastOn || !!ultrafastTarget) && modelSupportsFast;
    const fastOn = fastAvailable && bindings.effectiveFastMode();
    const speedLabel = (ultrafastOn && ", Ultrafast") || (fastOn && ", Fast") || "";
    const settingLabel = choice ? modelLabel(choice) : (bindings.emptyLabel ?? "Choose model");
    const settingAria = choice
      ? `Model: ${settingLabel}, ${effortLabel(composerState.effortLevel)} effort${speedLabel}`
      : settingLabel;
    const routedOption = routed ? catalog.options().find((option) => option.model.id === routed.modelId) : undefined;
    const routedName = routedOption ? modelLabel(routedOption) : (routed?.label ?? routed?.modelId ?? "");
    const rule = routed?.change && "rule" in routed.change ? routed.change.rule : undefined;
    const reason = rule ? `routed by ${rule}` : "switched for this request";
    const triggerLabel = routed
      ? `Model: ${routedName}, ${reason}${rule ? " for this turn" : ""}; your setting is ${settingLabel}`
      : settingAria;
    const routedTip = routed
      ? `${rule ? `The ${rule} rule` : "The agent"} ran this ${rule ? "turn" : "request"} on ${routedName}. Your setting is ${settingLabel}.`
      : "";
    const suffix = routed ? reason : choice && effortText(composerState.effortLevel);
    return html`<div
      class="menu-control loadout-control"
      data-align="left"
      @keydown=${(event: KeyboardEvent) => {
        const hotkey = event.metaKey && event.shiftKey && event.code === "KeyE";
        if (disabled || !fastAvailable || event.defaultPrevented || !hotkey) return;
        event.preventDefault();
        toggleFastMode(agent);
      }}
    >
      <button
        class="menu-button loadout-button ${ultrafastOn ? "ultrafast-active" : ""}"
        data-focus-key=${`${loadoutMenuId}-trigger`}
        type="button"
        aria-label=${triggerLabel}
        ${tip(routedTip)}
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls=${loadoutMenuId}
        ?disabled=${disabled}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu("loadout");
          requestAnimationFrame(() => bindings.host()?.querySelector<HTMLElement>(".loadout-pick")?.focus());
        }}
        @click=${(e: Event) => {
          e.stopPropagation();
          composerState.menuQuery = "";
          setMenu(open ? null : "loadout");
        }}
      >
        <span class="menu-label">${routed ? routedName : settingLabel}</span>
        ${suffix ? html`<span class="menu-suffix">${suffix}</span>` : nothing}
        ${ultrafastOn ? html`<span class="loadout-ultrafast-badge">${icon(Zap, 12)} Ultrafast</span>` : nothing}
        ${fastOn ? html`<span class="loadout-bolt">${icon(Zap, 13)}</span>` : nothing}${icon(ChevronDown, 13)}
      </button>
      ${
        open && !disabled
          ? html`<div
              class="menu-popover loadout-popover"
              popover="manual"
              id=${loadoutMenuId}
              role="menu"
              aria-label="Model settings"
              @click=${(e: Event) => e.stopPropagation()}
              @mouseover=${(e: MouseEvent) => trackLoadoutHover(e)}
              @mouseleave=${() => queueLoadoutClose()}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissSelection();
                  bindings.redraw();
                } else if (!(e.target as HTMLElement).closest(".loadout-submenu")) menuArrowKeys(e);
              }}
            >
              <div class="loadout-panel">
                ${presets ? html`<div class="loadout-head">Presets</div>` : nothing}
                <div class="loadout-list">${entries.map((entry) => loadoutRow(entry, selected, agent))}</div>
                ${
                  presets
                    ? html`<div class="loadout-submenu-anchor" ${tip(full ? "Remove a preset to add another." : "")}>
                        ${sectionButton(
                          "add",
                          "loadout-add",
                          full,
                          html`<span class="loadout-icon" aria-hidden="true">${icon(Plus, 16)}</span
                            ><span>Add models</span><span class="loadout-end">${icon(ChevronRight, 14)}</span>`,
                        )}
                      </div>`
                    : nothing
                }
                ${
                  choice
                    ? html`<div class="loadout-divider"></div>
                        <div class="loadout-submenu-anchor">
                          ${sectionButton(
                            "effort",
                            "loadout-setting",
                            false,
                            html`<span class="loadout-setting-label">Effort</span
                              ><span class="loadout-setting-value"
                                >${effortText(composerState.effortLevel)}<span class="loadout-end"
                                  >${icon(ChevronRight, 14)}</span
                                ></span
                              >`,
                          )}
                        </div>
                        ${speedToggle(
                          "Fast",
                          fastOn,
                          !fastAvailable,
                          fastAvailable ? "⌘⇧E" : "Not supported by this model",
                          () => toggleFastMode(agent),
                        )}
                        ${
                          ultrafastTarget || ultrafastOn
                            ? speedToggle("Ultrafast", ultrafastOn, !ultrafastTarget, "6× cost", () => {
                                if (!ultrafastTarget) return;
                                bindings.apply(
                                  { ...bindings.activeEntry(selected), value: ultrafastTarget.value, fast: false },
                                  agent,
                                );
                                focusSpeedControl("Ultrafast");
                              })
                            : nothing
                        }`
                    : nothing
                }
              </div>
              ${bindings.showInheritAction !== false && catalog.overridden() ? html`<div class="loadout-foot"><button class="loadout-foot-btn" type="button" @click=${() => bindings.changeDefault({ inherit: true }, agent)}>${bindings.inheritLabel ?? "Use org default"}</button></div>` : nothing}
              ${loadoutSubmenu(agent, selected)}
            </div>`
          : nothing
      }
    </div>`;
  }

  function menuArrowKeys(e: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target.matches("input") && !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const menu = target.closest<HTMLElement>('[role="menu"]');
    if (!menu) return;
    const buttons = [...menu.querySelectorAll<HTMLElement>("button:not(:disabled)")].filter(
      (button) => button.closest('[role="menu"]') === menu && button.offsetParent !== null,
    );
    if (!buttons.length) return;
    e.preventDefault();
    e.stopPropagation();
    const at = buttons.indexOf(target);
    let next = at + (e.key === "ArrowUp" ? -1 : 1);
    if (at < 0 && e.key === "ArrowUp") next = buttons.length - 1;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = buttons.length - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  }

  function positionLoadout(): void {
    if (disposed) return;
    const host = bindings.host();
    const menu = host?.querySelector<HTMLElement>(".loadout-popover");
    const trigger = host?.querySelector<HTMLElement>(".loadout-button");
    if (!menu || !trigger) return;
    if (typeof menu.showPopover === "function" && !menu.matches(":popover-open")) menu.showPopover();
    const viewport = window.visualViewport;
    const top = (viewport?.offsetTop ?? 0) + 12;
    const left = (viewport?.offsetLeft ?? 0) + 12;
    const right = left + (viewport?.width ?? window.innerWidth) - 24;
    const bottom = top + (viewport?.height ?? window.innerHeight) - 24;
    const rect = trigger.getBoundingClientRect();
    const above = rect.top - top - 8;
    const below = bottom - rect.bottom - 8;
    const up = above >= below;
    menu.style.maxHeight = `${Math.max(140, up ? above : below)}px`;
    menu.style.left = `${Math.max(left, Math.min(rect.left, right - menu.offsetWidth))}px`;
    menu.style.top = `${up ? Math.max(top, rect.top - menu.offsetHeight - 8) : rect.bottom + 8}px`;
    menu.style.bottom = "auto";
    const submenu = menu.querySelector<HTMLElement>(".loadout-submenu");
    const anchor = menu.querySelector<HTMLElement>(`[data-loadout-section="${loadoutSection}"]`);
    if (!submenu || !anchor) return;
    const menuRect = menu.getBoundingClientRect();
    const width = Math.min(260, right - left);
    const roomRight = right - menuRect.right - 4;
    const roomLeft = menuRect.left - left - 4;
    const inline = Math.max(roomLeft, roomRight) < width;
    submenu.classList.toggle("inline", inline);
    if (inline) {
      Object.assign(submenu.style, { width: "", left: "", top: "" });
      submenu.style.maxHeight = `${Math.max(120, (up ? above : below) - 80)}px`;
      menu.style.top = `${up ? Math.max(top, rect.top - menu.offsetHeight - 8) : rect.bottom + 8}px`;
    } else {
      submenu.style.width = `${width}px`;
      submenu.style.maxHeight = `${bottom - top}px`;
      submenu.style.left = `${roomRight >= width ? menuRect.right + 4 : menuRect.left - width - 4}px`;
      submenu.style.top = `${Math.max(top, Math.min(anchor.getBoundingClientRect().top - 6, bottom - submenu.offsetHeight))}px`;
    }
  }

  function placeLoadout(): void {
    requestAnimationFrame(positionLoadout);
  }

  window.addEventListener("resize", placeLoadout);
  window.visualViewport?.addEventListener("resize", placeLoadout);

  function resetSection(): void {
    cancelLoadoutClose();
    loadoutSection = null;
    loadoutSectionHovered = false;
  }

  function dismissSelection(): void {
    closeMenus();
    requestAnimationFrame(() => bindings.host()?.querySelector<HTMLElement>(".loadout-button")?.focus());
  }

  function closeMenus(): void {
    resetSection();
    composerState.openMenu = null;
  }

  function outsideClick(event: Event): void {
    if (composerState.openMenu !== "loadout") return;
    const target = event.target;
    if (target instanceof Element && bindings.host()?.contains(target) && target.closest(".loadout-control")) return;
    closeMenus();
    bindings.redraw();
  }

  document.addEventListener("click", outsideClick);

  function dispose(): void {
    disposed = true;
    resetSection();
    document.removeEventListener("click", outsideClick);
    window.removeEventListener("resize", placeLoadout);
    window.visualViewport?.removeEventListener("resize", placeLoadout);
  }

  return { render, place: placeLoadout, resetSection, dispose };
}
