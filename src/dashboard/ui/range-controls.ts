import type { RangeKey } from "../types.js";

/** Presentation labels for the ranges. Kept here rather than shared, since only the UI names them. */
const RANGE_LABELS: readonly (readonly [RangeKey, string])[] = [
  [ "1h", "Last hour" ],
  [ "24h", "24 hours" ],
  [ "7d", "7 days" ],
  [ "30d", "30 days" ],
  [ "all", "All time" ]
];

export interface RangeState {
  range: RangeKey;
  dedupe: boolean;
}

const CSS = `
  :host {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 18px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow);
    font: 14px/1.5 var(--sans);
    color: var(--ink);
  }

  .ranges { display: flex; flex-wrap: wrap; gap: 4px; }

  button {
    padding: 6px 12px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--ink-soft);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  button:hover { background: var(--grid); color: var(--ink); }

  button[aria-pressed="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  label {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--ink-soft);
    font-size: 13px;
    cursor: pointer;
  }

  input { accent-color: var(--accent); margin: 0; }

  abbr { text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }
`;

/**
 * Range selector and the duplicate toggle.
 *
 * Emits `range-change`; it holds no opinion about what the change means, and never fetches. The
 * app decides what to do with it, which keeps this element trivially testable in isolation.
 */
export class RangeControls extends HTMLElement {
  readonly #root: ShadowRoot;
  #state: RangeState = { dedupe: true, range: "24h" };

  constructor() {
    super();

    this.#root = this.attachShadow({ mode: "open" });

    const style = new CSSStyleSheet();

    style.replaceSync(CSS);
    this.#root.adoptedStyleSheets = [ style ];
  }

  connectedCallback(): void {
    this.#render();
  }

  set state(value: RangeState) {
    this.#state = value;
    this.#render();
  }

  get state(): RangeState {
    return this.#state;
  }

  #emit(): void {
    this.dispatchEvent(new CustomEvent<RangeState>("range-change",
      { bubbles: true, detail: { ...this.#state } }));
  }

  #render(): void {
    const buttons = RANGE_LABELS.map(([ key, label ]) =>
      `<button type="button" data-range="${ key }" aria-pressed="${ key === this.#state.range }">` +
      label + "</button>").join("");

    this.#root.innerHTML =
      `<div class="ranges">${ buttons }</div>` +
      "<label><input type=\"checkbox\"" + (this.#state.dedupe ? " checked" : "") + ">" +
      "<abbr title=\"Protect sometimes reports one vehicle as two overlapping events. Merged passes " +
      "are marked in the table below.\">Merge duplicate passes</abbr></label>";

    for(const button of this.#root.querySelectorAll("button")) {
      button.addEventListener("click", () => {
        this.#state = { ...this.#state, range: button.dataset.range as RangeKey };
        this.#render();
        this.#emit();
      });
    }

    (this.#root.querySelector("input") as HTMLInputElement).addEventListener("change", (event) => {
      this.#state = { ...this.#state, dedupe: (event.target as HTMLInputElement).checked };
      this.#emit();
    });
  }
}

customElements.define("range-controls", RangeControls);
