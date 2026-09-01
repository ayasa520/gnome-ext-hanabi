# Bug report: gjs GC sweeps drop frame/destroy callbacks → wallpaper freeze and GNOME Shell teardown hang

**Project**: vivid-consumer-gnome GNOME Shell extension + Vivid producer (Flatpak `io.github.ayasa520.Vivid` 1.0.0, commit 1c98737c)
**Extension URL**: https://github.com/waywallen/waywallen-display
**Environment**: Ubuntu 24.04, GNOME Shell 46 (X11 / gdm-x-session), gjs 1.80.2, dual monitor (eDP-1 2560x1600 + HDMI-1 1920x1080), NVIDIA dGPU + Intel iGPU

Attached patches:

- `vivid-helper-gc-pacing.patch` — fix for the helper process (`shell/helper/display-helper.js`)
- `vivid-shell-shutdown-destroy.patch` — fix for the shell-side code (`shell/integration/gnomeShellOverride.js`)

---

## 1. Symptoms

### 1a. Wallpaper freezes mid-session (helper side)

After the helper has been running for several minutes, the wallpaper image
freezes while the rest of the desktop stays responsive. Once it starts it does
not recover; only an extension disable/enable cycle helps, and it recurs a few
minutes later.

Logs, appearing together at a rate of several per second, continuously:

```
gnome-shell[...]: Vivid Consumer: (displayHelper) [helper] (gjs:PID): Gjs-CRITICAL **:
    Attempting to call back into JSAPI during the sweeping phase of GC.
    ... Because it would crash the application, it has been blocked and the JS callback not invoked.
    (variant: "Attempting to run a JS callback during garbage collection")

vivid-producer[...]: VividProducer: release reaper wait output=N ... timed out/error after 500ms
    ... force-signaling to avoid producer-side release deadlock
vivid-producer[...]: VividSceneProducer: release gate timed out for offscreen slot=N timeout-ms=600; skipping scene frame
```

Measured on a live system: 2148 Gjs-CRITICAL lines and 2084 release-reaper
timeouts within 17 minutes, starting ~7 minutes after helper start.

### 1b. GNOME Shell hangs during logout/shutdown (shell side)

At session logout the screen freezes and no input is accepted. Journal shows a
burst of 69 sweep warnings inside the **gnome-shell process itself**, ~1
second after "Shutting down GNOME Shell", with gjs 1.80's "offending signal"
lines naming this extension's actor:

```
gnome-shell[PID]: Attempting to call back into JSAPI during the sweeping phase of GC. ...
    The offending signal was destroy on VividWallpaperLiveWallpaper 0x...  (same address repeated)
    The offending signal was destroy on MetaBackgroundActor 0x...
    The offending signal was destroy on StWidget 0x...  (same address repeated 15+ times)
```

---

## 2. Root cause

gjs checks `JS::RuntimeHeapIsCollecting()` every time it marshals a GObject
signal or runs a GSource callback (gi/value.cpp, `Gjs::Closure::marshal()`).
While SpiderMonkey has a (incremental) GC cycle in flight — a window that can
last seconds — **every JS callback is dropped** with the CRITICAL above. Two
places in the extension are fatally affected:

### 2a. Helper: dropped `frame` callback wedges the producer's buffer queue

The native `Receiver` consumes the frame from the socket **before** emitting
its `frame` signal. The JS handler (`_handleFrameReady` → `OutputWindow.showFrame`
→ `paintable.show_frame_with_sync()`) is what hands the acquire/release fds to
the native Vulkan relay, which later signals the release syncobj.

If the `frame` signal is marshaled during a GC sweep, the callback is dropped:
the frame is already consumed, `show_frame_with_sync()` never runs, the
release syncobj is never signaled, and the producer's buffer queue wedges —
exactly the producer-side "release reaper ... force-signaling" / "skipping
scene frame" storm, one pair per frame.

(Same mechanism can drop the `write_all_async` completion callback, leaving
`_writePending` stuck `true` and the outbound channel half-dead, which is why
only a restart recovered.)

GC pressure comes from normal operation: at 60 fps the helper continuously
creates garbage (GBytes/UnixFDList wrappers, decode objects, audio sample
arrays, MPRIS polling). A few minutes in, heap growth crosses SpiderMonkey's
incremental-GC trigger and the drop window opens. Restarting resets the heap
— hence "fixed by restart, recurs minutes later".

### 2b. Shell side: wallpaper actors reach the final GC sweep with JS destroy handlers

GNOME Shell **never calls extension `disable()` during session shutdown**
(`ExtensionSystem`'s own `global.connect('shutdown')` handler only removes its
crash-recovery flag file). The `LiveWallpaper` actors
(GTypeName `VividWallpaperLiveWallpaper`, `shell/ui/wallpaper.js`) therefore
stay alive, JS `destroy` handlers still connected, until the gjs context is
torn down. The final GC sweep fires their destroy signals, gjs blocks them,
and the same object is retried on every further sweep — stalling Shell's own
teardown (the frozen, input-dead screen at logout).

A second, related leak: if `new Wallpaper.LiveWallpaper(...)` throws (e.g. a
monitor-layout race in the constructor), the exception escapes into Shell's
`BackgroundManager._updateBackgroundActor()` while the vanilla background
actor was already added to its container — an untracked actor only the GC can
reclaim.

---

## 3. Fixes

### Patch 1: `vivid-helper-gc-pacing.patch` (helper)

1. **GC pacing (main fix).** Fire `system.gc()` once per second from a normal
   `GLib.timeout_add` callback. Full GCs are sub-millisecond on this helper's
   tiny live heap, and running them from a main-context safe point keeps the
   heap permanently below SpiderMonkey's incremental-GC trigger — so no GC
   cycle is ever in flight when a frame signal is marshaled. Prevention, not
   retry.
2. **Receiver teardown on connect failure.** If `_startReceiver()` threw after
   connecting its JS signals, the receiver was abandoned to the GC with live
   JS closures — the exact "finalized with signals connected during sweep"
   scenario. Extract `_teardownReceiver()` and call it from the
   `connect_async` error path.

### Patch 2: `vivid-shell-shutdown-destroy.patch` (shell side)

1. Connect `global`'s `shutdown` signal in `enable()` (the same public signal
   Shell itself uses) and **explicitly destroy all wallpaper actors** before
   the gjs context teardown, so they never enter the final GC sweep.
   Disconnect the handler in `disable()`.
2. Wrap the `LiveWallpaper` construction in try/catch; on failure log and
   return the vanilla background actor (wallpaper degrades to static) instead
   of leaking a half-initialized actor into Shell's bookkeeping.

Note: deliberately **no** GC pacing on the shell side — running `system.gc()`
inside the gnome-shell process would affect the whole desktop; fixing the
object lifecycle is the right scope there.

---

## 4. Verification

- Helper patch: before, thousands of Gjs-CRITICAL/release-reaper pairs per
  minute starting ~7 min after start. After: **zero** over 14.5 minutes of
  continuous monitoring, helper RSS stable at ~265 MB (was climbing past
  350 MB); over the following ~4 hours only ~14 isolated, self-recovered
  producer reaper events (its force-signal path covers these).
- Shell-side patch: loaded via extension disable/enable (Shell 46 reloads
  extension code); clean startup, wallpaper functional on both monitors. The
  shutdown path itself has not been re-exercised yet — it only triggers at
  logout — but the actors are now destroyed on `shutdown` before the sweep
  that previously stalled.
- Both files pass a full tree-sitter-javascript parse with no error nodes.

---

## 5. Suggestions for a proper upstream fix

- The native receiver ideally should not consume a frame from the socket
  before the JS side has accepted it (or should signal the release fence
  natively), so a dropped JS callback can never wedge the buffer queue.
- A defensive watchdog on the outbound channel (reset `_writePending` if the
  queue is non-empty and no completion has fired for N seconds) would make the
  helper self-healing even if a callback is ever dropped for other reasons.
- GNOME Shell's own `WorkspaceBackground`/`MetaBackgroundActor` and some
  third-party extensions (e.g. blur-my-shell widgets) exhibit the same
  shutdown-sweep warnings; they are outside this extension's scope but may be
  worth mentioning in the README for users combining extensions.
