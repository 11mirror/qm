import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";

interface ToolManifestEntry {
  name: string;
  source: "native" | "connector" | "client";
  present: boolean;
  reason: string;
  actions?: string[];
  connector?: string;
}

let tools: ToolManifestEntry[] | null = null;
let error = "";

export async function loadToolManifest(redraw: () => void): Promise<void> {
  try {
    tools = (await api<{ tools: ToolManifestEntry[] }>("/api/tool-manifest")).tools;
    error = "";
  } catch (e) {
    error = errMessage(e);
  }
  redraw();
}

function toolRow(tool: ToolManifestEntry): TemplateResult {
  return html`
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">${tool.name}</div>
        <div class="settings-row-note">
          ${tool.reason}${tool.present && tool.actions?.length ? ` Actions: ${tool.actions.join(", ")}.` : ""}
        </div>
      </div>
      <div class="settings-row-note">${tool.present ? "Available" : "Not available"}</div>
    </div>
  `;
}

export function toolsSection(): TemplateResult {
  return html`
    <h2 class="settings-section-title">Tools</h2>
    <div class="settings-group">
      <div class="settings-row">
        <div class="settings-row-copy">
          <div class="settings-row-note">
            Tools the agent gets in your web conversations, and why each is on or off.
          </div>
          ${error ? html`<div class="settings-row-error" role="alert">${error}</div>` : nothing}
        </div>
      </div>
      ${(tools ?? []).map(toolRow)}
    </div>
  `;
}
