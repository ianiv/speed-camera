import { escapeHtml, Panel } from "./base.js";
import type { Pass, PassSort, SortDirection } from "../types.js";

export interface PassesData {
  passes: Pass[];
  speedLimitKph: number;
  directionLabels: [string, string];
  sort: PassSort;
  direction: SortDirection;
  /** Passes in range before the page limit, so the table can say when it is showing a subset. */
  total: number;
  /** Whether footage is reachable from here. False drops the last column entirely. */
  playback: boolean;
  /** The street's timezone, when the reader may not be in it. Undefined means use the browser's. */
  timeZone: string | undefined;
}

export interface SortChange {
  sort: PassSort;
  direction: SortDirection;
}

const CSS = `
  .scroll { max-height: 520px; overflow: auto; margin: 0 -20px -20px; scroll-behavior: smooth; }

  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 8px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    color: var(--ink-faint);
    font-size: 11px;
    font-weight: 500;
    text-align: right;
    white-space: nowrap;
  }

  th:first-child, td:first-child { padding-left: 20px; text-align: left; }
  th:nth-child(2), td:nth-child(2) { text-align: left; }
  th:last-child, td:last-child { padding-right: 20px; text-align: left; }

  td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--grid);
    text-align: right;
    font-size: 13px;
    white-space: nowrap;
  }

  tr:last-child td { border-bottom: 0; }
  tr:hover td { background: var(--grid); }

  .kph { font-weight: 600; }
  .kph.over { color: var(--over); }
  .mph, .meta { color: var(--ink-faint); font-size: 12px; }

  .merged {
    display: inline-block;
    margin-left: 5px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--grid);
    color: var(--ink-faint);
    font-size: 10px;
    vertical-align: 1px;
  }

  a { color: var(--accent); text-decoration: none; font-size: 12px; }
  a:hover { text-decoration: underline; }

  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--ink); }
  th[aria-sort] { color: var(--accent); }

  th .arrow { margin-left: 3px; font-size: 9px; }

  /* The scroll box hangs 20px past its content to sit flush with the panel edge, so anything after
     it needs that space given back or it lands on top of the last row. */
  .scroll.has-note { margin-bottom: 0; }

  .truncated {
    padding: 10px 20px 0;
    border-top: 1px solid var(--line);
    color: var(--ink-faint);
    font-size: 11px;
  }

  button.play {
    padding: 3px 9px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  button.play:hover { background: var(--grid); }
  button.play[aria-expanded="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }

  tr.player td { padding: 0 20px 14px; background: var(--grid); }
  tr.player:hover td { background: var(--grid); }

  video {
    display: block;
    width: 100%;
    /* Short enough that the surrounding rows stay on screen: the point of playing in place is to
       keep the measurement and its footage in view together. */
    max-height: 320px;
    border-radius: 8px;
    background: #000;
  }

  .clip-note { padding: 6px 2px 0; color: var(--ink-faint); font-size: 11px; text-align: left; }
  .clip-note.error { color: var(--over); }
`;

/**
 * Whether this browser can decode the HEVC that Protect records.
 *
 * Safari and Chrome on Apple silicon can, and for them the clip is served straight through from the
 * recorder untouched. Everything else gets an H.264 transcode, which costs about a second and a
 * half. Asking the browser is the only reliable way to know - a user-agent guess would send Firefox
 * a file it cannot play and show a black rectangle with no explanation.
 */
function hevcCodec(): "hevc" | "h264" {
  const video = document.createElement("video");

  return video.canPlayType("video/mp4; codecs=\"hvc1\"") ? "hevc" : "h264";
}

/**
 * The individual passes, each playable in place.
 *
 * This is the audit trail: it is how any reading on this page gets checked against the footage that
 * produced it, and a number nobody can verify is not evidence of anything. The clip plays inline
 * rather than only linking out, because checking a measurement should not cost a context switch into
 * another application - the link to Protect stays for everything the dashboard does not show.
 */
export class PassesTable extends Panel<PassesData> {
  /**
   * Which rows have their player open, so a poll refresh does not close what you are watching.
   *
   * Keyed by pass, not by event: one clip can contain two vehicles, and they are two rows here.
   * Keying by event alone expands both of them from a single click.
   */
  readonly #open = new Set<string>();

  /** An update that arrived mid-playback, applied once the video stops. */
  #deferred: PassesData | null = null;

  /** A player opened by this render, to be scrolled into view once it exists in the DOM. */
  #justOpened: string | null = null;

  /**
   * The ordering the table was last drawn in.
   *
   * Rebuilding the markup drops the scroll box's position, so it is carried across a redraw by hand.
   * Carrying it across a *re-sort* would be wrong, though: the rows under you are then different
   * rows, so the only place that still means anything is the top.
   */
  #order: string | null = null;

  constructor() {
    super(CSS);
  }

  /** Identifies one row. The clip is per event, but the row is per measured vehicle. */
  static #key(pass: Pass): string {
    return pass.eventId + ":" + pass.trackId;
  }

  /** True while any open player is actually running. Rebuilding the table would restart it. */
  #playing(): boolean {
    return [ ...this.root.querySelectorAll("video") ].some((video) => !video.paused && !video.ended);
  }

  /**
   * Apply new data from the app.
   *
   * The page polls every 15 seconds, and re-rendering swaps out the `<video>` element - which resets
   * it to the first frame. Watching a clip is the one thing on this page that takes sustained
   * attention, so a *background* refresh waits. Only background refreshes: an action the viewer took
   * goes through `#draw` and always happens, because a button that ignores you is worse than a
   * table that is fifteen seconds stale.
   */
  protected render(data: PassesData): void {
    if(this.#playing()) {
      this.#deferred = data;

      return;
    }

    this.#draw(data);
  }

  #draw(data: PassesData): void {
    this.#deferred = null;

    const { direction: sortDir, directionLabels, passes, playback, sort, speedLimitKph, timeZone,
      total } = data;

    // The published copy has no last column, and the player row that spans the table has to know.
    const columns = playback ? 8 : 7;

    const order = sort === "speed"
      ? (sortDir === "desc" ? "Fastest first" : "Slowest first")
      : (sortDir === "desc" ? "Newest first" : "Oldest first");

    const heading = "<h2>Individual passes</h2><p class=\"hint\">" + order +
      " - click Time or km/h to re-sort." +
      (data.playback ? " Play the footage in place, or open the event in Protect." : "") + "</p>";

    // Read before the markup goes: a background poll must leave the viewer where they were reading.
    const ordering = sort + ":" + sortDir;
    const keep = (ordering === this.#order) ? this.root.querySelector(".scroll")?.scrollTop ?? 0 : 0;

    this.#order = ordering;

    if(!passes.length) {
      this.root.innerHTML = heading + "<div class=\"empty\">No measured passes in this range.</div>";

      return;
    }

    // Built once rather than per row, and pinned to the street's timezone when the reader may not
    // be standing in it - a published page read from another country should still say when the
    // traffic went past the camera, not what the reader's clock said at that moment.
    const clock = new Intl.DateTimeFormat([], timeZone === undefined
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone });

    const day = new Intl.DateTimeFormat([], timeZone === undefined
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", timeZone });

    const rows = passes.map((pass) => {
      const when = new Date(pass.atMs);
      const heading180 = ((pass.directionDeg % 360) + 540) % 360 - 180;
      const direction = Math.abs(heading180) <= 90 ? directionLabels[0] : directionLabels[1];
      const over = pass.speedKph > speedLimitKph;

      return "<tr><td>" + clock.format(when) +
        "<span class=\"meta\"> " + day.format(when) + "</span></td>" +
        "<td>" + escapeHtml(pass.cls) +
        (pass.mergedFrom > 1 ? "<span class=\"merged\" title=\"Measured " + pass.mergedFrom +
          " times from overlapping Protect events; the best-quality reading is shown.\">&times;" +
          pass.mergedFrom + "</span>" : "") + "</td>" +
        "<td class=\"kph" + (over ? " over" : "") + "\">" + pass.speedKph.toFixed(1) + "</td>" +
        "<td class=\"meta\">" + escapeHtml(direction) + "</td>" +
        "<td class=\"meta\">" + pass.distanceM.toFixed(1) + " m</td>" +
        "<td class=\"meta\">" + pass.nPoints + "</td>" +
        "<td class=\"meta\">" + pass.quality.toFixed(2) + "</td>" +
        (playback ? this.#actionsCell(pass) : "") + "</tr>" +
        (playback && this.#open.has(PassesTable.#key(pass)) ? this.#playerRow(pass, columns) : "");
    }).join("");

    // Only the page of rows the server sent is on screen, so say so when there are more - otherwise
    // "fastest first" reads as a claim about every pass in the range.
    const truncated = total > passes.length
      ? "<div class=\"truncated\">Showing " + passes.length + " of " + total + " passes in this range.</div>"
      : "";

    this.root.innerHTML = heading + "<div class=\"scroll" + (truncated ? " has-note" : "") +
      "\"><table><thead><tr>" +
      header("Time", "time", sort, sortDir) +
      "<th>Vehicle</th>" +
      header("km/h", "speed", sort, sortDir) +
      "<th>Direction</th>" +
      "<th title=\"Ground distance the fit was measured over\">Tracked</th>" +
      "<th title=\"Frames used in the fit\">Frames</th>" +
      "<th title=\"Composite of fit quality, sample count and frame timing\">Quality</th>" +
      (playback ? "<th></th>" : "") + "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      truncated;

    if(keep) {
      // Instant, not the smooth scrolling this box uses for opening a player: a refresh should look
      // like nothing happened, and an animation back to where you already were is the opposite.
      this.root.querySelector(".scroll")?.scrollTo({ behavior: "instant", top: keep });
    }

    for(const th of this.root.querySelectorAll("th.sortable")) {
      th.addEventListener("click", () => {
        const key = (th as HTMLElement).dataset.sort as PassSort;

        // Clicking the active column flips it; clicking a new one starts at the ordering that column
        // is usually wanted in - newest, and fastest.
        this.dispatchEvent(new CustomEvent<SortChange>("sort-change", { bubbles: true, detail: {
          direction: (key === sort) ? (sortDir === "desc" ? "asc" : "desc") : "desc",
          sort: key
        } }));
      });
    }

    for(const button of this.root.querySelectorAll("button.play")) {
      button.addEventListener("click", () => this.#toggle((button as HTMLElement).dataset.pass as string));
    }

    this.#wirePlayers();

    if(this.#justOpened) {
      // Matched on the dataset rather than built into a selector: the module-level `CSS` constant
      // here is this component's stylesheet, so `CSS.escape` is not the global one.
      const opened = [ ...this.root.querySelectorAll("tr.player") ]
        .find((row) => (row as HTMLElement).dataset.player === this.#justOpened);

      opened?.scrollIntoView({ block: "nearest" });
      this.#justOpened = null;
    }
  }

  /** The Play button and the way out to Protect. Only ever rendered where both can work. */
  #actionsCell(pass: Pass): string {
    return "<td><button type=\"button\" class=\"play\" data-pass=\"" + escapeHtml(PassesTable.#key(pass)) +
      "\" aria-expanded=\"" + this.#open.has(PassesTable.#key(pass)) + "\">Play</button> " +
      (pass.protectUrl === undefined ? "" : "<a href=\"" + escapeHtml(pass.protectUrl) +
        "\" target=\"_blank\" rel=\"noreferrer\">Protect</a>") + "</td>";
  }

  #playerRow(pass: Pass, columns: number): string {
    // The clip is the whole event, so two vehicles measured in one clip play the same footage - each
    // from its own row, which is where the speed it belongs to is written.
    return "<tr class=\"player\" data-player=\"" + escapeHtml(PassesTable.#key(pass)) +
      "\"><td colspan=\"" + columns + "\">" +
      "<video controls preload=\"metadata\" playsinline " +
      "src=\"/api/clip/" + encodeURIComponent(pass.eventId) + "?codec=" + hevcCodec() + "\"></video>" +
      "<div class=\"clip-note\">Fetching the clip from Protect&hellip;</div></td></tr>";
  }

  /**
   * Report what a failed clip actually means.
   *
   * A `<video>` that cannot load shows an empty black box and says nothing, and the two likely
   * causes here need different responses: footage aged out of the recorder's retention, or the
   * controller being unreachable. Guessing between them wastes the viewer's time.
   */
  #wirePlayers(): void {
    for(const video of this.root.querySelectorAll("video")) {
      const note = video.parentElement?.querySelector(".clip-note");

      video.addEventListener("loadedmetadata", () => {
        if(note) {
          note.textContent = Math.round(video.duration) + "s of footage, as recorded.";
        }
      });

      // Apply whatever the poll found while this was playing.
      for(const stopped of [ "pause", "ended" ]) {
        video.addEventListener(stopped, () => {
          if(this.#deferred) {
            this.#draw(this.#deferred);
          }
        });
      }

      video.addEventListener("error", async () => {
        if(!note) {
          return;
        }

        note.classList.add("error");

        // The element only knows that loading failed; the server says why.
        try {
          const response = await fetch(video.src);
          const body = await response.json() as { error?: string };

          note.textContent = body.error ?? ("Could not load the clip (HTTP " + response.status + ").");
        } catch {
          note.textContent = "Could not load the clip. Is the Protect controller reachable?";
        }
      });
    }
  }

  #toggle(key: string): void {
    if(this.#open.has(key)) {
      this.#open.delete(key);
    } else {
      this.#open.add(key);
      this.#justOpened = key;
    }

    // Whatever the poll found while a clip was playing is newer than what is on screen, so fold it
    // in here rather than throwing it away or waiting for the next tick.
    const data = this.#deferred ?? this.data;

    if(data) {
      this.#draw(data);
    }
  }
}

/** A column header that can be clicked to sort, marked up so screen readers announce the order. */
function header(label: string, key: PassSort, active: PassSort, direction: SortDirection): string {
  const on = key === active;
  const arrow = on ? "<span class=\"arrow\">" + (direction === "desc" ? "\u25bc" : "\u25b2") + "</span>" : "";

  return "<th class=\"sortable\" data-sort=\"" + key + "\"" +
    (on ? " aria-sort=\"" + (direction === "desc" ? "descending" : "ascending") + "\"" : "") +
    " title=\"Sort by " + label + "\">" + label + arrow + "</th>";
}

customElements.define("passes-table", PassesTable);
