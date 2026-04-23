This directory is for third-party source dependencies used by Hanabi's bundled native backends.

<!-- Documentation note: this file intentionally documents only source trees that Hanabi builds
directly. Runtime-installed shared libraries and typelibs are described in the root README. -->

Current layout:
- `gstcefsrc/`: Chromium Embedded Framework GStreamer source used when the optional `gstcefsrc` web backend is enabled with `-Dgstcefsrc-web-backend=true`.
- `wallpaper-scene-renderer/`: Wallpaper Engine scene renderer source used by `src/native/scene`.

Runtime builds should only ship Hanabi's compiled artifacts, not these source trees.
