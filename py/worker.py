#!/usr/bin/env python3
"""Detect and track vehicles in a clip, and emit raw tracks as JSON on stdout.

This worker deliberately does no geometry and no speed maths. It answers one question - where was
each vehicle, in pixels, at what time - and hands that back to the Node side, which owns the
calibration, the homography and the fitting. Keeping it that way means a recalibration can re-derive
every speed from stored tracks without ever re-running a model.

The result is written to the path given by --out. It deliberately does not come back over stdout:
Ultralytics prints a download progress bar there the first time a model is fetched, which would make
the handoff fail exactly once per new model, on a machine that had worked fine the day before.
"""

import argparse
import json
import subprocess
import sys

# COCO classes that are vehicles on a street. Bicycle (1) is excluded deliberately - it is a road
# user, but its speed is rarely the question being asked and it inflates the reject rate.
VEHICLE_CLASSES = [2, 3, 5, 7]  # car, motorcycle, bus, truck


def log(message):
    print(message, file=sys.stderr, flush=True)


def probe_frame_times(video):
    """Per-frame presentation timestamps, in seconds.

    Protect's exports are not reliably constant-frame-rate, and a speed is a distance divided by a
    time - so assuming a nominal fps silently scales every measurement by whatever the real rate
    turned out to be. Reading the actual timestamps is the difference between a measurement and a
    guess, so it is worth the extra ffprobe pass.
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
             "-of", "json", video],
            capture_output=True, text=True, timeout=120, check=True).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as error:
        log(f"ffprobe failed ({error}); falling back to nominal frame rate.")
        return None

    times = []

    for frame in json.loads(out).get("frames", []):
        value = frame.get("pts_time")

        if value is None:
            continue

        try:
            times.append(float(value))
        except (TypeError, ValueError):
            continue

    if not times:
        return None

    # Decode order is not display order for B-frames, so sort before indexing.
    times.sort()

    # Rebase so the first frame is t=0. Only intervals matter for speed.
    return [t - times[0] for t in times]


def main():
    parser = argparse.ArgumentParser(description="Track vehicles in a video and emit raw tracks as JSON.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True, help="Path to write the result JSON to.")
    parser.add_argument("--model", default="yolo11s.pt")
    parser.add_argument("--device", default="mps")
    parser.add_argument("--conf", type=float, default=0.35)
    parser.add_argument("--iou", type=float, default=0.5)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--tracker", default="bytetrack.yaml")
    parser.add_argument("--still", action="store_true",
                        help="Treat --video as a single image and detect without tracking.")
    args = parser.parse_args()

    from ultralytics import YOLO

    if args.still:
        detect_still(YOLO(args.model), args)
        return

    frame_times = probe_frame_times(args.video)
    timing = "pts" if frame_times else "nominal"

    log(f"Loading {args.model} on {args.device}...")
    model = YOLO(args.model)

    tracks = {}
    names = {}
    width = height = 0
    frame_count = 0

    results = model.track(source=args.video, persist=True, tracker=args.tracker,
                          classes=VEHICLE_CLASSES, conf=args.conf, iou=args.iou,
                          imgsz=args.imgsz, device=args.device, stream=True, verbose=False)

    for index, result in enumerate(results):
        frame_count = index + 1

        if not height:
            height, width = result.orig_shape
            names = result.names

        boxes = result.boxes

        if boxes is None or boxes.id is None:
            continue

        # Use the real timestamp when we have one for this index, otherwise leave it for the
        # nominal-fps pass below.
        t = frame_times[index] if frame_times and index < len(frame_times) else None

        for box, track_id, cls, conf in zip(boxes.xyxy.tolist(), boxes.id.int().tolist(),
                                            boxes.cls.int().tolist(), boxes.conf.tolist()):
            # Keys are camelCase to match the TypeScript side that consumes this verbatim; this
            # JSON is the entire contract between the two runtimes.
            entry = tracks.setdefault(track_id, {"trackId": track_id, "cls": names.get(cls, str(cls)),
                                                 "points": []})
            entry["points"].append({"frame": index, "t": t, "bbox": [round(v, 2) for v in box],
                                    "conf": round(float(conf), 4)})

    # Nominal fps comes from the container, and is only used when the pts join was unavailable or
    # disagreed with the number of frames the tracker actually saw.
    nominal_fps = container_fps(args.video) or 15.0

    if frame_times and len(frame_times) != frame_count:
        log(f"ffprobe reported {len(frame_times)} frames but the tracker saw {frame_count}; "
            f"falling back to nominal {nominal_fps:.3f} fps.")
        timing = "nominal"
        frame_times = None

    for entry in tracks.values():
        for point in entry["points"]:
            if point["t"] is None:
                point["t"] = round(point["frame"] / nominal_fps, 6)
            else:
                point["t"] = round(point["t"], 6)

    effective_fps = (frame_count - 1) / frame_times[frame_count - 1] if (
        frame_times and frame_count > 1 and frame_times[frame_count - 1] > 0) else nominal_fps

    log(f"{frame_count} frames, {len(tracks)} tracks, timing={timing}.")

    result = {"video": args.video, "fps": round(effective_fps, 4), "timing": timing,
              "width": width, "height": height,
              "tracks": sorted(tracks.values(), key=lambda e: e["trackId"])}

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle)


def detect_still(model, args):
    """Detect vehicles in one image, emitting the same JSON shape with a single point per detection.

    Used to sanity-check a calibration: a parked car projected onto the road plane should come out
    about the size of a car. Sharing the output shape means the TypeScript side needs no second parser.
    """
    result = model(args.video, imgsz=args.imgsz, conf=args.conf, classes=VEHICLE_CLASSES,
                   device=args.device, verbose=False)[0]
    height, width = result.orig_shape
    tracks = []

    for i, (box, cls, conf) in enumerate(zip(result.boxes.xyxy.tolist(),
                                             result.boxes.cls.int().tolist(),
                                             result.boxes.conf.tolist())):
        tracks.append({"trackId": i, "cls": result.names.get(cls, str(cls)),
                       "points": [{"frame": 0, "t": 0.0, "bbox": [round(v, 2) for v in box],
                                   "conf": round(float(conf), 4)}]})

    log(f"still image, {len(tracks)} vehicle(s).")

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump({"video": args.video, "fps": 0.0, "timing": "nominal", "width": width,
                   "height": height, "tracks": tracks}, handle)


def container_fps(video):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=avg_frame_rate", "-of", "json", video],
            capture_output=True, text=True, timeout=30, check=True).stdout
        rate = json.loads(out)["streams"][0]["avg_frame_rate"]
        num, _, den = rate.partition("/")

        return float(num) / float(den) if float(den or 0) else None
    except Exception:
        return None


if __name__ == "__main__":
    main()
