from pathlib import Path
import subprocess
import sys

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else BUILD / "icon.svg"

if SOURCE.suffix.lower() == ".svg":
    raster_source = BUILD / "icon.png"
    subprocess.run(["node", str(ROOT / "scripts" / "render-app-icon.cjs"), str(SOURCE), str(raster_source)], check=True)
else:
    raster_source = SOURCE

with Image.open(raster_source) as image:
    artwork = ImageOps.contain(image.convert("RGBA"), (1024, 1024), Image.Resampling.LANCZOS)

icon = Image.new("RGBA", (1024, 1024))
icon.alpha_composite(artwork, ((1024 - artwork.width) // 2, (1024 - artwork.height) // 2))
BUILD.mkdir(parents=True, exist_ok=True)
icon.save(BUILD / "icon.png", optimize=True)
icon.save(BUILD / "icon.ico", sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
icon.save(BUILD / "icon.icns")

linux = BUILD / "icons"
linux.mkdir(exist_ok=True)
for size in (16, 24, 32, 48, 64, 128, 256, 512):
    icon.resize((size, size), Image.Resampling.LANCZOS).save(linux / f"{size}x{size}.png", optimize=True)

print("Created PNG, ICO, ICNS, and Linux icon sizes from " + str(SOURCE))
