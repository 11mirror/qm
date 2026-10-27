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

class ModelPicker<T> {
  readonly bindings: ModelPickerBindings<T>;
  readonly composerState: ModelPickerBindings<T>["state"];
  readonly presets: ModelPickerBindings<T>["presets"];
  readonly catalog: ModelCatalog;
  readonly loadoutMenuId = `model-picker-${crypto.randomUUID()}`;
  loadoutSection: "effort" | "add" | null = null;
  loadoutSectionHovered = false;
  loadoutCloseTimer: ReturnType<typeof setTimeout> | null = null;
  disposed = false;

  constructor(bindings: ModelPickerBindings<T>) {
    this.bindings = bindings;
    this.composerState = bindings.state;
    this.presets = bindings.presets;
    this.catalog = bindings.catalog ?? {
      options: () => getModelOptions(bindings.scopeKey()),
      supportsFast: (modelId) => modelSupportsFastMode(bindings.scopeKey(), modelId),
      overridden: () => !!getRuntimeConfig(bindings.scopeKey())?.scopeOverride,
    };
    window.addEventListener("resize", this.place);
    window.visualViewport?.addEventListener("resize", this.place);
    document.addEventListener("click", this.outsideClick);
  }

  place = (): void => {
    requestAnimationFrame(() => this.positionLoadout());
  };

  outsideClick = (event: Event): void => {
    if (this.composerState.openMenu !== "loadout") return;
    const target = event.target;
    if (target instanceof Element && this.bindings.host()?.contains(target) && target.closest(".loadout-control"))
      return;
    this.closeMenus();
    this.bindings.redraw();
  };

  seededLoadout(selected: ModelOption): LoadoutEntry[] {
    if (this.presets) return this.presets.entries(selected);
    return modelLoadoutOptions(this.catalog.options(), []).map((option) => ({
      value: option.value,
      effort: defaultEffortForModel(option.model),
      fast: false,
    }));
  }

  focusSpeedControl(label: string): void {
    requestAnimationFrame(() =>
      this.bindings.host()?.querySelector<HTMLElement>(`button[aria-label="${label}"]`)?.focus(),
    );
  }

  toggleFastMode(target: T): void {
    this.bindings.toggleFastMode(target);
    this.focusSpeedControl("Fast");
  }

  removeLoadoutEntry(value: string, selected: ModelOption): void {
    if (value === this.bindings.activeEntry(selected).value) return;
    const entries = this.seededLoadout(selected);
    const index = entries.findIndex((entry) => entry.value === value);
    const next = entries.filter((entry) => entry.value !== value);
    this.presets?.save(next);
    this.bindings.redraw();
    this.place();
    requestAnimationFrame(() => {
      const rows = this.bindings.host()?.querySelectorAll<HTMLButtonElement>(".loadout-pick");
      rows?.[Math.max(0, Math.min(index, next.length - 1))]?.focus();
    });
  }

  modelLabel(option: ModelOption): string {
    return isUltrafastModel(option.model.id)
      ? (this.catalog.options().find((candidate) => candidate.model.id === presetModelId(option.value))?.label ??
          option.label)
      : option.label;
  }

  modelGlyph(option: ModelOption): TemplateResult {
    const provider = option.displayProvider ?? String(option.model.provider);
    return html`<span class="loadout-icon" data-provider=${provider} aria-hidden="true"
      >${modelMark(provider, 16) ?? icon(Sparkles, 16)}</span
    >`;
  }

  loadoutRow(entry: LoadoutEntry, selected: ModelOption, agent: T): TemplateResult | typeof nothing {
    const option = this.catalog.options().find((option) => option.value === entry.value);
    if (!option) return nothing;
    const active = entry.value === this.bindings.activeEntry(selected).value;
    const settings = active ? this.bindings.activeEntry(selected) : entry;
    const isDefault = entry.value === defaultModelValue(this.bindings.scopeKey());
    const activeRuntimeConfig = getRuntimeConfig(this.bindings.scopeKey());
    const canMakeDefault =
      this.bindings.showDefaultAction !== false &&
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
          this.dismissSelection();
          this.bindings.apply(entry, agent);
        }}
      >
        ${this.modelGlyph(option)}
        <span class="loadout-model-copy">
          <span class="loadout-title">
            <span class="loadout-name">${this.modelLabel(option)}</span>
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
              aria-label=${`Make ${this.modelLabel(option)} default`}
              ${tip("Make default")}
              @click=${async (event: MouseEvent) => {
                const row = (event.currentTarget as HTMLElement).closest(".loadout-row");
                const change = { modelId: option.model.id, effortLevel: settings.effort, fastMode: settings.fast };
                await this.bindings.changeDefault(change, agent, true);
                row?.querySelector<HTMLElement>(".loadout-pick")?.focus();
                this.place();
              }}
            >
              ${icon(Star, 14)}
            </button>`
          : nothing
      }
      ${isDefault && !canMakeDefault ? html`<span class="loadout-default-star" role="img" aria-label="My default" ${tip("My default")}>${icon(Star, 14)}</span>` : nothing}
      ${
        !active && this.presets
          ? html`<button
              class="loadout-remove"
              type="button"
              aria-label=${`Remove ${this.modelLabel(option)} from presets`}
              ${tip("Remove from presets")}
              @click=${() => this.removeLoadoutEntry(entry.value, selected)}
            >
              ${icon(X, 14)}
            </button>`
          : nothing
      }
    </div>`;
  }

  cancelLoadoutClose(): void {
    if (this.loadoutCloseTimer !== null) clearTimeout(this.loadoutCloseTimer);
    this.loadoutCloseTimer = null;
  }

  loadoutSubmenuHasFocus(): boolean {
    return this.bindings.host()?.querySelector<HTMLElement>(".loadout-submenu")?.matches(":focus-within") === true;
  }

  queueLoadoutClose(): void {
    if (isPhone() || !this.loadoutSectionHovered || !this.loadoutSection || this.loadoutSubmenuHasFocus()) return;
    const section = this.loadoutSection;
    this.cancelLoadoutClose();
    this.loadoutCloseTimer = setTimeout(() => {
      this.loadoutCloseTimer = null;
      if (this.loadoutSection === section && !this.loadoutSubmenuHasFocus()) this.closeLoadoutSection(false);
    }, 140);
  }

  trackLoadoutHover(e: MouseEvent): void {
    if (isPhone() || !this.loadoutSection) return;
    const target = e.target as HTMLElement;
    if (target.closest(`.loadout-submenu, [data-loadout-section="${this.loadoutSection}"]`)) this.cancelLoadoutClose();
    else this.queueLoadoutClose();
  }

  openLoadoutSection(section: "effort" | "add", keyboard = false): void {
    this.cancelLoadoutClose();
    if (this.loadoutSection === section && !keyboard) return;
    this.loadoutSection = section;
    this.bindings.redraw();
    this.place();
    if (keyboard)
      requestAnimationFrame(() => {
        const menu = this.bindings.host()?.querySelector<HTMLElement>(".loadout-submenu");
        const target =
          menu?.querySelector<HTMLElement>('input, [aria-checked="true"]') ??
          [...(menu?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])].find(
            (button) => button.offsetParent !== null,
          );
        target?.focus();
      });
  }

  closeLoadoutSection(refocus = true): void {
    const previous = this.loadoutSection;
    this.resetSection();
    this.bindings.redraw();
    this.place();
    if (previous && refocus)
      requestAnimationFrame(() =>
        this.bindings.host()?.querySelector<HTMLElement>(`[data-loadout-section="${previous}"]`)?.focus(),
      );
  }

  loadoutSubmenu(agent: T, selected: ModelOption): TemplateResult | typeof nothing {
    if (!this.loadoutSection) return nothing;
    const effort = this.loadoutSection === "effort";
    const entries = this.seededLoadout(selected);
    const query = this.composerState.menuQuery.trim().toLocaleLowerCase();
    const addable = modelLoadoutOptions(this.catalog.options(), entries).filter(
      (option) =>
        !entries.some((entry) => presetModelId(entry.value) === presetModelId(option.value)) &&
        (!query || this.modelLabel(option).toLocaleLowerCase().includes(query)),
    );
    return html`<div
      class="loadout-submenu"
      role="menu"
      aria-label=${{ effort: "Effort levels", add: "Add models" }[this.loadoutSection]}
      @mouseenter=${() => this.cancelLoadoutClose()}
      @mouseleave=${() => this.queueLoadoutClose()}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "ArrowLeft" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.closeLoadoutSection();
        } else this.menuArrowKeys(e);
      }}
    >
      <button class="loadout-back" type="button" @click=${() => this.closeLoadoutSection()}>
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
                  aria-checked=${this.composerState.effortLevel === level.value ? "true" : "false"}
                  @click=${(event: MouseEvent) => {
                    burstEffortConfetti(event, level.value);
                    this.bindings.selectEffort(level.value, agent);
                    this.closeLoadoutSection();
                  }}
                >
                  <span>${effortText(level.value)}</span
                  >${this.composerState.effortLevel === level.value ? icon(Check, 15) : nothing}
                </button>`,
            )
          : nothing
      }
      ${
        this.loadoutSection === "add"
          ? html` <label class="loadout-search"
                ><span class="sr-only">Search models</span>
                <input
                  type="search"
                  data-focus-key=${`${this.loadoutMenuId}-search`}
                  placeholder="Search models…"
                  .value=${live(this.composerState.menuQuery)}
                  @input=${(e: InputEvent) => {
                    const input = e.currentTarget as HTMLInputElement;
                    const selection = [input.selectionStart, input.selectionEnd] as const;
                    this.composerState.menuQuery = input.value;
                    this.bindings.redraw();
                    this.positionLoadout();
                    const next = this.bindings.host()?.querySelector<HTMLInputElement>(".loadout-search input");
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
                    aria-label=${`Add ${this.modelLabel(option)} to presets`}
                    @click=${() => {
                      this.dismissSelection();
                      this.presets?.add(option, agent);
                    }}
                  >
                    ${this.modelGlyph(option)}<span class="menu-option-copy"
                      ><span>${this.modelLabel(option)}</span
                      >${isUltrafastModel(option.model.id) ? html`<span class="loadout-meta">Ultrafast · 6× cost</span>` : nothing}</span
                    ><span class="loadout-add-label" aria-hidden="true">Add</span>
                  </button>`,
              )}
              ${addable.length ? nothing : html`<div class="loadout-empty">No models found</div>`}`
          : nothing
      }
    </div>`;
  }

  setMenu(next: string | null): void {
    this.resetSection();
    this.composerState.openMenu = next;
    this.bindings.redraw();
    this.place();
  }

  sectionButton(section: "effort" | "add", className: string, disabled: boolean, body: TemplateResult): TemplateResult {
    const open = this.loadoutSection === section;
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
        this.loadoutSectionHovered = true;
        this.openLoadoutSection(section);
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key !== "ArrowRight") return;
        e.preventDefault();
        this.loadoutSectionHovered = false;
        this.openLoadoutSection(section, true);
      }}
      @click=${(e: MouseEvent) => {
        this.loadoutSectionHovered = e.detail !== 0 && !isPhone();
        this.openLoadoutSection(section, e.detail === 0);
      }}
    >
      ${body}
    </button>`;
  }

  speedToggle(
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

  render(agent: T, choice: ModelOption | undefined, disabled: boolean, routed?: RoutedRuntime): TemplateResult {
    const selected = choice ?? this.catalog.options()[0];
    if (!selected) return html`<span class="context-model-status">No models available</span>`;
    const open = this.composerState.openMenu === "loadout";
    const entries = this.seededLoadout(selected);
    const full = entries.length >= LOADOUT_CAP;
    const ultrafastOn = isUltrafastModel(selected.model.id);
    const ultrafastTarget = ultrafastChoice(this.catalog.options(), selected);
    const modelSupportsFast = this.catalog.supportsFast(presetModelId(selected.value));
    const fastAvailable = !!choice && (!ultrafastOn || !!ultrafastTarget) && modelSupportsFast;
    const fastOn = fastAvailable && this.bindings.effectiveFastMode();
    const speedLabel = (ultrafastOn && ", Ultrafast") || (fastOn && ", Fast") || "";
    const settingLabel = choice ? this.modelLabel(choice) : (this.bindings.emptyLabel ?? "Choose model");
    const settingAria = choice
      ? `Model: ${settingLabel}, ${effortLabel(this.composerState.effortLevel)} effort${speedLabel}`
      : settingLabel;
    const routedOption = routed
      ? this.catalog.options().find((option) => option.model.id === routed.modelId)
      : undefined;
    const routedName = routedOption ? this.modelLabel(routedOption) : (routed?.label ?? routed?.modelId ?? "");
    const rule = routed?.change && "rule" in routed.change ? routed.change.rule : undefined;
    const reason = rule ? `routed by ${rule}` : "switched for this request";
    const triggerLabel = routed
      ? `Model: ${routedName}, ${reason}${rule ? " for this turn" : ""}; your setting is ${settingLabel}`
      : settingAria;
    const routedTip = routed
      ? `${rule ? `The ${rule} rule` : "The agent"} ran this ${rule ? "turn" : "request"} on ${routedName}. Your setting is ${settingLabel}.`
      : "";
    const suffix = routed ? reason : choice && effortText(this.composerState.effortLevel);
    return html`<div
      class="menu-control loadout-control"
      data-align="left"
      @keydown=${(event: KeyboardEvent) => {
        const hotkey = event.metaKey && event.shiftKey && event.code === "KeyE";
        if (disabled || !fastAvailable || event.defaultPrevented || !hotkey) return;
        event.preventDefault();
        this.toggleFastMode(agent);
      }}
    >
      <button
        class="menu-button loadout-button ${ultrafastOn ? "ultrafast-active" : ""}"
        data-focus-key=${`${this.loadoutMenuId}-trigger`}
        type="button"
        aria-label=${triggerLabel}
        ${tip(routedTip)}
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls=${this.loadoutMenuId}
        ?disabled=${disabled}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          this.setMenu("loadout");
          requestAnimationFrame(() => this.bindings.host()?.querySelector<HTMLElement>(".loadout-pick")?.focus());
        }}
        @click=${(e: Event) => {
          e.stopPropagation();
          this.composerState.menuQuery = "";
          this.setMenu(open ? null : "loadout");
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
              id=${this.loadoutMenuId}
              role="menu"
              aria-label="Model settings"
              @click=${(e: Event) => e.stopPropagation()}
              @mouseover=${(e: MouseEvent) => this.trackLoadoutHover(e)}
              @mouseleave=${() => this.queueLoadoutClose()}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  this.dismissSelection();
                  this.bindings.redraw();
                } else if (!(e.target as HTMLElement).closest(".loadout-submenu")) this.menuArrowKeys(e);
              }}
            >
              <div class="loadout-panel">
                ${this.presets ? html`<div class="loadout-head">Presets</div>` : nothing}
                <div class="loadout-list">${entries.map((entry) => this.loadoutRow(entry, selected, agent))}</div>
                ${
                  this.presets
                    ? html`<div class="loadout-submenu-anchor" ${tip(full ? "Remove a preset to add another." : "")}>
                        ${this.sectionButton(
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
                          ${this.sectionButton(
                            "effort",
                            "loadout-setting",
                            false,
                            html`<span class="loadout-setting-label">Effort</span
                              ><span class="loadout-setting-value"
                                >${effortText(this.composerState.effortLevel)}<span class="loadout-end"
                                  >${icon(ChevronRight, 14)}</span
                                ></span
                              >`,
                          )}
                        </div>
                        ${this.speedToggle(
                          "Fast",
                          fastOn,
                          !fastAvailable,
                          fastAvailable ? "⌘⇧E" : "Not supported by this model",
                          () => this.toggleFastMode(agent),
                        )}
                        ${
                          ultrafastTarget || ultrafastOn
                            ? this.speedToggle("Ultrafast", ultrafastOn, !ultrafastTarget, "6× cost", () => {
                                if (!ultrafastTarget) return;
                                this.bindings.apply(
                                  { ...this.bindings.activeEntry(selected), value: ultrafastTarget.value, fast: false },
                                  agent,
                                );
                                this.focusSpeedControl("Ultrafast");
                              })
                            : nothing
                        }`
                    : nothing
                }
              </div>
              ${this.bindings.showInheritAction !== false && this.catalog.overridden() ? html`<div class="loadout-foot"><button class="loadout-foot-btn" type="button" @click=${() => this.bindings.changeDefault({ inherit: true }, agent)}>${this.bindings.inheritLabel ?? "Use org default"}</button></div>` : nothing}
              ${this.loadoutSubmenu(agent, selected)}
            </div>`
          : nothing
      }
    </div>`;
  }

  menuArrowKeys(e: KeyboardEvent): void {
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

  positionLoadout(): void {
    if (this.disposed) return;
    const host = this.bindings.host();
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
    const anchor = menu.querySelector<HTMLElement>(`[data-loadout-section="${this.loadoutSection}"]`);
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

  resetSection(): void {
    this.cancelLoadoutClose();
    this.loadoutSection = null;
    this.loadoutSectionHovered = false;
  }

  dismissSelection(): void {
    this.closeMenus();
    requestAnimationFrame(() => this.bindings.host()?.querySelector<HTMLElement>(".loadout-button")?.focus());
  }

  closeMenus(): void {
    this.resetSection();
    this.composerState.openMenu = null;
  }

  dispose(): void {
    this.disposed = true;
    this.resetSection();
    document.removeEventListener("click", this.outsideClick);
    window.removeEventListener("resize", this.place);
    window.visualViewport?.removeEventListener("resize", this.place);
  }
}

export function createModelPicker<T>(bindings: ModelPickerBindings<T>) {
  return new ModelPicker(bindings);
}
