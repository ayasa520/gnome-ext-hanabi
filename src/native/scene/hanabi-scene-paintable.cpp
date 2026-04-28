#include "hanabi-scene-paintable.h"

#include <gio/gio.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <drm/drm_fourcc.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "hanabi-scene-dmabuf-texture.h"
#include "hanabi-scene-project.hpp"

#include "SceneWallpaper.hpp"
#include "SceneWallpaperSurface.hpp"
#include "Scene/include/Scene/SceneShader.h"
#include "Type.hpp"
#include "Utils/Platform.hpp"

using hanabi::scene::SceneProject;
using hanabi::scene::configure_scene_wallpaper;
using hanabi::scene::ensure_scene_wallpaper;
using hanabi::scene::sync_scene_user_properties;
using hanabi::scene::to_wallpaper_fill_mode;

namespace {

constexpr const char* CACHE_DIR_NAME = "hanabi-scene";
constexpr guint32     DEFAULT_DMABUF_FOURCC = DRM_FORMAT_ABGR8888;

enum {
    PROP_0,
    PROP_PROJECT_DIR,
    PROP_USER_PROPERTIES_JSON,
    PROP_MUTED,
    PROP_VOLUME,
    PROP_FILL_MODE,
    PROP_FPS,
    PROP_RENDER_SCALE,
    PROP_PLAYING,
    PROP_READY,
    N_PROPS,
};

const char* bool_to_string(bool value) { return value ? "true" : "false"; }

// Geometry logs compare several independently produced aspect ratios. Keeping the helper tolerant of
// zero-sized allocations prevents diagnostic logging from masking the original render path problem.
double safe_aspect_ratio(double width, double height) {
    return height > 0.0 ? width / height : 0.0;
}

struct PaintableTextureEntry {
    GdkTexture* texture { nullptr };
    uint64_t generation { 0 };
};

class PaintableRedrawBridge : public std::enable_shared_from_this<PaintableRedrawBridge> {
public:
    explicit PaintableRedrawBridge(GObject* paintable) {
        g_weak_ref_init(&paintable_, paintable);
    }

    PaintableRedrawBridge(const PaintableRedrawBridge&) = delete;
    PaintableRedrawBridge& operator=(const PaintableRedrawBridge&) = delete;

    ~PaintableRedrawBridge() {
        g_weak_ref_clear(&paintable_);
    }

    void invalidate() {
        active_.store(false, std::memory_order_release);
    }

    void request_redraw() {
        if (!active_.load(std::memory_order_acquire))
            return;

        gpointer paintable = g_weak_ref_get(&paintable_);
        if (!paintable)
            return;
        auto* object = G_OBJECT(paintable);

        auto* request = new PaintableRedrawRequest { object, shared_from_this() };

        // The renderer thread can outlive the paintable while SceneWallpaper is
        // tearing down. Taking the strong reference from the weak ref before
        // entering GTK's main context makes the queued invalidation own a valid
        // GObject instead of racing a raw HanabiScenePaintable pointer. Keeping
        // the bridge in the request also lets the main-thread task observe a
        // dispose-time invalidation that happened after the request was queued.
        g_main_context_invoke(
            nullptr,
            +[] (gpointer data) -> gboolean {
                std::unique_ptr<PaintableRedrawRequest> request(
                    static_cast<PaintableRedrawRequest*>(data));
                if (request->bridge->active_.load(std::memory_order_acquire))
                    gdk_paintable_invalidate_contents(GDK_PAINTABLE(request->paintable));
                g_object_unref(request->paintable);
                return G_SOURCE_REMOVE;
            },
            request);
    }

private:
    struct PaintableRedrawRequest {
        GObject* paintable;
        std::shared_ptr<PaintableRedrawBridge> bridge;
    };

    GWeakRef paintable_ {};
    std::atomic<bool> active_ { true };
};

std::vector<uint64_t> collect_dmabuf_modifiers(GdkDisplay* display, guint32 fourcc) {
#if GTK_CHECK_VERSION(4, 14, 0)
    if (!display)
        return {};

    GdkDmabufFormats* formats = gdk_display_get_dmabuf_formats(display);
    if (!formats)
        return {};

    std::vector<uint64_t> modifiers;
    const gsize n_formats = gdk_dmabuf_formats_get_n_formats(formats);
    modifiers.reserve(n_formats);
    for (gsize i = 0; i < n_formats; i++) {
        guint32 format_fourcc = 0;
        guint64 modifier = 0;
        gdk_dmabuf_formats_get_format(formats, i, &format_fourcc, &modifier);
        if (format_fourcc != fourcc)
            continue;

        if (std::find(modifiers.begin(), modifiers.end(), modifier) == modifiers.end())
            modifiers.push_back(modifier);
    }

    return modifiers;
#else
    static_cast<void>(display);
    static_cast<void>(fourcc);
    return {};
#endif
}

} // namespace

struct _HanabiScenePaintable {
    GObject parent_instance;

    gchar* project_dir;
    gchar* user_properties_json;
    gchar* media_state_json;
    GVariant* audio_samples;
    gboolean muted;
    gdouble volume;
    gint fill_mode;
    gint fps;
    gboolean playing;

    bool scene_ready;
    bool render_ready;

    gint render_width;
    gint render_height;
    gint intrinsic_width;
    gint intrinsic_height;
    gdouble render_scale;

    GdkTexture* current_texture;
    uint64_t current_texture_generation;
    GdkDisplay* display;
    gboolean logged_display_acquired;
    gboolean logged_waiting_for_frame;
    gboolean logged_no_texture;
    int32_t last_logged_frame_id;
    gboolean last_logged_frame_from_cache;
    gboolean logged_snapshot_geometry;

    std::unique_ptr<wallpaper::SceneWallpaper> scene;
    SceneProject project;
    std::shared_ptr<PaintableRedrawBridge> redraw_bridge;
    std::unordered_map<int32_t, PaintableTextureEntry> textures;
    uint64_t project_generation { 1 };
    uint64_t imported_texture_count { 0 };
};

static GParamSpec* properties[N_PROPS] = {};

static gboolean hanabi_scene_paintable_is_ready(HanabiScenePaintable* self);

void clear_cached_textures(HanabiScenePaintable* self) {
    const gboolean was_ready = hanabi_scene_paintable_is_ready(self);
    if (!self->textures.empty())
        g_message("HanabiScene: clearing %zu cached dma-buf textures", self->textures.size());

    for (auto& [_, entry] : self->textures)
        g_clear_object(&entry.texture);

    self->textures.clear();
    self->current_texture = nullptr;
    self->current_texture_generation = 0;
    self->imported_texture_count = 0;
    self->logged_waiting_for_frame = FALSE;
    self->logged_no_texture = FALSE;
    self->last_logged_frame_id = -1;
    self->last_logged_frame_from_cache = FALSE;
    self->logged_snapshot_geometry = FALSE;
    if (was_ready)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_READY]);
}

void prune_stale_cached_textures(HanabiScenePaintable* self) {
    for (auto iter = self->textures.begin(); iter != self->textures.end();) {
        if (iter->second.generation == self->project_generation) {
            ++iter;
            continue;
        }

        // A project switch keeps the old texture visible until a new frame arrives,
        // but once the current generation has produced a frame any cached frame from
        // an older source is dead weight and can also collide with fresh frame ids.
        g_clear_object(&iter->second.texture);
        iter = self->textures.erase(iter);
    }
}

G_DEFINE_TYPE_WITH_CODE(HanabiScenePaintable,
                        hanabi_scene_paintable,
                        G_TYPE_OBJECT,
                        G_IMPLEMENT_INTERFACE(
                            GDK_TYPE_PAINTABLE,
                            +[] (GdkPaintableInterface* iface) {
                                iface->snapshot = +[] (GdkPaintable* paintable,
                                                       GdkSnapshot*  snapshot,
                                                       double        width,
                                                       double        height) {
                                    auto* self = HANABI_SCENE_PAINTABLE(paintable);

                                    const double render_scale = MAX(1.0, self->render_scale);
                                    const int target_width =
                                        MAX(1, static_cast<int>(std::ceil(width * render_scale)));
                                    const int target_height =
                                        MAX(1, static_cast<int>(std::ceil(height * render_scale)));

                                    if (self->render_ready &&
                                        (self->render_width != target_width ||
                                         self->render_height != target_height)) {
                                        g_message("HanabiScene: render size changed %dx%d -> %dx%d, recreating scene",
                                                  self->render_width,
                                                  self->render_height,
                                                  target_width,
                                                  target_height);
                                        self->scene.reset();
                                        self->scene_ready = false;
                                        self->render_ready = false;
                                        self->render_width = 0;
                                        self->render_height = 0;
                                        clear_cached_textures(self);
                                    }

                                    if (!self->scene_ready && !self->project.scene_path.empty()) {
                                        if (ensure_scene_wallpaper(self->scene,
                                                                   CACHE_DIR_NAME,
                                                                   "paintable",
                                                                   self->project)) {
                                            configure_scene_wallpaper(*self->scene,
                                                                      self->project,
                                                                      self->volume,
                                                                      self->muted,
                                                                      self->fill_mode,
                                                                      self->fps);
                                            hanabi::scene::sync_scene_media_state(
                                                *self->scene,
                                                hanabi::scene::build_scene_media_state_from_json(
                                                    self->media_state_json,
                                                    "paintable"));
                                            hanabi::scene::sync_scene_audio_samples(
                                                *self->scene,
                                                hanabi::scene::build_scene_audio_samples_from_variant(
                                                    self->audio_samples,
                                                    "paintable"));
                                            self->scene_ready = true;
                                            g_message(
                                                "HanabiScene: scene configured source=%s assets=%s muted=%s volume=%.3f fill-mode=%d fps=%d",
                                                self->project.scene_path.c_str(),
                                                self->project.assets_path.c_str(),
                                                bool_to_string(self->muted),
                                                self->volume,
                                                self->fill_mode,
                                                self->fps);
                                        }
                                    }

                                    if (!self->display) {
                                        auto* display = gdk_display_get_default();
                                        if (display) {
                                            self->display = GDK_DISPLAY(g_object_ref(display));
                                            if (!self->logged_display_acquired) {
                                                g_message("HanabiScene: acquired default GdkDisplay for dma-buf import");
                                                self->logged_display_acquired = TRUE;
                                            }
                                        }
                                    }

                                    if (!self->render_ready && self->scene_ready &&
                                        target_width > 0 && target_height > 0) {
                                        const auto dmabuf_modifiers =
                                            collect_dmabuf_modifiers(self->display, DEFAULT_DMABUF_FOURCC);
                                        g_message(
                                            "HanabiScene: initVulkan offscreen render %dx%d fourcc=0x%x modifiers=%zu playing=%s",
                                            target_width,
                                            target_height,
                                            DEFAULT_DMABUF_FOURCC,
                                            dmabuf_modifiers.size(),
                                            bool_to_string(self->playing));
                                        wallpaper::RenderInitInfo info {};
                                        info.offscreen = true;
                                        info.export_mode = wallpaper::ExternalFrameExportMode::DMA_BUF;
                                        info.offscreen_tiling = wallpaper::TexTiling::LINEAR;
                                        info.export_drm_fourcc = DEFAULT_DMABUF_FOURCC;
                                        info.export_drm_modifiers = dmabuf_modifiers;
                                        info.width = static_cast<uint16_t>(target_width);
                                        info.height = static_cast<uint16_t>(target_height);
                                        info.render_scale = render_scale;
                                        info.redraw_callback = [bridge = self->redraw_bridge]() {
                                            if (bridge)
                                                bridge->request_redraw();
                                        };
                                        self->scene->initVulkan(info);
                                        self->render_width = target_width;
                                        self->render_height = target_height;
                                        self->render_ready = true;
                                        g_message("HanabiScene: render path ready width=%d height=%d",
                                                  self->render_width,
                                                  self->render_height);
                                        if (self->playing)
                                            self->scene->play();
                                        else
                                            self->scene->pause();
                                    }

                                    if (self->scene && self->scene->exSwapchain()) {
                                        auto* handle = self->scene->exSwapchain()->eatFrame();

                                        if (handle) {
                                            const gboolean was_ready =
                                                hanabi_scene_paintable_is_ready(self);
                                            self->logged_waiting_for_frame = FALSE;
                                            const auto cached = self->textures.find(handle->id());
                                            if (cached != self->textures.end() &&
                                                cached->second.generation == self->project_generation) {
                                                self->current_texture = cached->second.texture;
                                                self->current_texture_generation = cached->second.generation;
                                                self->last_logged_frame_id = handle->id();
                                                self->last_logged_frame_from_cache = TRUE;
                                            } else if (hanabi_scene_dmabuf_frame_can_build_texture(*handle) &&
                                                       self->display) {
                                                g_autoptr(GError) error = nullptr;
                                                auto* next_texture =
                                                    hanabi_scene_dmabuf_texture_new_from_frame(
                                                        *handle, self->display, nullptr, &error);
                                                if (next_texture) {
                                                    const int next_width =
                                                        gdk_texture_get_width(next_texture);
                                                    const int next_height =
                                                        gdk_texture_get_height(next_texture);
                                                    const bool size_changed =
                                                        next_width != self->intrinsic_width ||
                                                        next_height != self->intrinsic_height;

                                                    // The reusable SceneWallpaper can restart frame ids for
                                                    // each source. Replace any stale entry only after the new
                                                    // dma-buf has imported successfully so a failed import keeps
                                                    // the old transition texture alive for the user.
                                                    if (cached != self->textures.end()) {
                                                        g_clear_object(&cached->second.texture);
                                                        self->textures.erase(cached);
                                                    }
                                                    self->textures.emplace(
                                                        handle->id(),
                                                        PaintableTextureEntry {
                                                            .texture = next_texture,
                                                            .generation = self->project_generation,
                                                        });
                                                    self->current_texture = next_texture;
                                                    self->current_texture_generation = self->project_generation;
                                                    self->imported_texture_count++;
                                                    self->intrinsic_width = next_width;
                                                    self->intrinsic_height = next_height;
                                                    g_message(
                                                        "HanabiScene: imported dma-buf frame id=%d size=%dx%d total-imported=%" G_GUINT64_FORMAT " cached-textures=%zu",
                                                        handle->id(),
                                                        next_width,
                                                        next_height,
                                                        self->imported_texture_count,
                                                        self->textures.size());
                                                    self->last_logged_frame_id = handle->id();
                                                    self->last_logged_frame_from_cache = FALSE;
                                                    if (size_changed) {
                                                        // A new imported texture extent changes the final GTK
                                                        // scaling relationship, so let the next snapshot print
                                                        // the full geometry again instead of hiding the evidence
                                                        // behind the previous one-shot diagnostic.
                                                        self->logged_snapshot_geometry = FALSE;
                                                        gdk_paintable_invalidate_size(paintable);
                                                    }
                                                    prune_stale_cached_textures(self);
                                                } else if (error) {
                                                    g_warning(
                                                        "HanabiScene: failed to build dma-buf texture: %s",
                                                        error->message);
                                                }
                                            } else {
                                                g_message(
                                                    "HanabiScene: frame id=%d cannot use dma-buf import path is-dmabuf=%s size=%dx%d fourcc=0x%x modifier=%" G_GUINT64_FORMAT " planes=%u display=%s",
                                                    handle->id(),
                                                    bool_to_string(handle->isDmabuf()),
                                                    handle->width,
                                                    handle->height,
                                                    handle->drm_fourcc,
                                                    handle->drm_modifier,
                                                    handle->n_planes,
                                                    bool_to_string(self->display != nullptr));
                                                self->last_logged_frame_id = handle->id();
                                                self->last_logged_frame_from_cache = FALSE;
                                            }

                                            if (!was_ready && hanabi_scene_paintable_is_ready(self))
                                                g_object_notify_by_pspec(
                                                    G_OBJECT(self),
                                                    properties[PROP_READY]);
                                        } else if (!self->logged_waiting_for_frame) {
                                            g_message("HanabiScene: swapchain has no frame available yet");
                                            self->logged_waiting_for_frame = TRUE;
                                        }
                                    }

                                    if (!self->current_texture) {
                                        if (!self->logged_no_texture) {
                                            g_message("HanabiScene: snapshot skipped because no texture is available");
                                            self->logged_no_texture = TRUE;
                                        }
                                        return;
                                    }

                                    self->logged_no_texture = FALSE;

                                    graphene_rect_t bounds;
                                    graphene_rect_init(&bounds,
                                                       0.0f,
                                                       0.0f,
                                                       static_cast<float>(width),
                                                       static_cast<float>(height));
                                    if (!self->logged_snapshot_geometry) {
                                        const int texture_width =
                                            gdk_texture_get_width(self->current_texture);
                                        const int texture_height =
                                            gdk_texture_get_height(self->current_texture);
                                        // This log records the presentation hop after Vulkan has already
                                        // produced a dma-buf. If the renderer-side projection is correct but
                                        // this requested GTK snapshot rectangle has a different aspect from
                                        // the imported texture, the visible compression is happening while GTK
                                        // scales the texture into widget coordinates rather than inside the
                                        // Wallpaper Engine scene graph or its genericimage3 composite pass.
                                        g_message(
                                            "HanabiScene: snapshot geometry request=%.3fx%.3f request-aspect=%.6f render-scale=%.3f target=%dx%d target-aspect=%.6f render=%dx%d texture=%dx%d texture-aspect=%.6f intrinsic=%dx%d intrinsic-aspect=%.6f bounds=%.3fx%.3f fill-mode=%d frame-id=%d frame-cache=%s",
                                            width,
                                            height,
                                            safe_aspect_ratio(width, height),
                                            render_scale,
                                            target_width,
                                            target_height,
                                            safe_aspect_ratio(target_width, target_height),
                                            self->render_width,
                                            self->render_height,
                                            texture_width,
                                            texture_height,
                                            safe_aspect_ratio(texture_width, texture_height),
                                            self->intrinsic_width,
                                            self->intrinsic_height,
                                            safe_aspect_ratio(self->intrinsic_width, self->intrinsic_height),
                                            static_cast<double>(bounds.size.width),
                                            static_cast<double>(bounds.size.height),
                                            self->fill_mode,
                                            self->last_logged_frame_id,
                                            bool_to_string(self->last_logged_frame_from_cache));
                                        self->logged_snapshot_geometry = TRUE;
                                    }
                                    gtk_snapshot_append_texture(
                                        GTK_SNAPSHOT(snapshot), self->current_texture, &bounds);
                                };
                                iface->get_current_image = +[] (GdkPaintable* paintable) -> GdkPaintable* {
                                    auto* self = HANABI_SCENE_PAINTABLE(paintable);
                                    if (self->current_texture)
                                        return GDK_PAINTABLE(g_object_ref(self->current_texture));
                                    return gdk_paintable_new_empty(
                                        MAX(1, self->intrinsic_width), MAX(1, self->intrinsic_height));
                                };
                                iface->get_flags = +[] (GdkPaintable*) {
                                    return static_cast<GdkPaintableFlags>(0);
                                };
                                iface->get_intrinsic_width = +[] (GdkPaintable* paintable) {
                                    auto* self = HANABI_SCENE_PAINTABLE(paintable);
                                    return self->intrinsic_width;
                                };
                                iface->get_intrinsic_height = +[] (GdkPaintable* paintable) {
                                    auto* self = HANABI_SCENE_PAINTABLE(paintable);
                                    return self->intrinsic_height;
                                };
                                iface->get_intrinsic_aspect_ratio = +[] (GdkPaintable* paintable) {
                                    auto* self = HANABI_SCENE_PAINTABLE(paintable);
                                    if (self->intrinsic_width <= 0 || self->intrinsic_height <= 0)
                                        return 0.0;
                                    return static_cast<double>(self->intrinsic_width) /
                                        static_cast<double>(self->intrinsic_height);
                                };
                            }))

static gboolean hanabi_scene_paintable_is_ready(HanabiScenePaintable* self) {
    return self->current_texture != nullptr;
}

static void hanabi_scene_paintable_dispose(GObject* object) {
    auto* self = HANABI_SCENE_PAINTABLE(object);
    g_message("HanabiScene: paintable dispose project=%s scene=%s textures=%zu imported=%" G_GUINT64_FORMAT,
              self->project_dir ? self->project_dir : "(null)",
              self->scene ? "true" : "false",
              self->textures.size(),
              self->imported_texture_count);
    if (self->redraw_bridge)
        self->redraw_bridge->invalidate();
    self->scene.reset();
    self->scene_ready = false;
    self->render_ready = false;
    clear_cached_textures(self);
    g_clear_object(&self->display);
    G_OBJECT_CLASS(hanabi_scene_paintable_parent_class)->dispose(object);
}

static void hanabi_scene_paintable_finalize(GObject* object) {
    auto* self = HANABI_SCENE_PAINTABLE(object);
    g_message("HanabiScene: paintable finalize project=%s scene=%s textures=%zu imported=%" G_GUINT64_FORMAT,
              self->project_dir ? self->project_dir : "(null)",
              self->scene ? "true" : "false",
              self->textures.size(),
              self->imported_texture_count);
    self->textures.~unordered_map<int32_t, PaintableTextureEntry>();
    self->redraw_bridge.~shared_ptr<PaintableRedrawBridge>();
    self->scene.~unique_ptr<wallpaper::SceneWallpaper>();
    self->project.~SceneProject();
    g_clear_pointer(&self->project_dir, g_free);
    g_clear_pointer(&self->user_properties_json, g_free);
    g_clear_pointer(&self->media_state_json, g_free);
    g_clear_pointer(&self->audio_samples, g_variant_unref);
    G_OBJECT_CLASS(hanabi_scene_paintable_parent_class)->finalize(object);
}

static void hanabi_scene_paintable_set_property(GObject* object,
                                                guint         prop_id,
                                                const GValue* value,
                                                GParamSpec*   pspec) {
    auto* self = HANABI_SCENE_PAINTABLE(object);
    switch (prop_id) {
    case PROP_PROJECT_DIR:
        hanabi_scene_paintable_set_project_dir(self, g_value_get_string(value));
        break;
    case PROP_USER_PROPERTIES_JSON:
        hanabi_scene_paintable_set_user_properties_json(self, g_value_get_string(value));
        break;
    case PROP_MUTED:
        hanabi_scene_paintable_set_muted(self, g_value_get_boolean(value));
        break;
    case PROP_VOLUME:
        hanabi_scene_paintable_set_volume(self, g_value_get_double(value));
        break;
    case PROP_FILL_MODE:
        hanabi_scene_paintable_set_fill_mode(self, g_value_get_int(value));
        break;
    case PROP_FPS:
        hanabi_scene_paintable_set_fps(self, g_value_get_int(value));
        break;
    case PROP_RENDER_SCALE:
        hanabi_scene_paintable_set_render_scale(self, g_value_get_double(value));
        break;
    case PROP_PLAYING:
        if (g_value_get_boolean(value))
            hanabi_scene_paintable_play(self);
        else
            hanabi_scene_paintable_pause(self);
        break;
    case PROP_READY:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
    }
}

static void hanabi_scene_paintable_get_property(GObject* object,
                                                guint       prop_id,
                                                GValue*     value,
                                                GParamSpec* pspec) {
    auto* self = HANABI_SCENE_PAINTABLE(object);
    switch (prop_id) {
    case PROP_PROJECT_DIR:
        g_value_set_string(value, self->project_dir);
        break;
    case PROP_USER_PROPERTIES_JSON:
        g_value_set_string(value, self->user_properties_json);
        break;
    case PROP_MUTED:
        g_value_set_boolean(value, self->muted);
        break;
    case PROP_VOLUME:
        g_value_set_double(value, self->volume);
        break;
    case PROP_FILL_MODE:
        g_value_set_int(value, self->fill_mode);
        break;
    case PROP_FPS:
        g_value_set_int(value, self->fps);
        break;
    case PROP_RENDER_SCALE:
        g_value_set_double(value, self->render_scale);
        break;
    case PROP_PLAYING:
        g_value_set_boolean(value, self->playing);
        break;
    case PROP_READY:
        g_value_set_boolean(value, hanabi_scene_paintable_is_ready(self));
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
    }
}

static void hanabi_scene_paintable_class_init(HanabiScenePaintableClass* klass) {
    auto* object_class = G_OBJECT_CLASS(klass);
    object_class->dispose = hanabi_scene_paintable_dispose;
    object_class->finalize = hanabi_scene_paintable_finalize;
    object_class->set_property = hanabi_scene_paintable_set_property;
    object_class->get_property = hanabi_scene_paintable_get_property;

    properties[PROP_PROJECT_DIR] =
        g_param_spec_string("project-dir", nullptr, nullptr, nullptr,
                            static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_USER_PROPERTIES_JSON] =
        g_param_spec_string("user-properties-json", nullptr, nullptr, nullptr,
                            static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_MUTED] =
        g_param_spec_boolean("muted", nullptr, nullptr, FALSE,
                             static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_VOLUME] =
        g_param_spec_double("volume", nullptr, nullptr, 0.0, 1.0, 1.0,
                            static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_FILL_MODE] =
        g_param_spec_int("fill-mode", nullptr, nullptr, 0, 2, 2,
                         static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_FPS] =
        g_param_spec_int("fps", nullptr, nullptr, 5, 240, 30,
                         static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_RENDER_SCALE] =
        g_param_spec_double("render-scale", nullptr, nullptr, 1.0, G_MAXDOUBLE, 1.0,
                            static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_PLAYING] =
        g_param_spec_boolean("playing", nullptr, nullptr, TRUE,
                             static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_READY] =
        g_param_spec_boolean("ready", nullptr, nullptr, FALSE,
                             static_cast<GParamFlags>(G_PARAM_READABLE | G_PARAM_EXPLICIT_NOTIFY));

    g_object_class_install_properties(object_class, N_PROPS, properties);
}

static void hanabi_scene_paintable_init(HanabiScenePaintable* self) {
    new (&self->textures) std::unordered_map<int32_t, PaintableTextureEntry>();
    new (&self->scene) std::unique_ptr<wallpaper::SceneWallpaper>();
    new (&self->project) SceneProject();
    new (&self->redraw_bridge) std::shared_ptr<PaintableRedrawBridge>(
        std::make_shared<PaintableRedrawBridge>(G_OBJECT(self)));
    self->volume = 1.0;
    self->fill_mode = 2;
    self->fps = 30;
    self->render_scale = 1.0;
    self->playing = TRUE;
    self->user_properties_json = nullptr;
    self->media_state_json = nullptr;
    self->audio_samples = nullptr;
    self->current_texture_generation = 0;
    self->project_generation = 1;
    self->last_logged_frame_id = -1;
    self->logged_snapshot_geometry = FALSE;
}

HanabiScenePaintable* hanabi_scene_paintable_new(void) {
    return HANABI_SCENE_PAINTABLE(g_object_new(HANABI_SCENE_TYPE_PAINTABLE, nullptr));
}

gboolean hanabi_scene_paintable_is_supported(void) {
#if GTK_CHECK_VERSION(4, 14, 0)
    GdkDisplay* display = gdk_display_get_default();
    if (!display) {
        g_message("HanabiScene: paintable support probe failed because no GdkDisplay is available");
        return FALSE;
    }

    const auto modifiers = collect_dmabuf_modifiers(display, DEFAULT_DMABUF_FOURCC);
    g_message("HanabiScene: paintable support probe fourcc=0x%x modifiers=%zu supported=%s",
              DEFAULT_DMABUF_FOURCC,
              modifiers.size(),
              bool_to_string(!modifiers.empty()));
    return !modifiers.empty();
#else
    g_message("HanabiScene: paintable support probe failed because GTK < 4.14");
    return FALSE;
#endif
}

static gboolean configure_paintable_scene_for_current_project(HanabiScenePaintable* self,
                                                              const char* reason) {
    if (self->project.scene_path.empty())
        return FALSE;

    if (!ensure_scene_wallpaper(self->scene, CACHE_DIR_NAME, "paintable", self->project))
        return FALSE;

    // This mirrors the KDE backend's persistent SceneObject: the native target
    // owns one SceneWallpaper for its lifetime, and a wallpaper switch only sends
    // new project state into that object. The current texture is deliberately left
    // untouched here so GTK can keep presenting the previous frame until the reused
    // renderer imports a frame for the new generation.
    configure_scene_wallpaper(*self->scene,
                              self->project,
                              self->volume,
                              self->muted,
                              self->fill_mode,
                              self->fps);
    hanabi::scene::sync_scene_media_state(
        *self->scene,
        hanabi::scene::build_scene_media_state_from_json(self->media_state_json, "paintable"));
    hanabi::scene::sync_scene_audio_samples(
        *self->scene,
        hanabi::scene::build_scene_audio_samples_from_variant(self->audio_samples, "paintable"));
    self->scene_ready = true;
    if (self->playing)
        self->scene->play();
    else
        self->scene->pause();

    g_message("HanabiScene: paintable reused SceneWallpaper reason=%s generation=%" G_GUINT64_FORMAT " source=%s assets=%s render-ready=%s cached-textures=%zu",
              reason ? reason : "unknown",
              self->project_generation,
              self->project.scene_path.c_str(),
              self->project.assets_path.c_str(),
              bool_to_string(self->render_ready),
              self->textures.size());
    return TRUE;
}

gboolean hanabi_scene_paintable_reload_project(HanabiScenePaintable* self,
                                               const char* project_dir,
                                               const char* user_properties_json) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), FALSE);

    SceneProject project;
    if (!hanabi::scene::load_scene_project_with_overrides(
            project_dir, user_properties_json, project, "paintable")) {
        g_warning("HanabiScene: rejecting paintable project reload because project load failed: %s",
                  project_dir ? project_dir : "(null)");
        return FALSE;
    }

    const bool project_changed =
        self->project.scene_path != project.scene_path ||
        self->project.assets_path != project.assets_path ||
        g_strcmp0(self->project_dir, project_dir) != 0;
    const bool user_properties_changed =
        g_strcmp0(self->user_properties_json, user_properties_json) != 0;

    g_message("HanabiScene: paintable project reload old=%s new=%s project-changed=%s user-properties-changed=%s",
              self->project_dir ? self->project_dir : "(null)",
              project_dir ? project_dir : "(null)",
              bool_to_string(project_changed),
              bool_to_string(user_properties_changed));

    g_free(self->project_dir);
    self->project_dir = g_strdup(project_dir);
    g_free(self->user_properties_json);
    self->user_properties_json = g_strdup(user_properties_json);
    self->project = std::move(project);

    if (project_changed) {
        // Frame ids can restart after the same SceneWallpaper loads another source.
        // Advancing the generation lets the import path ignore old cached textures
        // while still keeping the currently displayed texture as a transition frame.
        self->project_generation++;
        self->logged_snapshot_geometry = FALSE;
    }

    if (self->scene) {
        if (project_changed)
            configure_paintable_scene_for_current_project(self, "project-reload");
        else
            sync_scene_user_properties(*self->scene, self->project);
    }

    if (project_changed)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_PROJECT_DIR]);
    if (user_properties_changed)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_USER_PROPERTIES_JSON]);

    gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
    return TRUE;
}

void hanabi_scene_paintable_set_project_dir(HanabiScenePaintable* self, const char* project_dir) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));

    if (g_strcmp0(self->project_dir, project_dir) == 0)
        return;

    hanabi_scene_paintable_reload_project(self, project_dir, self->user_properties_json);
}

const char* hanabi_scene_paintable_get_project_dir(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), nullptr);
    return self->project_dir;
}

void hanabi_scene_paintable_set_user_properties_json(HanabiScenePaintable* self,
                                                     const char*           user_properties_json) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));

    if (g_strcmp0(self->user_properties_json, user_properties_json) == 0)
        return;

    g_free(self->user_properties_json);
    self->user_properties_json = g_strdup(user_properties_json);
    hanabi::scene::apply_user_property_overrides(self->project, self->user_properties_json, "paintable");
    if (self->scene) {
        // User-property edits on the same project follow KDE's live property model:
        // keep the SceneWallpaper and render path alive, then forward the new map to
        // the currently loaded scene instead of rebuilding the native target.
        sync_scene_user_properties(*self->scene, self->project);
    }

    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_USER_PROPERTIES_JSON]);
    gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
}

const char* hanabi_scene_paintable_get_user_properties_json(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), nullptr);
    return self->user_properties_json;
}

void hanabi_scene_paintable_set_media_state_json(HanabiScenePaintable* self,
                                                 const char*           media_state_json) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));

    if (g_strcmp0(self->media_state_json, media_state_json) == 0)
        return;

    g_free(self->media_state_json);
    self->media_state_json = g_strdup(media_state_json);
    if (self->scene) {
        hanabi::scene::sync_scene_media_state(
            *self->scene,
            hanabi::scene::build_scene_media_state_from_json(self->media_state_json, "paintable"));
    }
    gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
}

void hanabi_scene_paintable_set_audio_samples(HanabiScenePaintable* self, GVariant* audio_samples) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));

    if (self->audio_samples == audio_samples)
        return;
    if (self->audio_samples && audio_samples && g_variant_equal(self->audio_samples, audio_samples))
        return;

    g_clear_pointer(&self->audio_samples, g_variant_unref);
    if (audio_samples)
        self->audio_samples = g_variant_ref_sink(audio_samples);

    if (self->scene) {
        hanabi::scene::sync_scene_audio_samples(
            *self->scene,
            hanabi::scene::build_scene_audio_samples_from_variant(self->audio_samples, "paintable"));
    }
}

void hanabi_scene_paintable_set_muted(HanabiScenePaintable* self, gboolean muted) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));
    const gboolean changed = self->muted != muted;
    self->muted = muted;
    if (self->scene)
        self->scene->setPropertyBool(wallpaper::PROPERTY_MUTED, self->muted);
    if (changed)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_MUTED]);
}

gboolean hanabi_scene_paintable_get_muted(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), FALSE);
    return self->muted;
}

void hanabi_scene_paintable_set_volume(HanabiScenePaintable* self, double volume) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));
    volume = CLAMP(volume, 0.0, 1.0);
    const bool changed = std::abs(self->volume - volume) >= 0.0001;
    self->volume = volume;
    if (self->scene)
        self->scene->setPropertyFloat(wallpaper::PROPERTY_VOLUME, static_cast<float>(self->volume));
    if (changed)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_VOLUME]);
}

double hanabi_scene_paintable_get_volume(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), 1.0);
    return self->volume;
}

void hanabi_scene_paintable_set_fill_mode(HanabiScenePaintable* self, int fill_mode) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));
    fill_mode = CLAMP(fill_mode, 0, 2);
    if (self->fill_mode == fill_mode)
        return;
    self->fill_mode = fill_mode;
    // Force the next snapshot to restate the full presentation geometry after a fit-mode change.
    // The log is intentionally tied to the mode mutation because cover/contain bugs can otherwise
    // look identical in the renderer log while GTK is drawing the same imported texture differently.
    self->logged_snapshot_geometry = FALSE;
    if (self->scene) {
        self->scene->setPropertyInt32(
            wallpaper::PROPERTY_FILLMODE,
            static_cast<int32_t>(to_wallpaper_fill_mode(self->fill_mode)));
    }
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_FILL_MODE]);
}

int hanabi_scene_paintable_get_fill_mode(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), 2);
    return self->fill_mode;
}

void hanabi_scene_paintable_set_fps(HanabiScenePaintable* self, int fps) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));
    fps = CLAMP(fps, 5, 240);
    if (self->fps == fps)
        return;
    self->fps = fps;
    if (self->scene)
        self->scene->setPropertyInt32(wallpaper::PROPERTY_FPS, self->fps);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_FPS]);
}

int hanabi_scene_paintable_get_fps(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), 30);
    return self->fps;
}

void hanabi_scene_paintable_set_render_scale(HanabiScenePaintable* self, double render_scale) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));

    const double effective_scale = MAX(1.0, render_scale);
    if (std::abs(self->render_scale - effective_scale) < 0.0001)
        return;

    self->render_scale = effective_scale;
    // Render scale changes alter the Vulkan target dimensions derived from the same GTK allocation.
    // Re-arming the presentation log makes the next frame show whether the new dma-buf size still
    // matches the widget rectangle by aspect, which is the critical evidence for squeeze/stretch bugs.
    self->logged_snapshot_geometry = FALSE;
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_RENDER_SCALE]);
    gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
}

double hanabi_scene_paintable_get_render_scale(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), 1.0);
    return self->render_scale;
}

void hanabi_scene_paintable_play(HanabiScenePaintable* self) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));
    if (self->playing)
        return;
    self->playing = TRUE;
    if (self->scene)
        self->scene->play();
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_PLAYING]);
    gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
}

void hanabi_scene_paintable_pause(HanabiScenePaintable* self) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));
    if (!self->playing)
        return;
    self->playing = FALSE;
    if (self->scene)
        self->scene->pause();
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_PLAYING]);
}

gboolean hanabi_scene_paintable_get_playing(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), FALSE);
    return self->playing;
}

gboolean hanabi_scene_paintable_get_ready(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), FALSE);
    return hanabi_scene_paintable_is_ready(self);
}

void hanabi_scene_paintable_set_mouse_pos(HanabiScenePaintable* self, double x, double y) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));
    if (!self->scene || self->render_width <= 0 || self->render_height <= 0)
        return;

    const double render_scale = MAX(1.0, self->render_scale);
    const double nx = CLAMP((x * render_scale) / static_cast<double>(self->render_width), 0.0, 1.0);
    const double ny = CLAMP((y * render_scale) / static_cast<double>(self->render_height), 0.0, 1.0);
    self->scene->mouseInput(nx, ny);
}

void hanabi_scene_paintable_set_cursor_left_down(HanabiScenePaintable* self, gboolean down) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));
    if (!self->scene)
        return;

    self->scene->mouseLeftButton(down);
}
