"""Genera una imagen sintética de una placa de VIN para probar el OCR.

    python tools/make-test-image.py
"""
from __future__ import annotations

import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "_qa-vin.jpg"

VIN = "1HGBH41JXMN109186"
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\calibrib.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def main() -> None:
    random.seed(7)
    np.random.seed(7)

    width, height = 1280, 460
    plate = Image.new("RGB", (width, height), (34, 36, 38))
    draw = ImageDraw.Draw(plate)

    # Marco de la placa
    draw.rounded_rectangle([18, 18, width - 18, height - 18], radius=18, outline=(120, 124, 128), width=3)

    # Texto del VIN con espaciado
    font = load_font(92)
    char_w = 62
    total = char_w * len(VIN)
    x0 = (width - total) // 2
    y0 = height // 2 - 52

    for i, ch in enumerate(VIN):
        draw.text((x0 + i * char_w + 6, y0), ch, font=font, fill=(236, 238, 240))

    # Etiqueta superior
    small = load_font(26)
    draw.text((44, 44), "VEHICLE IDENTIFICATION NUMBER", font=small, fill=(150, 154, 158))

    # Ensuciar un poco: ruido, desenfoque suave y giro leve
    arr = np.asarray(plate).astype(np.int16)
    noise = np.random.normal(0, 9, arr.shape[:2])[..., None]
    arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
    plate = Image.fromarray(arr)
    plate = plate.filter(ImageFilter.GaussianBlur(0.6))
    plate = plate.rotate(1.2, resample=Image.BICUBIC, expand=False, fillcolor=(34, 36, 38))

    plate.save(OUT, "JPEG", quality=86)
    print(f"Imagen de prueba: {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
