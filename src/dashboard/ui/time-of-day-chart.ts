import { Panel } from "./base.js";
import type { DirectionSplit, HourBucket } from "../types.js";

export interface TimeOfDayData {
  byHour: HourBucket[];
  byDirection: [DirectionSplit, DirectionSplit];
  speedLimitKph: number;
}

const CSS = `
  .vol { fill: var(--volume); }
  .vol:hover { fill: var(--accent); }
  .axis { stroke: var(--line); stroke-width: 1; }
  .gridline { stroke: var(--grid); stroke-width: 1; }

  .speed { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
  .dot { fill: var(--accent); }
  .dot.over { fill: var(--over); }
  .limit { stroke: var(--over); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .limit-label { fill: var(--over); font-weight: 600; }

  .dirs { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }

  .dir {
    flex: 1 1 190px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }

  .dir .name { color: var(--ink-soft); font-size: 12px; }
  .dir .n { float: right; color: var(--ink-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
  .dir .figs { margin-top: 6px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .dir .figs b { font-weight: 600; }
  .dir .figs .over { color: var(--over); }
  .dir .figs span { color: var(--ink-faint); }
`;

const W = 720;
const H = 210;
const PAD = { bottom: 26, left: 30, right: 34, top: 22 };

/**
 * Traffic and speed by hour of day.
 *
 * Volume and mean speed share an axis on purpose: the interesting hours are the ones where they
 * diverge. Quiet roads are fast roads, so a late-evening peak in speed against a trough in volume
 * is the pattern worth acting on, and two separate charts would make it easy to miss.
 */
export class TimeOfDayChart extends Panel<TimeOfDayData> {
  constructor() {
    super(CSS);
  }

  protected render({ byDirection, byHour, speedLimitKph }: TimeOfDayData): void {
    const heading = "<h2>Traffic through the day</h2><p class=\"hint\">Bars are the number of " +
      "passes in each hour; the line is their mean speed. Hours with no traffic are left blank.</p>";

    const measured = byHour.filter((bucket) => bucket.n > 0);

    if(!measured.length) {
      this.root.innerHTML = heading + "<div class=\"empty\">No measured passes in this range.</div>";

      return;
    }

    const peakVolume = Math.max(...byHour.map((bucket) => bucket.n), 1);
    const topSpeed = Math.max(speedLimitKph * 1.3, ...measured.map((bucket) => bucket.meanKph));
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const slot = plotW / 24;

    const x = (hour: number) => PAD.left + (hour + 0.5) * slot;
    const yVolume = (n: number) => PAD.top + plotH - (n / peakVolume) * plotH;
    const ySpeed = (speed: number) => PAD.top + plotH - (speed / topSpeed) * plotH;

    const bars = byHour.map((bucket) => bucket.n
      ? `<rect class="vol" x="${ PAD.left + bucket.hour * slot + 1.5 }" y="${ yVolume(bucket.n) }" ` +
        `width="${ slot - 3 }" height="${ PAD.top + plotH - yVolume(bucket.n) }" rx="2">` +
        `<title>${ String(bucket.hour).padStart(2, "0") }:00 - ${ bucket.n } pass` +
        (bucket.n === 1 ? "" : "es") + ", mean " + bucket.meanKph.toFixed(1) + " km/h</title></rect>"
      : "").join("");

    // The line only spans hours that actually have traffic; bridging an empty hour would invent a
    // speed for a time when nothing was measured.
    const segments: string[] = [];
    let current: string[] = [];

    for(const bucket of byHour) {
      if(bucket.n) {
        current.push(x(bucket.hour).toFixed(1) + "," + ySpeed(bucket.meanKph).toFixed(1));
      } else if(current.length) {
        segments.push(current.join(" "));
        current = [];
      }
    }

    if(current.length) {
      segments.push(current.join(" "));
    }

    const line = segments.filter((points) => points.includes(" "))
      .map((points) => `<polyline class="speed" points="${ points }"/>`).join("");

    const dots = measured.map((bucket) =>
      `<circle class="dot${ bucket.meanKph > speedLimitKph ? " over" : "" }" ` +
      `cx="${ x(bucket.hour) }" cy="${ ySpeed(bucket.meanKph) }" r="2.5"/>`).join("");

    const hourLabels = byHour.filter((bucket) => bucket.hour % 3 === 0)
      .map((bucket) => `<text x="${ x(bucket.hour) }" y="${ H - PAD.bottom + 14 }" text-anchor="middle">` +
        String(bucket.hour).padStart(2, "0") + "</text>").join("");

    this.root.innerHTML = heading +
      `<svg viewBox="0 0 ${ W } ${ H }" role="img" aria-label="Passes and mean speed by hour of day">` +
      bars +
      `<line class="limit" x1="${ PAD.left }" y1="${ ySpeed(speedLimitKph) }" x2="${ W - PAD.right }" y2="${ ySpeed(speedLimitKph) }"/>` +
      `<text class="limit-label" x="${ W - PAD.right + 3 }" y="${ ySpeed(speedLimitKph) + 3 }">${ speedLimitKph }</text>` +
      line + dots +
      `<line class="axis" x1="${ PAD.left }" y1="${ PAD.top + plotH }" x2="${ W - PAD.right }" y2="${ PAD.top + plotH }"/>` +
      hourLabels +
      `<text x="${ PAD.left }" y="${ PAD.top - 8 }">passes / mean km/h</text>` +
      "</svg>" +
      "<div class=\"dirs\">" + byDirection.map((dir) => direction(dir, speedLimitKph)).join("") + "</div>";
  }
}

function direction(split: DirectionSplit, speedLimitKph: number): string {
  if(!split.n) {
    return "<div class=\"dir\"><span class=\"name\">" + split.label +
      "</span><div class=\"figs\"><span>no passes</span></div></div>";
  }

  const fast = split.p85Kph > speedLimitKph;

  return "<div class=\"dir\"><span class=\"name\">" + split.label + "</span>" +
    "<span class=\"n\">" + split.n + " pass" + (split.n === 1 ? "" : "es") + "</span>" +
    "<div class=\"figs\"><b class=\"" + (fast ? "over" : "") + "\">" + split.p85Kph.toFixed(1) +
    "</b> <span>85th</span> &middot; <b>" + split.meanKph.toFixed(1) + "</b> <span>mean km/h</span>" +
    "</div></div>";
}

customElements.define("time-of-day-chart", TimeOfDayChart);
