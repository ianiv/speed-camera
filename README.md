# speed-camera

Measures how fast cars actually go past a UniFi Protect camera.

Protect already knows *when* a vehicle passed — it emits a smart-detect event with
`objectTypes: ["vehicle"]`. It does not know how fast. This project takes those events, pulls the
clip off the NVR, tracks each vehicle frame by frame, projects the track onto the road surface using
a four-point homography, and fits a speed. Results go into SQLite, each row linking back to the
original event in the Protect UI so any number can be checked against the actual footage.

## How it works

```
smart-detect event (live or backfilled)
  → wait for the event to close, resolve [start, end]
  → GET /proxy/protect/api/video/export         → clip.mp4
  → py/worker.py  (YOLO11 + ByteTrack)          → raw tracks: bbox + timestamp per frame
  → persist raw tracks
  → homography + robust line fit + quality gates (TypeScript)
  → measurement row + link back to Protect
```

Node owns the Protect connection, storage, geometry and fitting. Python owns only detection and
tracking. Because the raw tracks are persisted, changing the calibration and re-deriving every speed
you have ever measured (`refit`) takes seconds — no re-downloading, no re-running the model.

## Why the lens has to be corrected first

A homography is a pinhole model: it assumes straight lines in the world stay straight in the
picture. A wide-angle camera breaks that — a straight kerb visibly bows — and the error grows with
distance from the centre of the frame. On a view where the road spans the full width, that is not a
rounding error. Measured on a synthetic camera with realistic barrel distortion, ignoring it gives:

| True speed | Car on the left | In the centre | On the right |
| --- | --- | --- | --- |
| 30 km/h | +2.6% | +8.6% | +1.2% |
| 50 km/h | +6.0% | +5.8% | −5.9% |
| 70 km/h | +5.4% | +0.5% | −7.1% |

The same car at the same speed reads differently depending on where it passed — a swing of about 15
percentage points across the frame, and one that no amount of careful distance measuring would fix.
Worse, it makes a constant-speed pass look like it accelerated, so the `poor-linear-fit` gate throws
away good measurements.

UniFi Protect exposes no lens intrinsics (`hasFisheye: false`, `lensType: null`), so the
coefficients are recovered from the scene itself by the plumb-line method: you trace what you know
is straight, and the solver searches for the radial correction that straightens it. With the lens
modelled, the same synthetic test returns the true speed to within 0.05 km/h everywhere in frame.

## Why four points and not one distance

A single "the frame is N metres wide" figure is a uniform pixels-per-metre scale. That is exactly
right only when the camera looks perpendicularly across the street. Point it at any angle down the
road and the near lane and the far lane have wildly different scales, so the same car reads as two
different speeds depending on where it happens to be.

Four measured points on the road define the full projective map between the image and the road
plane, which corrects that. `test/speed.test.ts` asserts it directly: the same physical speed in the
near lane and the far lane must come back as the same number.

## Setup

Requires Node 24+, `ffmpeg`/`ffprobe` on `PATH`, and `uv`.

```bash
npm install

# Python worker. Pinned to 3.12 - torch and ultralytics wheels lag newer CPython.
cd py && uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python ultralytics opencv-python-headless lap && cd ..

cp .env.example .env        # then fill in a LOCAL Protect admin account, not a ui.com login
cp config.example.json config.json
```

### 1. Prove the connection works

```bash
npm run ufp-speed probe
```

Lists your cameras, fetches a snapshot, downloads a test clip, counts recent vehicle events, and
prints a link to the most recent one. **Open that link.** If it does not land on the event, fix
`protectUrlTemplate` in `config.json` — the Protect UI's URL scheme is not a documented API and
varies by version, so it is a template rather than a guess baked into the code.

Then put the camera id you want into `config.json`.

### 2. Calibrate

```bash
npm run ufp-speed calibrate
```

If a calibration for this camera already exists it is **loaded into the page**, so adjusting one
point does not mean redoing the lens traces, the ground measurements and the road outline. Points
are rescaled if the frame resolution has changed since; the lens coefficients need no rescaling,
being defined on normalised coordinates. **Start fresh** in the header clears everything. A saved
calibration belonging to a *different* camera is ignored rather than partly reused.

Opens a local page showing a full-resolution frame pulled from an actual clip — not the snapshot
endpoint, which serves a reduced size regardless of what is asked for. On it:

1. **Correct the lens first.** Trace 2–3 things that are straight in real life but bent in the
   picture — a kerb, a roofline, a fence — then press **Solve lens**. The green corrected traces
   should land on the dashed straight chords. See below for why this comes first.
2. Click **four points on the road surface**. Keep clicking the photo *as it looks* — bends and
   all. The picture is never straightened on screen; the lens correction is applied to your clicks., going around the shape — near-left, near-right,
   far-right, far-left. Not diagonally.
   **Adjusting points:** drag any point to move it. Click one to select, then arrow keys nudge it a
   pixel at a time (Shift for 10), Delete removes it, Esc deselects. A magnifier follows the cursor.
   This matters more than it sounds: a 4K frame displayed a few hundred pixels wide means one screen
   pixel covers four or five image pixels, so dragging by eye alone cannot use the resolution the
   camera actually gives you. Moving a traced lens point re-solves the lens automatically.
3. Enter where each point sits on the ground, in metres — X across the street, Y along it. The
   origin can be anywhere; only the distances between points matter. **They need not form a
   rectangle**: a homography needs four *known* points, not four square ones, and a real road
   rarely offers a true rectangle. There is a rectangle shortcut for when it genuinely is one.
4. Optionally outline the drivable road, so tracks straying onto the pavement are rejected.

Pick points at road level, where tyres touch — the end of a lane marking, a driveway corner, the
base of a pole. A point on top of a kerb or a wall is above the road plane and will bias every
speed you ever measure.

**Then run `verify`.** It detects whatever cars are currently parked on the street and projects
their ground footprint through your homography. A car seen side-on should read about 4.3–5.0 m. If
it reads 7 m, your distances are ~50% too large and every speed would be too — a two-minute fix now,
versus a week of readings that all look like everyone speeds.

**And check the green grid.** It is 1-metre squares projected onto the road. If it lies flat along
the road and stays roughly square, the calibration is good. If it fans out or skews, a point is
misplaced. This check costs nothing and catches nearly everything.

### 3. Run

```bash
npm run ufp-speed backfill --from 24h   # process the last day
npm run ufp-speed daemon                # process events as they happen
npm run ufp-speed list                  # see measurements
npm run ufp-speed list --csv > speeds.csv
npm run ufp-speed stats                 # counts, and why tracks were rejected
npm run ufp-speed dashboard             # http://127.0.0.1:8738
```

## Commands

| Command | What it does |
| --- | --- |
| `probe` | Verify credentials, list cameras, test a snapshot and a clip export |
| `calibrate [--camera <id>]` | Pick the four road points |
| `watch` | Print vehicle events live, without processing |
| `daemon` | Process events as they happen |
| `backfill --from <t> [--to <t>] [--limit <n>] [--force]` | Process past events |
| `refit` | Recompute every speed from stored tracks under the current calibration |
| `crosscheck <eventId>` | Sanity-check one event against Protect's own detection boxes |
| `verify` | Check the calibration against the real size of parked cars |
| `list [--since <t>] [--min-kph <n>] [--rejected] [--csv]` | Show measurements |
| `stats` | Counts and rejection breakdown |
| `dashboard [--port <n>]` | Serve the speed dashboard on 127.0.0.1 |

Times are ISO 8601 (`2026-09-01T08:00`) or a relative age (`90m`, `6h`, `2d`). `--debug` on any
command turns on verbose logging, including the worker's own output.

## The dashboard

```bash
npm run ufp-speed dashboard
```

Serves on `127.0.0.1:8738` — loopback only, since it is a timestamped log of the traffic outside
your house that links straight back into your camera system. It reads `data/speeds.db` live and
re-polls every 15 seconds, so it can be left open beside `daemon`.

It leads with the **85th percentile** rather than the mean. That is the figure traffic engineering
is built around, and the one a council or police service will ask for: the mean is dragged down by
the cautious majority and hides the fast tail entirely.

### Sorting

Click **Time** or **km/h** to re-sort; clicking the active column reverses it. The sort is applied on
the server, before the row limit — sorting a page of the newest 500 by speed in the browser would
label the fastest of those "the fastest", which is a quietly wrong answer rather than a missing one.
The table says when it is showing a subset.

### Playing the footage

Press **Play** on any row and the clip plays inline. The dashboard asks Protect for the export,
buffers it, and serves it back — measured on this controller, a 13-second 4K clip comes back in
about **250 ms**, because `/video/export` is remuxing segments the recorder already holds rather
than re-encoding anything. Replays come from an in-memory cache and are instant.

Two details make it work:

- **Protect ignores `Range`** — it answers every request with the whole file — so a `<video>`
  element pointed straight at it cannot seek. The dashboard buffers the export and does the ranging
  itself, which is what makes the scrub bar work.
- **Protect records HEVC.** Safari and Chrome on Apple silicon decode it directly, and those
  browsers get the original file untouched. Anything else gets an H.264 transcode
  (hardware-encoded, about 1.5 s, cached thereafter). The page asks the browser what it can play
  rather than guessing from a user agent.

Nothing is stored on disk. Playback works for as long as Protect retains the footage; past that the
player says so rather than showing a black rectangle. `dashboard.clipChannel` switches to the
camera's 640x360 substream if you are on a slow link.

### Duplicate passes

Protect sometimes emits two overlapping events for one vehicle, so the same car gets downloaded and
measured twice. The dashboard merges these by default, and the toggle shows the raw rows.

The merge is not a guess at "same class, similar speed" — that would collapse two genuinely
different cars. Each measurement's frame times are put back on the wall clock
(`events.start_ms - clip.preRollMs + track t`), and two measurements are the same pass only when
they come from different events, their time windows physically overlap, their class matches, and
their headings agree within 20 degrees. The heading test is load-bearing: two vehicles passing
simultaneously in opposite directions overlap in time and would otherwise merge into one phantom.

Nothing is deleted — this is a view over the rows, and `list` still shows every raw measurement.
When two readings of one vehicle disagree it is because one track is much shorter, so the merged
row keeps the higher-quality member.

## Reading the results

A measurement is only kept if it passes every gate. Rejections are stored too, with the reason —
`stats` breaks them down, and that breakdown is the first thing to look at if coverage seems low:

| Reason | Meaning |
| --- | --- |
| `too-few-points` / `too-brief` | The vehicle was in frame too briefly to fit |
| `touches-frame-edge` | The box was clipped by the frame throughout. Points clipped at the start and end of a pass are trimmed, not fatal — this reason means there was no usable middle |
| `outside-roi` | Most of the track was outside the road area you drew |
| `outside-calibrated-area` | Most of the track ran beyond the four points, where a homography stops being trustworthy |
| `poor-linear-fit` | The vehicle accelerated or braked, **or the lens is uncorrected**. Not a constant-velocity sample, so it is discarded rather than reported as an average that describes no moment of the pass |
| `too-little-travel` | Barely moved |
| `low-confidence` | The detector was not sure it was a vehicle |

Coverage well below 100% of events is normal and intended.

Tracks are **trimmed, not discarded**, when only part of a pass is usable. On a camera where the
road spans the frame, every vehicle is clipped as it enters and again as it leaves, so the
measurable pass is the middle of it. A track broken in two by an occlusion is measured on its longer
half rather than fitted across the gap, where the vehicle might have changed speed unseen.

## Accuracy

The synthetic tests recover known speeds exactly, but they test the maths, not your camera. The real
acceptance test is a ground-truth drive:

> Drive past at a GPS-verified constant speed (phone GPS, not the speedometer), three times in each
> direction, at roughly 30 and 50 km/h. Compare with `list`.

Aim for ±10%. If the error is a consistent *ratio*, the measured distances in the calibration are
wrong — fix them and run `refit`. If it differs by direction, the four points are not all on the
road plane.

`crosscheck <eventId>` gives a second opinion without leaving your chair. Protect attaches its own
sparse detection boxes to each event; running those through the same homography yields a very rough
speed from an entirely different detector. Far too coarse to trust as a measurement, but if it
disagrees with ours by a factor of ten, something structural is wrong and no threshold tuning will
fix it.

Known limitations:

- Assumes vehicles travel on the calibrated plane. A strongly crowned or sloped road introduces
  error a four-point homography cannot correct.
- Occlusion breaks tracks. ByteTrack usually re-acquires with a new id, giving two short tracks that
  both likely fail the gates.
- Night accuracy is materially worse: headlight bloom destabilises the bottom edge of the bounding
  box, which is exactly the anchor the measurement depends on.
- If frame presentation timestamps are unavailable, timing falls back to nominal frame rate and
  affected measurements are scored down (`timing: nominal`).
- Lens correction is radial only. Tangential (decentring) distortion is not modelled; it is far
  smaller than the radial term on this class of camera.
- The fit assumes a straight path across the calibrated stretch. If the road curves noticeably
  through it, `stats` will show a pile of `poor-linear-fit` — keep the calibration quad on a
  straight section.

## Configuration

`config.json` — tuning. `.env` — credentials only (gitignored, along with `data/`).

The gates worth knowing about in `config.json`:

- `speed.minR2` (0.95) — how strictly constant the speed must be. Lower it to accept more, at the
  cost of averaging over vehicles that were changing speed.
- `speed.extrapolationMarginM` (5) — how far beyond the calibration quad a track may stray. This is
  the usual source of absurd readings if set too high.
- `clip.channel` (0) — 0 is the highest-quality stream. Raise it to trade detection accuracy for speed.
- `worker.imgsz` (960) — inference resolution. Raise it if vehicles are small and distant in frame.
- `speed.minPixelTravel` (25) — image-space movement below which a track is discarded before
  storage. A street view is full of parked cars that are detected in every frame of every event;
  without this they would dwarf the real measurements on disk and slow `refit` down.
- `speedLimitKph` (30) — the posted limit. The dashboard counts and colours passes against it.
- `dashboard.directionLabels` — what to call the two directions of travel. The first is the heading
  along ground +X, the axis the calibration quad was measured along. Which compass direction that
  is depends on the camera and on the order the quad's corners were clicked, so check it rather than
  assume: pick any pass in the table, open its footage, and see which way the vehicle actually went.
  If the labels are the wrong way round, swap them.
- `alertKph` — log a warning above this speed. `null` disables.

## Tests

```bash
npm test
```

Covers the homography (exact reconstruction, inverse round-trip, degenerate input), speed recovery
through a synthetic perspective view, every quality gate, storage and refit, and the JSON contract
between the Python worker and TypeScript — captured from a real worker run, so a drift in either
runtime fails the build.
