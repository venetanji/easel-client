# App icon

The icon uses the user-selected outline easel mark (option A) from `build/icon.svg`.
The green mark sits on a cream tile with transparent rounded corners so it remains
visible on desktop backgrounds.

Generated platform assets are committed so packaging needs no image-processing dependency.
To regenerate them, install the repository's Node dependencies and Pillow, then run:

```sh
python scripts/build-app-icons.py
```

The script renders the SVG with the installed Electron version, then produces PNG,
ICO, ICNS, and Linux sizes. An optional source argument accepts another SVG or a
raster image. This development step does not run during release packaging.

The app header uses an inline SVG easel mark in `src/index.html`, matching the
toolbar's 20-unit grid, 1.5-unit stroke, rounded ends, and current text color.
