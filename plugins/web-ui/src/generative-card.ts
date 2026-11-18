import { LitElement, html, nothing } from "lit";

export class GenerativeCard extends LitElement {
  static properties = {
    spec: {},
  };

  declare spec: string;

  constructor() {
    super();
    this.spec = "";
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render() {
    if (!this.spec.trim()) return nothing;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(this.spec);
    } catch {
      return html`<div class="gen-card-raw">${this.spec}</div>`;
    }
    if (!parsed) return nothing;

    let elements: Array<Record<string, unknown>> = [];
    if (Array.isArray(parsed.elements)) {
      elements = parsed.elements as Array<Record<string, unknown>>;
    } else if (parsed.elements && typeof parsed.elements === "object") {
      elements = Object.values(parsed.elements) as Array<Record<string, unknown>>;
    }

    return html` <div class="gen-card-frame">${elements.map((el) => this.renderElement(el))}</div> `;
  }

  private renderElement(el: Record<string, unknown>) {
    const type = String(el.type ?? el.component ?? "").toLowerCase();
    const props = (el.props ?? el) as Record<string, unknown>;

    switch (type) {
      case "header": {
        const text = String(props.text ?? props.title ?? "");
        return html`<div class="gen-card-header"><h3>${text}</h3></div>`;
      }
      case "section": {
        return html`<div class="finny-plan-summary">${String(props.text ?? "")}</div>`;
      }
      case "metric": {
        const label = String(props.label ?? props.title ?? "");
        const value = String(props.value ?? "");
        const change = props.change ? String(props.change) : "";
        return html`
          <div class="gen-card-metric">
            <span class="gen-metric-label">${label}</span>
            <span class="gen-metric-value">${value}</span>
            ${change ? html`<span class="gen-metric-change">${change}</span>` : nothing}
          </div>
        `;
      }
      case "callout": {
        const title = props.title ? String(props.title) : "";
        const message = String(props.message ?? props.text ?? "");
        return html`
          <div class="gen-card-callout">
            ${title ? html`<strong>${title}</strong>` : nothing}
            <p>${message}</p>
          </div>
        `;
      }
      case "actions": {
        const buttons = Array.isArray(props.buttons) ? (props.buttons as Array<Record<string, unknown>>) : [];
        return html`<div class="approval-actions">
          ${buttons.map((button) => {
            const label = String(button.label ?? "");
            const url = typeof button.url === "string" ? button.url : "";
            return url
              ? html`<a class="btn primary" href=${url}>${label}</a>`
              : html`<button class="btn" type="button" disabled>${label}</button>`;
          })}
        </div>`;
      }
      case "context": {
        const entries = Array.isArray(props.elements) ? props.elements : [];
        return html`<div class="finny-plan-details-grid">
          ${entries.map((entry) => html`<span class="finny-plan-detail">${String(entry)}</span>`)}
        </div>`;
      }
      case "table": {
        const headers = Array.isArray(props.headers) ? (props.headers as string[]) : [];
        const rows = Array.isArray(props.rows) ? (props.rows as unknown[][]) : [];
        return html`
          <div class="gen-card-table-wrap">
            <table class="gen-card-table">
              ${
                headers.length
                  ? html`<thead>
                      <tr>
                        ${headers.map((h) => html`<th>${h}</th>`)}
                      </tr>
                    </thead>`
                  : nothing
              }
              <tbody>
                ${rows.map(
                  (row) => html`
                    <tr>
                      ${Array.isArray(row) ? row.map((cell) => html`<td>${String(cell)}</td>`) : nothing}
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `;
      }
      case "provenance": {
        const items = Array.isArray(props.items) ? (props.items as Array<Record<string, unknown>>) : [];
        return html`
          <div class="gen-card-provenance">
            <div class="gen-provenance-title">Audit Provenance</div>
            ${items.map(
              (item) => html`
                <div class="gen-provenance-item">
                  <span class="prov-name">${String(item.metric ?? item.name ?? "")}</span>
                  <span class="prov-source">${String(item.source ?? item.gl_account ?? "")}</span>
                </div>
              `,
            )}
          </div>
        `;
      }
      default:
        return nothing;
    }
  }
}

if (!customElements.get("qm-gen-card")) customElements.define("qm-gen-card", GenerativeCard);
