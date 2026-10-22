"""Read every decoded E2E video frame and flag discontinuities for visual review.

Usage: python scripts/audit-video-frames.py VIDEO.mp4 OUTPUT_DIR
The CSV keeps one row per decoded frame; the JSON groups candidate intervals.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def intervals(indices: list[int], minimum: int = 1) -> list[dict[str, int]]:
    if not indices:
        return []
    result = []
    start = end = indices[0]
    for index in indices[1:]:
        if index == end + 1:
            end = index
        else:
            if end - start + 1 >= minimum:
                result.append({"first": start, "last": end, "frames": end - start + 1})
            start = end = index
    if end - start + 1 >= minimum:
        result.append({"first": start, "last": end, "frames": end - start + 1})
    return result


def main(video_path: Path, output_dir: Path) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"No se pudo abrir el vídeo: {video_path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    declared_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if fps <= 0 or width <= 0 or height <= 0:
        raise RuntimeError("Metadatos de vídeo incompletos")

    rows = []
    black = []
    still = []
    large_changes = []
    previous = None
    index = 0
    csv_path = output_dir / "frames.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow([
            "frame", "seconds", "mean_luma", "dark_fraction", "changed_fraction",
            "mean_difference", "top_difference", "terminal_difference", "near_black",
        ])
        while True:
            success, frame = capture.read()
            if not success:
                break
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            small = cv2.resize(gray, (640, 360), interpolation=cv2.INTER_AREA)
            mean_luma = float(np.mean(small))
            dark_fraction = float(np.mean(small < 8))
            near_black = dark_fraction > 0.995 and mean_luma < 2.5
            if previous is None:
                changed_fraction = mean_difference = top_difference = terminal_difference = 0.0
            else:
                difference = cv2.absdiff(small, previous)
                changed_fraction = float(np.mean(difference > 5))
                mean_difference = float(np.mean(difference))
                top_difference = float(np.mean(difference[:45]))
                terminal_difference = float(np.mean(difference[45:330]))
                if changed_fraction < 0.000005 and mean_difference < 0.03:
                    still.append(index)
                if changed_fraction > 0.12 or mean_difference > 12:
                    large_changes.append(index)
            if near_black:
                black.append(index)
            writer.writerow([
                index, round(index / fps, 4), round(mean_luma, 4), round(dark_fraction, 6),
                round(changed_fraction, 7), round(mean_difference, 4),
                round(top_difference, 4), round(terminal_difference, 4), int(near_black),
            ])
            rows.append((index, changed_fraction, mean_difference))
            previous = small
            index += 1
            if index % 5000 == 0:
                print(f"{video_path.name}: {index} frames analizados", flush=True)
    capture.release()

    summary = {
        "video": str(video_path.resolve()),
        "declaredFrames": declared_frames,
        "decodedFrames": index,
        "frameCountMatches": declared_frames == index,
        "fps": fps,
        "durationSeconds": index / fps,
        "width": width,
        "height": height,
        "allFramesCompared": index > 0 and len(rows) == index,
        "blackIntervals": intervals(black),
        "stillIntervalsOverTwoSeconds": intervals(still, max(1, round(fps * 2))),
        "largeChangeIntervals": intervals(large_changes),
        "largestChanges": [
            {"frame": i, "seconds": round(i / fps, 3), "changedFraction": round(c, 5), "meanDifference": round(m, 3)}
            for i, c, m in sorted(rows, key=lambda row: row[2], reverse=True)[:40]
        ],
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: summary[key] for key in (
        "decodedFrames", "frameCountMatches", "fps", "durationSeconds", "allFramesCompared",
        "blackIntervals", "stillIntervalsOverTwoSeconds",
    )}, ensure_ascii=False), flush=True)
    return 0 if index > 0 and declared_frames == index else 1


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Uso: audit-video-frames.py VIDEO.mp4 OUTPUT_DIR")
    raise SystemExit(main(Path(sys.argv[1]), Path(sys.argv[2])))
