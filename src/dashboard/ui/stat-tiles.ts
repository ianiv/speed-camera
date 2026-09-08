import { Panel } from "./base.js";
import type { SpeedStats } from "../types.js";

export interface TilesData {
  stats: SpeedStats;
  speedLimitKph: number;
}

const CSS = `
  :host { padding: 0; border: 0; background: none; box-shadow: none; margin-bottom: 18px; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
  }

  .tile {
    padding: 14px 16px 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow);
  }

  .label {
    display: block;
    color: var(--ink-soft);
    font-size: 12px;
  }

  .value {
    display: block;
    margin-top: 6px;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }

  .unit { margin-left: 3px; font-size: 13px; font-weight: 400; color: var(--ink-faint); }
  .note { display: block; margin-top: 4px; color: var(--ink-faint); font-size: 11px; }
  .tile.headline .value { color: var(--accent); }
  .tile.alarm .value { color: var(--over); }

  abbr { text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }
`;

/**
 * The headline numbers.
 *
 * The 85th percentile leads rather than the mean. It is the figure traffic engineering is built
 * around - the speed most drivers consider reasonable, and the one a council or police service will
 * ask for - whereas a mean is pulled down by the cautious majority and hides the fast tail entirely.
 */
export class StatTiles extends Panel<TilesData> {
  constructor() {
    super(CSS);
  }

  protected render({ speedLimitKph, stats }: TilesData): void {
    if(!stats.n) {
      this.root.innerHTML = "<div class=\"grid\"><div class=\"tile\"><span class=\"label\">" +
        "No measured passes in this range</span></div></div>";

      return;
    }

    const share = (stats.overLimitShare * 100).toFixed(share100(stats.overLimitShare) ? 0 : 1);

    this.root.innerHTML = "<div class=\"grid\">" + [
      tile("85th percentile", stats.p85Kph.toFixed(1), "km/h", "headline",
        "<abbr title=\"85% of drivers travel at or below this speed. The standard traffic-" +
        "engineering measure of how fast a road actually runs.\">what most drivers keep under</abbr>"),
      tile("Median", stats.medianKph.toFixed(1), "km/h", "", "typical pass"),
      tile("Fastest", stats.maxKph.toFixed(1), "km/h", stats.maxKph > speedLimitKph ? "alarm" : "",
        "single highest reading"),
      tile("Over " + speedLimitKph + " km/h", String(stats.overLimit), "",
        stats.overLimit ? "alarm" : "", share + "% of passes"),
      tile("Passes", String(stats.n), "", "", "measured vehicles")
    ].join("") + "</div>";
  }
}

/** Whether the share is a whole percentage, so 0% and 100% do not render as "0.0%". */
function share100(share: number): boolean {
  return (share === 0) || (share === 1);
}

function tile(label: string, value: string, unit: string, kind: string, note: string): string {
  return "<div class=\"tile " + kind + "\"><span class=\"label\">" + label + "</span>" +
    "<span class=\"value\">" + value + (unit ? "<span class=\"unit\">" + unit + "</span>" : "") +
    "</span><span class=\"note\">" + note + "</span></div>";
}

customElements.define("stat-tiles", StatTiles);
