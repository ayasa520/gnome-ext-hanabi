#include "hanabi-scene-paintable.h"

#include <gio/gio.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <drm/drm_fourcc.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "hanabi-scene-dmabuf-texture.h"

#include "SceneWallpaper.hpp"
#include "SceneWallpaperSurface.hpp"
#include "Scene/include/Scene/SceneShader.h"
#include "Type.hpp"
#include "Utils/Platform.hpp"

namespace {

constexpr const char* CACHE_DIR_NAME = "hanabi-scene";
constexpr guint32     DEFAULT_DMABUF_FOURCC = DRM_FORMAT_ABGR8888;

enum {
    PROP_0,
    PROP_PROJECT_DIR,
    PROP_MUTED,
    PROP_VOLUME,
    PROP_FILL_MODE,
    PROP_FPS,
    PROP_PLAYING,
    PROP_READY,
    N_PROPS,
};

struct SceneProject {
    std::string project_dir;
    std::string scene_path;
    std::string assets_path;
    wallpaper::ShaderValueMap user_properties;
};

const char* bool_to_string(bool value) { return value ? "true" : "false"; }

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

bool parse_property_default(JsonObject* property, wallpaper::ShaderValue* out_value) {
    if (!json_object_has_member(property, "value"))
        return false;

    JsonNode* value = json_object_get_member(property, "value");
    if (!JSON_NODE_HOLDS_VALUE(value))
        return false;

    GType value_type = json_node_get_value_type(value);
    if (value_type == G_TYPE_BOOLEAN) {
        *out_value = wallpaper::ShaderValue(json_node_get_boolean(value) ? 1.0f : 0.0f);
        return true;
    }

    if (value_type == G_TYPE_DOUBLE || value_type == G_TYPE_INT64) {
        *out_value = wallpaper::ShaderValue(static_cast<float>(json_node_get_double(value)));
        return true;
    }

    if (value_type != G_TYPE_STRING)
        return false;

    const char* string_value = json_node_get_string(value);
    if (!string_value || !*string_value)
        return false;

    std::vector<float> components;
    g_auto(GStrv) parts = g_strsplit_set(string_value, " ,", -1);
    for (gchar** part = parts; part && *part; part++) {
        if (**part == '\0')
            continue;

        char* endptr = nullptr;
        double component = g_ascii_strtod(*part, &endptr);
        if (endptr == *part)
            continue;

        components.push_back(static_cast<float>(component));
    }

    if (components.empty())
        return false;

    *out_value = wallpaper::ShaderValue(components);
    return true;
}

bool read_json_file(const char* path, JsonNode** out_root) {
    g_autoptr(GError) error = nullptr;
    g_autofree gchar* contents = nullptr;
    gsize length = 0;
    if (!g_file_get_contents(path, &contents, &length, &error)) {
        g_warning("HanabiScene: failed to read json file %s: %s",
                  path,
                  error ? error->message : "(unknown error)");
        return false;
    }

    g_autoptr(JsonParser) parser = json_parser_new();
    if (!json_parser_load_from_data(parser, contents, static_cast<gssize>(length), &error)) {
        g_warning("HanabiScene: failed to parse json file %s: %s",
                  path,
                  error ? error->message : "(unknown error)");
        return false;
    }

    *out_root = json_node_copy(json_parser_get_root(parser));
    return true;
}

std::string resolve_regular_file(const std::string& project_dir, const std::string& relative_path) {
    if (relative_path.empty())
        return {};

    auto path = std::filesystem::path(project_dir) / relative_path;
    if (!std::filesystem::is_regular_file(path))
        return {};

    return path.string();
}

std::string resolve_assets_path(const std::string& project_dir) {
    auto dir = std::filesystem::path(project_dir);
    for (auto current = dir; current.has_parent_path(); current = current.parent_path()) {
        auto assets = current / "steamapps" / "common" / "wallpaper_engine" / "assets";
        if (std::filesystem::is_directory(assets))
            return assets.string();

        if (current == current.root_path())
            break;
    }

    return {};
}

bool load_scene_project(const char* project_dir, SceneProject& project) {
    auto manifest_path = std::filesystem::path(project_dir) / "project.json";
    if (!std::filesystem::is_regular_file(manifest_path)) {
        g_warning("HanabiScene: project manifest not found: %s", manifest_path.c_str());
        return false;
    }

    JsonNode* root = nullptr;
    if (!read_json_file(manifest_path.c_str(), &root))
        return false;

    g_autoptr(JsonNode) root_holder = root;
    if (!JSON_NODE_HOLDS_OBJECT(root)) {
        g_warning("HanabiScene: project manifest root is not an object: %s", manifest_path.c_str());
        return false;
    }

    JsonObject* object = json_node_get_object(root);
    const char* type = json_object_has_member(object, "type")
        ? json_object_get_string_member(object, "type")
        : "";
    if (g_ascii_strcasecmp(type, "scene") != 0) {
        g_warning("HanabiScene: unsupported project type '%s' in %s", type, manifest_path.c_str());
        return false;
    }

    std::string file_member = json_object_has_member(object, "file")
        ? json_object_get_string_member(object, "file")
        : "";
    std::string scene_path = resolve_regular_file(project_dir, file_member);
    if (scene_path.empty())
        scene_path = resolve_regular_file(project_dir, "scene.pkg");
    if (scene_path.empty()) {
        g_warning("HanabiScene: failed to resolve scene package under %s", project_dir);
        return false;
    }

    std::string assets_path = resolve_assets_path(project_dir);
    if (assets_path.empty()) {
        g_warning("HanabiScene: failed to resolve Wallpaper Engine assets for %s", project_dir);
        return false;
    }

    if (json_object_has_member(object, "general")) {
        JsonObject* general = json_object_get_object_member(object, "general");
        if (general && json_object_has_member(general, "properties")) {
            JsonObject* properties = json_object_get_object_member(general, "properties");
            if (properties) {
                g_autoptr(GList) members = json_object_get_members(properties);
                for (GList* iter = members; iter; iter = iter->next) {
                    const char* name = static_cast<const char*>(iter->data);
                    JsonObject* property = json_object_get_object_member(properties, name);
                    if (!property)
                        continue;

                    wallpaper::ShaderValue parsed_value;
                    if (parse_property_default(property, &parsed_value))
                        project.user_properties[name] = parsed_value;
                }
            }
        }
    }

    project.project_dir = project_dir;
    project.scene_path = std::move(scene_path);
    project.assets_path = std::move(assets_path);
    g_message("HanabiScene: loaded scene project dir=%s scene=%s assets=%s user-properties=%zu",
              project.project_dir.c_str(),
              project.scene_path.c_str(),
              project.assets_path.c_str(),
              project.user_properties.size());
    return true;
}

wallpaper::FillMode to_wp_fill_mode(int fill_mode) {
    switch (fill_mode) {
    case 0:
        return wallpaper::FillMode::STRETCH;
    case 1:
        return wallpaper::FillMode::ASPECTFIT;
    case 2:
    default:
        return wallpaper::FillMode::ASPECTCROP;
    }
}

} // namespace

struct _HanabiScenePaintable {
    GObject parent_instance;

    gchar* project_dir;
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

    GdkTexture* current_texture;
    GdkDisplay* display;
    gboolean logged_display_acquired;
    gboolean logged_waiting_for_frame;
    gboolean logged_no_texture;
    int32_t last_logged_frame_id;
    gboolean last_logged_frame_from_cache;

    std::unique_ptr<wallpaper::SceneWallpaper> scene;
    SceneProject project;
    std::unordered_map<int32_t, GdkTexture*> textures;
    uint64_t imported_texture_count { 0 };
};

static GParamSpec* properties[N_PROPS] = {};

static gboolean hanabi_scene_paintable_is_ready(HanabiScenePaintable* self);

void clear_cached_textures(HanabiScenePaintable* self) {
    const gboolean was_ready = hanabi_scene_paintable_is_ready(self);
    if (!self->textures.empty())
        g_message("HanabiScene: clearing %zu cached dma-buf textures", self->textures.size());

    for (auto& [_, texture] : self->textures)
        g_clear_object(&texture);

    self->textures.clear();
    self->current_texture = nullptr;
    self->imported_texture_count = 0;
    self->logged_waiting_for_frame = FALSE;
    self->logged_no_texture = FALSE;
    self->last_logged_frame_id = -1;
    self->last_logged_frame_from_cache = FALSE;
    if (was_ready)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_READY]);
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

                                    const int target_width = MAX(1, static_cast<int>(std::ceil(width)));
                                    const int target_height = MAX(1, static_cast<int>(std::ceil(height)));

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
                                        if (!self->scene) {
                                            g_message("HanabiScene: creating SceneWallpaper for %s",
                                                      self->project.scene_path.c_str());
                                            self->scene = std::make_unique<wallpaper::SceneWallpaper>();
                                            if (!self->scene->init()) {
                                                g_warning("HanabiScene: failed to initialize scene wallpaper");
                                                self->scene.reset();
                                            } else {
                                                g_message("HanabiScene: SceneWallpaper initialized successfully");
                                                self->scene->setPropertyString(
                                                    wallpaper::PROPERTY_CACHE_PATH,
                                                    wallpaper::platform::GetCachePath(CACHE_DIR_NAME).string());
                                            }
                                        }

                                        if (self->scene) {
                                            self->scene->setPropertyObject(
                                                wallpaper::PROPERTY_USER_PROPERTIES,
                                                std::make_shared<wallpaper::ShaderValueMap>(self->project.user_properties));
                                            self->scene->setPropertyString(
                                                wallpaper::PROPERTY_ASSETS, self->project.assets_path);
                                            self->scene->setPropertyString(
                                                wallpaper::PROPERTY_SOURCE, self->project.scene_path);
                                            self->scene->setPropertyFloat(
                                                wallpaper::PROPERTY_VOLUME, static_cast<float>(self->volume));
                                            self->scene->setPropertyBool(
                                                wallpaper::PROPERTY_MUTED, self->muted);
                                            self->scene->setPropertyInt32(
                                                wallpaper::PROPERTY_FILLMODE,
                                                static_cast<int32_t>(to_wp_fill_mode(self->fill_mode)));
                                            self->scene->setPropertyInt32(
                                                wallpaper::PROPERTY_FPS, self->fps);
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
                                        info.redraw_callback = [self]() {
                                            g_main_context_invoke(
                                                nullptr,
                                                +[] (gpointer data) -> gboolean {
                                                    auto* self = HANABI_SCENE_PAINTABLE(data);
                                                    gdk_paintable_invalidate_contents(
                                                        GDK_PAINTABLE(self));
                                                    g_object_unref(self);
                                                    return G_SOURCE_REMOVE;
                                                },
                                                g_object_ref(self));
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
                                            if (cached != self->textures.end()) {
                                                self->current_texture = cached->second;
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

                                                    self->textures.emplace(handle->id(), next_texture);
                                                    self->current_texture = next_texture;
                                                    self->imported_texture_count++;
                                                    self->intrinsic_width = next_width;
                                                    self->intrinsic_height = next_height;
                                                    g_message(
                                                        "HanabiScene: imported dma-buf frame id=%d size=%dx%d total-imported=%" G_GUINT64_FORMAT,
                                                        handle->id(),
                                                        next_width,
                                                        next_height,
                                                        self->imported_texture_count);
                                                    self->last_logged_frame_id = handle->id();
                                                    self->last_logged_frame_from_cache = FALSE;
                                                    if (size_changed)
                                                        gdk_paintable_invalidate_size(paintable);
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
    self->scene.reset();
    self->scene_ready = false;
    self->render_ready = false;
    clear_cached_textures(self);
    g_clear_object(&self->display);
    G_OBJECT_CLASS(hanabi_scene_paintable_parent_class)->dispose(object);
}

static void hanabi_scene_paintable_finalize(GObject* object) {
    auto* self = HANABI_SCENE_PAINTABLE(object);
    self->textures.~unordered_map<int32_t, GdkTexture*>();
    self->scene.~unique_ptr<wallpaper::SceneWallpaper>();
    self->project.~SceneProject();
    g_clear_pointer(&self->project_dir, g_free);
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
    properties[PROP_PLAYING] =
        g_param_spec_boolean("playing", nullptr, nullptr, TRUE,
                             static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY));
    properties[PROP_READY] =
        g_param_spec_boolean("ready", nullptr, nullptr, FALSE,
                             static_cast<GParamFlags>(G_PARAM_READABLE | G_PARAM_EXPLICIT_NOTIFY));

    g_object_class_install_properties(object_class, N_PROPS, properties);
}

static void hanabi_scene_paintable_init(HanabiScenePaintable* self) {
    new (&self->textures) std::unordered_map<int32_t, GdkTexture*>();
    new (&self->scene) std::unique_ptr<wallpaper::SceneWallpaper>();
    new (&self->project) SceneProject();
    self->volume = 1.0;
    self->fill_mode = 2;
    self->fps = 30;
    self->playing = TRUE;
    self->last_logged_frame_id = -1;
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

void hanabi_scene_paintable_set_project_dir(HanabiScenePaintable* self, const char* project_dir) {
    g_return_if_fail(HANABI_SCENE_IS_PAINTABLE(self));

    if (g_strcmp0(self->project_dir, project_dir) == 0)
        return;

    SceneProject project;
    if (project_dir && *project_dir && !load_scene_project(project_dir, project)) {
        g_warning("HanabiScene: rejecting project-dir update because project load failed: %s",
                  project_dir);
        return;
    }

    g_message("HanabiScene: project-dir update old=%s new=%s",
              self->project_dir ? self->project_dir : "(null)",
              project_dir ? project_dir : "(null)");

    g_free(self->project_dir);
    self->project_dir = g_strdup(project_dir);
    self->project = std::move(project);
    self->scene.reset();
    self->scene_ready = false;
    self->render_ready = false;
    self->render_width = 0;
    self->render_height = 0;
    self->intrinsic_width = 0;
    self->intrinsic_height = 0;
    clear_cached_textures(self);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_PROJECT_DIR]);
    gdk_paintable_invalidate_size(GDK_PAINTABLE(self));
    gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
}

const char* hanabi_scene_paintable_get_project_dir(HanabiScenePaintable* self) {
    g_return_val_if_fail(HANABI_SCENE_IS_PAINTABLE(self), nullptr);
    return self->project_dir;
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
    if (self->scene) {
        self->scene->setPropertyInt32(
            wallpaper::PROPERTY_FILLMODE,
            static_cast<int32_t>(to_wp_fill_mode(self->fill_mode)));
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

    const double nx = CLAMP(x / static_cast<double>(self->render_width), 0.0, 1.0);
    const double ny = CLAMP(y / static_cast<double>(self->render_height), 0.0, 1.0);
    self->scene->mouseInput(nx, ny);
}
