# `gstcefsrc` Small-Scale Evaluation

This note records a minimal visible test for rendering a Hanabi-style web wallpaper through `gstcefsrc` instead of the current `WPEWebKit + Gtk.GraphicsOffload` path.

## Goal

Verify whether the test page below can render smoothly with low CPU usage and without flicker:

```text
http://127.0.0.1:8000/test.html
```

## Result

With `gstcefsrc + CEF`, the page was:

- smooth
- low CPU
- not flickering

This makes it a strong candidate for further investigation as an alternative web rendering backend.

## Test Setup

Repository:

```text
/home/rikka/Projects/gstcefsrc
```

Local CEF package used directly, without downloading:

```text
/home/rikka/Downloads/cef_binary_139.0.28+g55ab8a8+chromium-139.0.7258.139_linux64.tar.bz2
```

Build output:

```text
/home/rikka/Projects/gstcefsrc/build/Release
```

## Build Notes

`gstcefsrc` expects the extracted CEF tree at:

```text
/home/rikka/Projects/gstcefsrc/third_party/cef/cef_binary_139.0.28+g55ab8a8+chromium-139.0.7258.139_linux64
```

After placing the local tarball there and extracting it, the project was configured and built normally with CMake.

## Minimal Visible Test

This was the working visible command:

```bash
GST_PLUGIN_PATH=/home/rikka/Projects/gstcefsrc/build/Release \
GST_CEF_SUBPROCESS_PATH=/home/rikka/Projects/gstcefsrc/build/Release/gstcefsubprocess \
GST_CEF_CACHE_LOCATION=/tmp/gstcef-cache \
GST_CEF_SANDBOX=0 \
GST_CEF_GPU_ENABLED=set \
GST_CEF_CHROME_EXTRA_FLAGS='use-angle=default,ignore-gpu-blocklist,enable-gpu-rasterization,enable-logging=stderr' \
gst-launch-1.0 -e \
  cefbin name=cef cefsrc::url='http://127.0.0.1:8000/test.html' \
  cef.video ! video/x-raw,width=1920,height=1080,framerate=60/1 ! queue ! videoconvert ! autovideosink
```

## Important Pitfall

The first attempt forced:

```text
use-gl=egl
```

That was wrong for this CEF build and caused GPU initialization failure, software fallback, and extremely high CPU usage.

The key errors were:

- `Requested GL implementation ... not found`
- `Exiting GPU process due to errors during initialization`
- `GPU stall due to ReadPixels`

Switching to:

```text
use-angle=default
```

removed the GPU initialization failure and produced the good result above.

## Page-Side Warnings Seen During Test

These messages still appeared in the page console during the successful run:

- `Not allowed to load local resource: file:///[object Object]`
- `NotSupportedError: Failed to load because no supported source was found.`
- a CORS failure for `https://i.tianqi.com/index.php?c=code&id=11`

Even with those warnings, the visible rendering result was still smooth and stable.

## Comparison With Current WPE Test

For this page, the observed behavior was:

- `WPEWebKit + Gtk.GraphicsOffload`: low CPU, but flickering
- `WPEWebKit` without offload: stable, but CPU rises sharply
- `gstcefsrc + CEF`: smooth, low CPU, and no flicker

## Next Step

If this path is pursued further, the next useful step is to wrap the command above into a dedicated Hanabi-side test launcher or an experimental backend entrypoint, then repeat the same comparison under longer-running wallpaper conditions.
