import type { Config } from "./config.js";

export interface LinkContext {
  host: string;
  cameraId: string;
  eventId: string;
  startMs: number;
  endMs: number;
}

/**
 * Build a link back to the event in the Protect UI.
 *
 * Since this project produces no annotated clips, this link is how any measurement gets checked
 * against the actual footage - it is the audit trail. The Protect web UI's URL scheme is not a
 * documented API and has changed between Protect versions, so it is a config template rather than a
 * guess hardcoded here: open a motion event in the Protect UI, copy the URL, and set
 * `protectUrlTemplate` in config.json to match.
 */
export function eventUrl(template: Config["protectUrlTemplate"], ctx: LinkContext): string {
  return template
    .replaceAll("{host}", ctx.host)
    .replaceAll("{cameraId}", encodeURIComponent(ctx.cameraId))
    .replaceAll("{eventId}", encodeURIComponent(ctx.eventId))
    .replaceAll("{startMs}", String(ctx.startMs))
    .replaceAll("{endMs}", String(ctx.endMs));
}
