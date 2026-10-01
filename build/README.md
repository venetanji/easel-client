# App icon

The icon uses the user-selected Easel media image `31ccc6a9ab774b33b801f0e7d65dcc66`.
Its transparent background and full easel silhouette are preserved.

Generated platform assets are committed so packaging needs no image-processing dependency.
To regenerate them, install Pillow and run:

```sh
python scripts/build-app-icons.py path/to/source.png
```

Omit the source argument to use the checked-in `build/icon.png`.
