import { Panel } from "./base.js";
import type { HistogramBin, SpeedStats } from "../types.js";

export interface HistogramData {
  histogram: HistogramBin[];
  stats: SpeedStats;
  speedLimitKph: number;
}

const CSS = `
  .bar { fill: var(--under); }
  .bar.over { fill: var(--over); }
  .bar:hover { opacity: 0.75; }

  .axis { stroke: var(--line); stroke-width: 1; }
  .gridline { stroke: var(--grid); stroke-width: 1; }

  .limit { stroke: var(--over); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .limit-label { fill: var(--over); font-weight: 600; }

  .marker { stroke: var(--accent); stroke-width: 1.5; }
  .marker-label { fill: var(--accent); font-weight: 600; }

  .count { fill: var(--ink-faint); font-size: 9px; }

  .legend { display: flex; gap: 16px; margin-top: 12px; color: var(--ink-faint); font-size: 11px; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
  .swatch-under { background: var(--under); }
  .swatch-over { background: var(--over); }
`;

const W = 720;
const H = 260;
// The generous top padding is for the three stacked marker labels, which sit above the plot.
const PAD = { bottom: 28, left: 30, right: 12, top: 48 };

/**
 * Speed distribution, with the limit and the summary statistics drawn in.
 *
 * A histogram is the honest way to show this: a single average would hide whether the street has a
 * uniform flow of slightly-too-fast traffic or a calm majority with a handful of genuinely
 * dangerous outliers. Those need different responses, and only the shape distinguishes them.
 */
export class SpeedHistogram extends Panel<HistogramData> {
  constructor() {
    super(CSS);
  }

  protected render({ histogram, speedLimitKph, stats }: HistogramData): void {
    const heading = "<h2>Speed distribution</h2><p class=\"hint\">Each bar is a " +
      (histogram[0] ? (histogram[0].toKph - histogram[0].fromKph) : 2) +
      " km/h band. Red bars are above the " + speedLimitKph + " km/h limit.</p>";

    if(!stats.n || !histogram.length) {
      this.root.innerHTML = heading + "<div class=\"empty\">No measured passes in this range.</div>";

      return;
    }

    const maxKph = histogram[histogram.length - 1]?.toKph ?? 1;
    const peak = Math.max(...histogram.map((bin) => bin.n), 1);
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const x = (speed: number) => PAD.left + (speed / maxKph) * plotW;
    const y = (count: number) => PAD.top + plotH - (count / peak) * plotH;

    // Round tick counts so the axis reads 0/2/4 rather than 0/1.67/3.33.
    const step = Math.max(1, Math.ceil(peak / 4));
    const ticks: number[] = [];

    for(let value = 0; value <= peak; value += step) {
      ticks.push(value);
    }

    const gridlines = ticks.map((tick) =>
      `<line class="gridline" x1="${ PAD.left }" y1="${ y(tick) }" x2="${ W - PAD.right }" y2="${ y(tick) }"/>` +
      `<text x="${ PAD.left - 6 }" y="${ y(tick) + 3 }" text-anchor="end">${ tick }</text>`).join("");

    const bars = histogram.map((bin) => {
      const left = x(bin.fromKph);
      const width = Math.max(1, x(bin.toKph) - left - 1);
      const top = y(bin.n);
      const over = bin.fromKph >= speedLimitKph;
      const title = bin.n + " pass" + (bin.n === 1 ? "" : "es") + " at " +
        bin.fromKph + "-" + bin.toKph + " km/h";

      return `<rect class="bar${ over ? " over" : "" }" x="${ left }" y="${ top }" ` +
        `width="${ width }" height="${ PAD.top + plotH - top }"><title>${ title }</title></rect>` +
        (bin.n ? `<text class="count" x="${ left + width / 2 }" y="${ top - 3 }" ` +
          `text-anchor="middle">${ bin.n }</text>` : "");
    }).join("");

    // Speed axis labels every 10 km/h.
    const speedTicks: string[] = [];

    for(let speed = 0; speed <= maxKph; speed += 10) {
      speedTicks.push(`<text x="${ x(speed) }" y="${ H - PAD.bottom + 14 }" text-anchor="middle">` +
        speed + "</text>");
    }

    this.root.innerHTML = heading +
      `<svg viewBox="0 0 ${ W } ${ H }" role="img" aria-label="Histogram of measured speeds">` +
      gridlines + bars +
      `<line class="axis" x1="${ PAD.left }" y1="${ PAD.top + plotH }" x2="${ W - PAD.right }" y2="${ PAD.top + plotH }"/>` +
      speedTicks.join("") +
      `<text x="${ W - PAD.right }" y="${ H - PAD.bottom + 14 }" text-anchor="end">km/h</text>` +
      rule(x(speedLimitKph), plotH, "limit", "limit " + speedLimitKph, 0) +
      rule(x(stats.p85Kph), plotH, "marker", "85th " + stats.p85Kph.toFixed(1), 1) +
      rule(x(stats.medianKph), plotH, "marker", "median " + stats.medianKph.toFixed(1), 2) +
      "</svg>" +
      "<div class=\"legend\"><span><i class=\"swatch-under\"></i>At or under the limit</span>" +
      "<span><i class=\"swatch-over\"></i>Over the limit</span></div>";
  }
}

/**
 * A labelled vertical rule.
 *
 * The median, the 85th percentile and the limit are often within a few km/h of each other - on a
 * well-behaved street that is exactly the point - so their labels would overprint into an unreadable
 * smear if they shared a line. `row` stacks them instead, and each rule is drawn up to its own label
 * so the connection stays obvious.
 */
function rule(atX: number, height: number, kind: string, label: string, row: number): string {
  const labelY = PAD.top - 34 + (row * 12);
  const anchor = atX > W * 0.8 ? "end" : "start";
  const offset = anchor === "end" ? -5 : 5;

  return `<line class="${ kind }" x1="${ atX }" y1="${ labelY - 4 }" x2="${ atX }" y2="${ PAD.top + height }"/>` +
    `<text class="${ kind }-label" x="${ atX + offset }" y="${ labelY }" text-anchor="${ anchor }">` +
    label + "</text>";
}

customElements.define("speed-histogram", SpeedHistogram);
