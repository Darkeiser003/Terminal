"""Create an indexed overview of the E2E screenshots for visual triage."""

from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def main(directory: Path, output: Path) -> None:
    screenshots = sorted(
        (path for path in directory.glob("*.png") if re.match(r"^\d{2,3}-", path.name)),
        key=lambda path: int(path.name.split("-", 1)[0]),
    )
    if not screenshots:
        raise RuntimeError(f"No hay capturas numeradas en {directory}")
    columns, thumb_width, thumb_height, label_height, margin = 4, 400, 260, 36, 12
    rows = (len(screenshots) + columns - 1) // columns
    sheet = Image.new(
        "RGB",
        (columns * (thumb_width + margin) + margin,
         rows * (thumb_height + label_height + margin) + margin),
        "#24272b",
    )
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(screenshots):
        image = Image.open(path).convert("RGB")
        image.thumbnail((thumb_width, thumb_height), Image.Resampling.LANCZOS)
        x = margin + index % columns * (thumb_width + margin)
        y = margin + index // columns * (thumb_height + label_height + margin)
        sheet.paste(image, (x, y))
        draw.text((x, y + thumb_height + 4), path.stem[:53], fill="#f3f3f3")
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output)
    print(f"{len(screenshots)} capturas: {output}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Uso: create-e2e-contact-sheet.py CAPTURE_DIR OUTPUT.png")
    main(Path(sys.argv[1]), Path(sys.argv[2]))
