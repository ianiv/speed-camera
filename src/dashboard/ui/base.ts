/**
 * Shared plumbing for the dashboard's custom elements.
 *
 * Each component owns a shadow root, so its markup and styles cannot collide with any other's - the
 * reason this needs no framework and no class-name discipline. The design tokens in style.css still
 * reach inside, because custom properties cross the shadow boundary by design.
 */

/** Build a constructable stylesheet, shared by every instance of a component rather than re-parsed. */
export function sheet(css: string): CSSStyleSheet {
  const style = new CSSStyleSheet();

  style.replaceSync(css);

  return style;
}

/** Styles every panel shares: the card itself, its heading, and the empty state. */
export const PANEL_CSS = `
  :host {
    display: block;
    margin-bottom: 18px;
    padding: 18px 20px 20px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow);
    color: var(--ink);
    font: 14px/1.5 var(--sans);
  }

  h2 {
    margin: 0 0 2px;
    font-size: 14px;
    font-weight: 600;
  }

  p.hint {
    margin: 0 0 16px;
    color: var(--ink-faint);
    font-size: 12px;
  }

  .empty {
    padding: 28px 0;
    color: var(--ink-faint);
    text-align: center;
  }

  svg { display: block; width: 100%; height: auto; overflow: visible; }
  text { fill: var(--ink-faint); font-family: var(--sans); font-size: 10px; }
`;

export abstract class Panel<T> extends HTMLElement {
  protected readonly root: ShadowRoot;
  #data: T | null = null;

  constructor(css: string) {
    super();

    this.root = this.attachShadow({ mode: "open" });
    this.root.adoptedStyleSheets = [ sheet(PANEL_CSS + css) ];
  }

  /**
   * The component's input. Assigning it re-renders.
   *
   * A property rather than an attribute because these are objects: serialising a histogram through
   * an attribute string would be a needless round trip through JSON on every poll.
   */
  set data(value: T) {
    this.#data = value;
    this.render(value);
  }

  get data(): T | null {
    return this.#data;
  }

  protected abstract render(data: T): void;
}

/** Escape text bound for an innerHTML string. Speeds and class names are ours, but URLs are not. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "\"": "&quot;", "&": "&amp;", "'": "&#39;", "<": "&lt;", ">": "&gt;" })[char] as string);
}

/** One decimal place, with a non-breaking thin space before the unit so it never wraps alone. */
export function kph(value: number): string {
  return value.toFixed(1) + " km/h";
}
