"""Extract exact decoded frame numbers from an E2E MP4 for manual review."""

from __future__ import annotations

import sys
from pathlib import Path

import cv2


def main(video: Path, output: Path, indices: list[int]) -> None:
    output.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"No se pudo abrir {video}")
    fps = capture.get(cv2.CAP_PROP_FPS)
    for index in sorted(set(indices)):
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        success, frame = capture.read()
        if not success:
            raise RuntimeError(f"No se pudo decodificar el frame {index}")
        path = output / f"frame-{index:06d}-{index / fps:.3f}s.png"
        cv2.imwrite(str(path), frame)
        print(path)
    capture.release()


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit("Uso: extract-video-frames.py VIDEO.mp4 OUTPUT_DIR FRAME [...]")
    main(Path(sys.argv[1]), Path(sys.argv[2]), [int(value) for value in sys.argv[3:]])
