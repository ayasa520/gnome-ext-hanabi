#include "hanabi-scene-widget.h"

#include <epoxy/gl.h>
#include <gio/gio.h>
#include <glib.h>
#include <glib/gstdio.h>

#include <array>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include <unordered_map>

#include "hanabi-scene-project.hpp"
#include "hanabi-scene-gpu-policy.hpp"
#include "SceneWallpaper.hpp"
#include "SceneWallpaperSurface.hpp"
#include "Scene/include/Scene/SceneShader.h"
#include "Swapchain/ExSwapchain.hpp"
#include "Type.hpp"
#include "Utils/Platform.hpp"

using hanabi::scene::SceneProject;
using hanabi::scene::configure_scene_wallpaper;
using hanabi::scene::ensure_scene_wallpaper;
using hanabi::scene::gpu_pipeline_policy_name;
using hanabi::scene::parse_gpu_pipeline_policy;
using hanabi::scene::render_gpu_pipeline_preference_for_policy;
using hanabi::scene::sync_scene_user_properties;
using hanabi::scene::to_wallpaper_fill_mode;
using hanabi::scene::vulkan_device_preference_for_policy;

namespace {

constexpr const char *CACHE_DIR_NAME = "hanabi-scene";

enum {
    PROP_0,
    PROP_PROJECT_DIR,
    PROP_USER_PROPERTIES_JSON,
    PROP_MUTED,
    PROP_VOLUME,
    PROP_FILL_MODE,
    PROP_FPS,
    PROP_GPU_PIPELINE,
    PROP_RENDER_SCALE,
    PROP_PLAYING,
    PROP_READY,
    N_PROPS,
};

struct TextureEntry {
    GLuint texture {0};
    GLuint memory_object {0};
    int width {0};
    int height {0};
    uint64_t generation {0};
};

GLuint compile_shader(GLenum type, const char *source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);

    GLint status = GL_FALSE;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &status);
    if (status == GL_TRUE)
        return shader;

    GLint log_length = 0;
    glGetShaderiv(shader, GL_INFO_LOG_LENGTH, &log_length);
    std::string log(static_cast<size_t>(log_length), '\0');
    glGetShaderInfoLog(shader, log_length, nullptr, log.data());
    g_warning("HanabiScene: shader compile failed: %s", log.c_str());
    glDeleteShader(shader);
    return 0;
}

GLuint create_program() {
    static constexpr const char *vertex_source = R"(
        #version 330 core
        layout (location = 0) in vec2 in_pos;
        layout (location = 1) in vec2 in_uv;
        out vec2 uv;
        void main() {
            uv = in_uv;
            gl_Position = vec4(in_pos, 0.0, 1.0);
        }
    )";

    static constexpr const char *fragment_source = R"(
        #version 330 core
        in vec2 uv;
        out vec4 out_color;
        uniform sampler2D frame_tex;
        void main() {
            out_color = texture(frame_tex, uv);
        }
    )";

    GLuint vertex = compile_shader(GL_VERTEX_SHADER, vertex_source);
    GLuint fragment = compile_shader(GL_FRAGMENT_SHADER, fragment_source);
    if (!vertex || !fragment) {
        if (vertex)
            glDeleteShader(vertex);
        if (fragment)
            glDeleteShader(fragment);
        return 0;
    }

    GLuint program = glCreateProgram();
    glAttachShader(program, vertex);
    glAttachShader(program, fragment);
    glLinkProgram(program);
    glDeleteShader(vertex);
    glDeleteShader(fragment);

    GLint status = GL_FALSE;
    glGetProgramiv(program, GL_LINK_STATUS, &status);
    if (status == GL_TRUE)
        return program;

    GLint log_length = 0;
    glGetProgramiv(program, GL_INFO_LOG_LENGTH, &log_length);
    std::string log(static_cast<size_t>(log_length), '\0');
    glGetProgramInfoLog(program, log_length, nullptr, log.data());
    g_warning("HanabiScene: program link failed: %s", log.c_str());
    glDeleteProgram(program);
    return 0;
}

bool ensure_gl_extensions() {
    if (!epoxy_has_gl_extension("GL_EXT_memory_object") ||
        !epoxy_has_gl_extension("GL_EXT_memory_object_fd"))
        return false;

    return glCreateMemoryObjectsEXT && glImportMemoryFdEXT && glTexStorageMem2DEXT;
}

std::array<std::uint8_t, GL_UUID_SIZE_EXT> get_gl_uuid() {
    std::array<std::uint8_t, GL_UUID_SIZE_EXT> uuid {};
    if (glGetUnsignedBytei_vEXT)
        glGetUnsignedBytei_vEXT(GL_DEVICE_UUID_EXT, 0, uuid.data());
    return uuid;
}

wallpaper::TexTiling pick_tiling() {
    if (!glGetInternalformativ)
        return wallpaper::TexTiling::OPTIMAL;

    GLint num_tiling_types = 0;
    glGetInternalformativ(GL_TEXTURE_2D, GL_RGBA8, GL_NUM_TILING_TYPES_EXT, 1, &num_tiling_types);
    if (num_tiling_types <= 0)
        return wallpaper::TexTiling::OPTIMAL;

    num_tiling_types = MIN(num_tiling_types, 4);
    std::array<GLint, 4> tilings {};
    glGetInternalformativ(GL_TEXTURE_2D, GL_RGBA8, GL_TILING_TYPES_EXT, num_tiling_types, tilings.data());

    bool support_optimal = false;
    bool support_linear = false;
    for (gint i = 0; i < num_tiling_types; i++) {
        if (tilings[static_cast<size_t>(i)] == GL_OPTIMAL_TILING_EXT)
            support_optimal = true;
        else if (tilings[static_cast<size_t>(i)] == GL_LINEAR_TILING_EXT)
            support_linear = true;
    }

    if (support_linear) {
        // Prefer linear external-memory images for the GTK widget bridge as well.  On
        // hybrid systems the GL context and Vulkan renderer can be backed by the iGPU,
        // where optimal tiling is advertised but the cross-API import path can still
        // present black frames.  Linear keeps the OPAQUE_FD handoff deterministic while
        // preserving the same frame rate and pixels.
        return wallpaper::TexTiling::LINEAR;
    }
    if (support_optimal)
        return wallpaper::TexTiling::OPTIMAL;
    return wallpaper::TexTiling::OPTIMAL;
}

class WidgetRedrawBridge : public std::enable_shared_from_this<WidgetRedrawBridge> {
public:
    explicit WidgetRedrawBridge(GObject *widget) {
        g_weak_ref_init(&widget_, widget);
    }

    WidgetRedrawBridge(const WidgetRedrawBridge&) = delete;
    WidgetRedrawBridge& operator=(const WidgetRedrawBridge&) = delete;

    ~WidgetRedrawBridge() {
        g_weak_ref_clear(&widget_);
    }

    void invalidate() {
        active_.store(false, std::memory_order_release);
    }

    void request_redraw() {
        if (!active_.load(std::memory_order_acquire))
            return;

        gpointer widget = g_weak_ref_get(&widget_);
        if (!widget)
            return;
        auto *object = G_OBJECT(widget);

        auto *request = new WidgetRedrawRequest { object, shared_from_this() };

        // RenderHandler emits redraws from its own looper thread. The bridge
        // converts that thread-owned notification into a main-context task that
        // owns a temporary strong widget reference, and the active flag lets a
        // dispose that happens after queueing suppress stale GTK render requests.
        g_main_context_invoke(
            nullptr,
            +[] (gpointer data) -> gboolean {
                std::unique_ptr<WidgetRedrawRequest> request(
                    static_cast<WidgetRedrawRequest*>(data));
                if (request->bridge->active_.load(std::memory_order_acquire))
                    gtk_gl_area_queue_render(GTK_GL_AREA(request->widget));
                g_object_unref(request->widget);
                return G_SOURCE_REMOVE;
            },
            request);
    }

private:
    struct WidgetRedrawRequest {
        GObject *widget;
        std::shared_ptr<WidgetRedrawBridge> bridge;
    };

    GWeakRef widget_ {};
    std::atomic<bool> active_ { true };
};

} // namespace

struct _HanabiSceneWidget {
    GtkGLArea parent_instance;

    gchar *project_dir;
    gchar *user_properties_json;
    gchar *media_state_json;
    GVariant *audio_samples;
    gboolean muted;
    gdouble volume;
    gint fill_mode;
    gint fps;
    gchar *gpu_pipeline;
    gboolean playing;

    bool gl_ready;
    bool scene_ready;
    bool render_ready;

    GLuint program;
    GLuint vao;
    GLuint vbo;
    GLuint ebo;
    GLuint current_texture;
    uint64_t current_texture_generation;
    gint current_width;
    gint current_height;
    gint render_width;
    gint render_height;
    gdouble render_scale;
    guint render_retry_id;
    std::array<std::uint8_t, GL_UUID_SIZE_EXT> gl_uuid;
    bool has_gl_uuid;

    std::unique_ptr<wallpaper::SceneWallpaper> scene;
    std::shared_ptr<WidgetRedrawBridge> redraw_bridge;
    std::unordered_map<int, TextureEntry> textures;
    SceneProject project;
    uint64_t project_generation {1};
};

G_DEFINE_TYPE(HanabiSceneWidget, hanabi_scene_widget, GTK_TYPE_GL_AREA)

static GParamSpec *properties[N_PROPS] = {};

static gboolean hanabi_scene_widget_is_ready(HanabiSceneWidget *self) {
    return self->current_texture != 0;
}

static double get_render_scale(HanabiSceneWidget *self) {
    return std::max(self->render_scale, static_cast<double>(gtk_widget_get_scale_factor(GTK_WIDGET(self))));
}

static void get_render_dimensions(HanabiSceneWidget *self, int logical_width, int logical_height, int *render_width, int *render_height) {
    const double scale = get_render_scale(self);
    *render_width = std::max(1, static_cast<int>(std::lround(logical_width * scale)));
    *render_height = std::max(1, static_cast<int>(std::lround(logical_height * scale)));
}

static void request_render(HanabiSceneWidget *self) {
    gtk_gl_area_queue_render(GTK_GL_AREA(self));
    gtk_widget_queue_draw(GTK_WIDGET(self));
}

static void clear_render_retry(HanabiSceneWidget *self) {
    if (self->render_retry_id) {
        g_source_remove(self->render_retry_id);
        self->render_retry_id = 0;
    }
}

static gboolean render_retry_cb(gpointer data) {
    auto *self = HANABI_SCENE_WIDGET(data);
    if (!gtk_widget_get_realized(GTK_WIDGET(self))) {
        self->render_retry_id = 0;
        return G_SOURCE_REMOVE;
    }

    request_render(self);
    if (self->render_ready) {
        self->render_retry_id = 0;
        return G_SOURCE_REMOVE;
    }

    return G_SOURCE_CONTINUE;
}

static void ensure_render_retry(HanabiSceneWidget *self) {
    if (!self->render_retry_id)
        self->render_retry_id = g_timeout_add(16, render_retry_cb, self);
}

static void reset_scene_state(HanabiSceneWidget *self) {
    const gboolean was_ready = hanabi_scene_widget_is_ready(self);
    clear_render_retry(self);
    self->scene.reset();
    self->scene_ready = false;
    self->render_ready = false;
    self->current_texture = 0;
    self->current_texture_generation = 0;
    self->current_width = 0;
    self->current_height = 0;
    self->render_width = 0;
    self->render_height = 0;
    if (was_ready)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_READY]);
}

static void hanabi_scene_widget_dispose(GObject *object) {
    auto *self = HANABI_SCENE_WIDGET(object);
    g_message("HanabiScene: widget dispose project=%s scene=%s textures=%zu",
              self->project_dir ? self->project_dir : "(null)",
              self->scene ? "true" : "false",
              self->textures.size());
    if (self->redraw_bridge)
        self->redraw_bridge->invalidate();
    reset_scene_state(self);
    self->textures.clear();
    G_OBJECT_CLASS(hanabi_scene_widget_parent_class)->dispose(object);
}

static void hanabi_scene_widget_finalize(GObject *object) {
    auto *self = HANABI_SCENE_WIDGET(object);
    g_message("HanabiScene: widget finalize project=%s scene=%s textures=%zu",
              self->project_dir ? self->project_dir : "(null)",
              self->scene ? "true" : "false",
              self->textures.size());
    self->scene.~unique_ptr<wallpaper::SceneWallpaper>();
    self->redraw_bridge.~shared_ptr<WidgetRedrawBridge>();
    self->textures.~unordered_map<int, TextureEntry>();
    self->project.~SceneProject();
    g_clear_pointer(&self->project_dir, g_free);
    g_clear_pointer(&self->user_properties_json, g_free);
    g_clear_pointer(&self->media_state_json, g_free);
    g_clear_pointer(&self->gpu_pipeline, g_free);
    g_clear_pointer(&self->audio_samples, g_variant_unref);
    G_OBJECT_CLASS(hanabi_scene_widget_parent_class)->finalize(object);
}

static void hanabi_scene_widget_set_property(GObject *object, guint prop_id, const GValue *value, GParamSpec *pspec) {
    auto *self = HANABI_SCENE_WIDGET(object);
    switch (prop_id) {
    case PROP_PROJECT_DIR:
        hanabi_scene_widget_set_project_dir(self, g_value_get_string(value));
        break;
    case PROP_USER_PROPERTIES_JSON:
        hanabi_scene_widget_set_user_properties_json(self, g_value_get_string(value));
        break;
    case PROP_MUTED:
        hanabi_scene_widget_set_muted(self, g_value_get_boolean(value));
        break;
    case PROP_VOLUME:
        hanabi_scene_widget_set_volume(self, g_value_get_double(value));
        break;
    case PROP_FILL_MODE:
        hanabi_scene_widget_set_fill_mode(self, g_value_get_int(value));
        break;
    case PROP_FPS:
        hanabi_scene_widget_set_fps(self, g_value_get_int(value));
        break;
    case PROP_GPU_PIPELINE:
        hanabi_scene_widget_set_gpu_pipeline(self, g_value_get_string(value));
        break;
    case PROP_RENDER_SCALE:
        hanabi_scene_widget_set_render_scale(self, g_value_get_double(value));
        break;
    case PROP_PLAYING:
        if (g_value_get_boolean(value))
            hanabi_scene_widget_play(self);
        else
            hanabi_scene_widget_pause(self);
        break;
    case PROP_READY:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
    }
}

static void hanabi_scene_widget_get_property(GObject *object, guint prop_id, GValue *value, GParamSpec *pspec) {
    auto *self = HANABI_SCENE_WIDGET(object);
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
    case PROP_GPU_PIPELINE:
        g_value_set_string(value, self->gpu_pipeline);
        break;
    case PROP_RENDER_SCALE:
        g_value_set_double(value, self->render_scale);
        break;
    case PROP_PLAYING:
        g_value_set_boolean(value, self->playing);
        break;
    case PROP_READY:
        g_value_set_boolean(value, hanabi_scene_widget_is_ready(self));
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
    }
}

static void clear_imported_textures(HanabiSceneWidget *self) {
    for (auto &[id, entry] : self->textures) {
        static_cast<void>(id);
        if (entry.texture)
            glDeleteTextures(1, &entry.texture);
        if (entry.memory_object)
            glDeleteMemoryObjectsEXT(1, &entry.memory_object);
    }
    self->textures.clear();
    self->current_texture = 0;
    self->current_texture_generation = 0;
}

static void delete_texture_entry(TextureEntry *entry) {
    if (!entry)
        return;

    if (entry->texture)
        glDeleteTextures(1, &entry->texture);
    if (entry->memory_object)
        glDeleteMemoryObjectsEXT(1, &entry->memory_object);

    entry->texture = 0;
    entry->memory_object = 0;
}

static void prune_stale_imported_textures(HanabiSceneWidget *self) {
    for (auto iter = self->textures.begin(); iter != self->textures.end();) {
        if (iter->second.generation == self->project_generation) {
            ++iter;
            continue;
        }

        // The GL widget keeps the old frame visible during a source reload, but
        // frame ids can restart when the reused SceneWallpaper parses the next
        // wallpaper. Pruning stale generations after the first new frame prevents
        // an old GL texture from being selected by a colliding frame id.
        delete_texture_entry(&iter->second);
        iter = self->textures.erase(iter);
    }
}

static void discard_cached_textures(HanabiSceneWidget *self) {
    if (self->textures.empty()) {
        self->current_texture = 0;
        return;
    }

    if (self->gl_ready && gtk_widget_get_realized(GTK_WIDGET(self))) {
        gtk_gl_area_make_current(GTK_GL_AREA(self));
        if (!gtk_gl_area_get_error(GTK_GL_AREA(self))) {
            clear_imported_textures(self);
            return;
        }
    }

    self->textures.clear();
    self->current_texture = 0;
}

static void destroy_gl_resources(HanabiSceneWidget *self) {
    if (!self->gl_ready)
        return;

    clear_imported_textures(self);

    if (self->ebo)
        glDeleteBuffers(1, &self->ebo);
    if (self->vbo)
        glDeleteBuffers(1, &self->vbo);
    if (self->vao)
        glDeleteVertexArrays(1, &self->vao);
    if (self->program)
        glDeleteProgram(self->program);

    self->program = 0;
    self->vao = 0;
    self->vbo = 0;
    self->ebo = 0;
    self->current_texture = 0;
    self->gl_ready = false;
}

static void hanabi_scene_widget_unrealize(GtkWidget *widget) {
    auto *self = HANABI_SCENE_WIDGET(widget);
    clear_render_retry(self);
    gtk_gl_area_make_current(GTK_GL_AREA(self));
    destroy_gl_resources(self);
    GTK_WIDGET_CLASS(hanabi_scene_widget_parent_class)->unrealize(widget);
}

static void hanabi_scene_widget_realize(GtkWidget *widget) {
    auto *self = HANABI_SCENE_WIDGET(widget);
    GTK_WIDGET_CLASS(hanabi_scene_widget_parent_class)->realize(widget);
    request_render(self);
    ensure_render_retry(self);
}

static void hanabi_scene_widget_map(GtkWidget *widget) {
    auto *self = HANABI_SCENE_WIDGET(widget);
    GTK_WIDGET_CLASS(hanabi_scene_widget_parent_class)->map(widget);
    request_render(self);
    ensure_render_retry(self);
}

static void hanabi_scene_widget_size_allocate(GtkWidget *widget, int width, int height, int baseline) {
    auto *self = HANABI_SCENE_WIDGET(widget);
    GTK_WIDGET_CLASS(hanabi_scene_widget_parent_class)->size_allocate(widget, width, height, baseline);
    if (width > 0 && height > 0) {
        request_render(self);
        ensure_render_retry(self);
    }
}

static void hanabi_scene_widget_snapshot(GtkWidget *widget, GtkSnapshot *snapshot) {
    GTK_WIDGET_CLASS(hanabi_scene_widget_parent_class)->snapshot(widget, snapshot);
}

static GdkGLContext *hanabi_scene_widget_create_context(GtkGLArea *area) {
    auto *context = GTK_GL_AREA_CLASS(hanabi_scene_widget_parent_class)->create_context(area);
    if (!context) {
        auto *error = gtk_gl_area_get_error(area);
        g_warning("HanabiScene: create-context failed: %s", error ? error->message : "(no error)");
        return nullptr;
    }
    return context;
}

static bool ensure_scene_initialized(HanabiSceneWidget *self) {
    if (self->scene_ready || self->project.scene_path.empty())
        return self->scene_ready;

    if (!ensure_scene_wallpaper(self->scene, CACHE_DIR_NAME, "widget", self->project))
        return false;

    configure_scene_wallpaper(*self->scene,
                              self->project,
                              self->volume,
                              self->muted,
                              self->fill_mode,
                              self->fps);
    hanabi::scene::sync_scene_media_state(
        *self->scene,
        hanabi::scene::build_scene_media_state_from_json(self->media_state_json, "widget"));
    hanabi::scene::sync_scene_audio_samples(
        *self->scene,
        hanabi::scene::build_scene_audio_samples_from_variant(self->audio_samples, "widget"));

    self->scene_ready = true;
    return true;
}

static bool ensure_render_initialized(HanabiSceneWidget *self) {
    int width = gtk_widget_get_width(GTK_WIDGET(self));
    int height = gtk_widget_get_height(GTK_WIDGET(self));
    if (width <= 0 || height <= 0) {
        return false;
    }

    int render_width = 0;
    int render_height = 0;
    get_render_dimensions(self, width, height, &render_width, &render_height);

    if (self->render_ready &&
        (self->render_width != render_width || self->render_height != render_height)) {
        g_message("HanabiScene: render size changed %dx%d -> %dx%d, recreating scene",
                  self->render_width,
                  self->render_height,
                  render_width,
                  render_height);
        reset_scene_state(self);
        discard_cached_textures(self);
    }

    if (self->render_ready)
        return true;

    if (!ensure_scene_initialized(self))
        return false;

    wallpaper::RenderInitInfo info {};
    const auto gpu_policy = parse_gpu_pipeline_policy(self->gpu_pipeline);
    info.offscreen = true;
    info.export_mode = wallpaper::ExternalFrameExportMode::OPAQUE_FD;
    info.device_preference = vulkan_device_preference_for_policy(gpu_policy);
    info.gpu_pipeline_preference = render_gpu_pipeline_preference_for_policy(gpu_policy);
    info.width = static_cast<uint16_t>(render_width);
    info.height = static_cast<uint16_t>(render_height);
    info.render_scale = get_render_scale(self);
    if (self->has_gl_uuid)
        info.uuid = self->gl_uuid;
    info.offscreen_tiling = pick_tiling();
    info.redraw_callback = [bridge = self->redraw_bridge]() {
        if (bridge)
            bridge->request_redraw();
    };
    g_message("HanabiScene: scene widget gpu-pipeline=%s",
              gpu_pipeline_policy_name(gpu_policy));
    self->scene->initVulkan(info);

    self->render_width = render_width;
    self->render_height = render_height;
    self->render_ready = true;
    if (self->playing)
        self->scene->play();
    else
        self->scene->pause();
    return true;
}

static bool ensure_gl_initialized(HanabiSceneWidget *self) {
    if (self->gl_ready)
        return true;

    if (!ensure_gl_extensions()) {
        g_warning("HanabiScene: required GL_EXT_memory_object(_fd) extensions are missing");
        return false;
    }

    self->program = create_program();
    if (!self->program)
        return false;

    static constexpr float vertices[] = {
        -1.0f, -1.0f, 0.0f, 1.0f,
         1.0f, -1.0f, 1.0f, 1.0f,
         1.0f,  1.0f, 1.0f, 0.0f,
        -1.0f,  1.0f, 0.0f, 0.0f,
    };
    static constexpr guint indices[] = {0, 1, 2, 2, 3, 0};

    glGenVertexArrays(1, &self->vao);
    glGenBuffers(1, &self->vbo);
    glGenBuffers(1, &self->ebo);

    glBindVertexArray(self->vao);
    glBindBuffer(GL_ARRAY_BUFFER, self->vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices, GL_STATIC_DRAW);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self->ebo);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof(indices), indices, GL_STATIC_DRAW);

    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<void *>(0));
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<void *>(2 * sizeof(float)));
    glEnableVertexAttribArray(1);

    glBindVertexArray(0);
    self->gl_uuid = get_gl_uuid();
    self->has_gl_uuid = std::any_of(self->gl_uuid.begin(), self->gl_uuid.end(), [](auto byte) {
        return byte != 0;
    });
    self->gl_ready = true;
    return true;
}

static void import_texture(HanabiSceneWidget *self, wallpaper::ExHandle &handle) {
    if (!handle.isOpaqueFd()) {
        g_warning("HanabiScene: GL importer only supports opaque-fd frames");
        return;
    }

    const int import_fd = handle.primaryFd();
    if (import_fd < 0) {
        g_warning("HanabiScene: opaque-fd frame is missing a valid file descriptor");
        return;
    }

    TextureEntry entry {};
    entry.width = handle.width;
    entry.height = handle.height;
    entry.generation = self->project_generation;

    glCreateMemoryObjectsEXT(1, &entry.memory_object);
    glImportMemoryFdEXT(entry.memory_object, handle.size, GL_HANDLE_TYPE_OPAQUE_FD_EXT, import_fd);

    glGenTextures(1, &entry.texture);
    glBindTexture(GL_TEXTURE_2D, entry.texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(
        GL_TEXTURE_2D,
        GL_TEXTURE_TILING_EXT,
        pick_tiling() == wallpaper::TexTiling::OPTIMAL ? GL_OPTIMAL_TILING_EXT : GL_LINEAR_TILING_EXT
    );
    glTexStorageMem2DEXT(GL_TEXTURE_2D, 1, GL_RGBA8, handle.width, handle.height, entry.memory_object, 0);
    glBindTexture(GL_TEXTURE_2D, 0);

    auto error = glGetError();
    if (error != GL_NO_ERROR) {
        g_warning("HanabiScene: import texture GL error=0x%x", error);
    }

    if (auto stale = self->textures.find(handle.id()); stale != self->textures.end()) {
        // Reused SceneWallpaper instances may produce the same external frame id
        // after a new source is loaded. Replace the stale entry only after the GL
        // import above succeeded so a transient import failure does not blank the
        // transition frame.
        delete_texture_entry(&stale->second);
        self->textures.erase(stale);
    }
    self->textures.emplace(handle.id(), entry);
    handle.fd = -1;
}

static gboolean hanabi_scene_widget_render(GtkGLArea *area, GdkGLContext *) {
    auto *self = HANABI_SCENE_WIDGET(area);
    gtk_gl_area_make_current(area);
    if (auto *error = gtk_gl_area_get_error(area)) {
        g_warning("HanabiScene: GtkGLArea error: %s", error->message);
        return TRUE;
    }

    if (!ensure_gl_initialized(self))
        return TRUE;
    if (!ensure_render_initialized(self))
        return TRUE;

    if (self->scene && self->scene->exSwapchain()) {
        if (auto *handle = self->scene->exSwapchain()->eatFrame()) {
            const gboolean was_ready = hanabi_scene_widget_is_ready(self);
            auto cached = self->textures.find(handle->id());
            if (cached == self->textures.end() ||
                cached->second.generation != self->project_generation)
                import_texture(self, *handle);

            auto it = self->textures.find(handle->id());
            if (it != self->textures.end() &&
                it->second.generation == self->project_generation) {
                self->current_texture = it->second.texture;
                self->current_texture_generation = it->second.generation;
                self->current_width = it->second.width;
                self->current_height = it->second.height;
                if (!was_ready && hanabi_scene_widget_is_ready(self))
                    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_READY]);
                prune_stale_imported_textures(self);
            }
        }
    }

    const int viewport_width = std::max(1, self->render_width);
    const int viewport_height = std::max(1, self->render_height);
    glViewport(0, 0, viewport_width, viewport_height);
    glClearColor(0.f, 0.f, 0.f, 1.f);
    glClear(GL_COLOR_BUFFER_BIT);

    if (self->current_texture) {
        glUseProgram(self->program);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, self->current_texture);
        glUniform1i(glGetUniformLocation(self->program, "frame_tex"), 0);
        glBindVertexArray(self->vao);
        glDrawElements(GL_TRIANGLES, 6, GL_UNSIGNED_INT, nullptr);
        glBindVertexArray(0);
        glBindTexture(GL_TEXTURE_2D, 0);
        glUseProgram(0);
    }

    if (self->playing)
        gtk_gl_area_queue_render(area);
    return TRUE;
}

static void hanabi_scene_widget_class_init(HanabiSceneWidgetClass *klass) {
    auto *object_class = G_OBJECT_CLASS(klass);
    auto *widget_class = GTK_WIDGET_CLASS(klass);
    auto *gl_area_class = GTK_GL_AREA_CLASS(klass);

    object_class->dispose = hanabi_scene_widget_dispose;
    object_class->finalize = hanabi_scene_widget_finalize;
    object_class->set_property = hanabi_scene_widget_set_property;
    object_class->get_property = hanabi_scene_widget_get_property;

    widget_class->map = hanabi_scene_widget_map;
    widget_class->realize = hanabi_scene_widget_realize;
    widget_class->size_allocate = hanabi_scene_widget_size_allocate;
    widget_class->snapshot = hanabi_scene_widget_snapshot;
    widget_class->unrealize = hanabi_scene_widget_unrealize;
    gl_area_class->create_context = hanabi_scene_widget_create_context;
    gl_area_class->render = hanabi_scene_widget_render;

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
    properties[PROP_GPU_PIPELINE] =
        g_param_spec_string("gpu-pipeline", nullptr, nullptr, "nvidia",
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

static void hanabi_scene_widget_init(HanabiSceneWidget *self) {
    new (&self->scene) std::unique_ptr<wallpaper::SceneWallpaper>();
    new (&self->redraw_bridge) std::shared_ptr<WidgetRedrawBridge>(
        std::make_shared<WidgetRedrawBridge>(G_OBJECT(self)));
    new (&self->textures) std::unordered_map<int, TextureEntry>();
    new (&self->project) SceneProject();
    self->volume = 1.0;
    self->fill_mode = 2;
    self->fps = 30;
    self->gpu_pipeline = g_strdup("nvidia");
    self->render_scale = 1.0;
    self->playing = TRUE;
    self->user_properties_json = nullptr;
    self->media_state_json = nullptr;
    self->audio_samples = nullptr;
    self->current_texture_generation = 0;
    self->project_generation = 1;

    gtk_gl_area_set_has_depth_buffer(GTK_GL_AREA(self), FALSE);
    gtk_gl_area_set_has_stencil_buffer(GTK_GL_AREA(self), FALSE);
    gtk_gl_area_set_auto_render(GTK_GL_AREA(self), FALSE);
    gtk_gl_area_set_allowed_apis(GTK_GL_AREA(self), static_cast<GdkGLAPI>(GDK_GL_API_GL | GDK_GL_API_GLES));
    g_signal_connect(self, "notify::error", G_CALLBACK(+[] (GtkGLArea *area) {
        auto *error = gtk_gl_area_get_error(area);
        g_warning("HanabiScene: notify::error %s", error ? error->message : "(none)");
    }), nullptr);
}

GtkWidget *hanabi_scene_widget_new(void) {
    return GTK_WIDGET(g_object_new(HANABI_SCENE_TYPE_WIDGET, nullptr));
}

static gboolean configure_widget_scene_for_current_project(HanabiSceneWidget *self,
                                                           const char *reason) {
    if (self->project.scene_path.empty())
        return FALSE;

    if (!ensure_scene_wallpaper(self->scene, CACHE_DIR_NAME, "widget", self->project))
        return FALSE;

    // This follows the KDE SceneViewer shape: the GtkGLArea remains attached to
    // the window and keeps one SceneWallpaper alive, while source/assets updates
    // ask that reusable renderer to parse the next wallpaper.
    configure_scene_wallpaper(*self->scene,
                              self->project,
                              self->volume,
                              self->muted,
                              self->fill_mode,
                              self->fps);
    hanabi::scene::sync_scene_media_state(
        *self->scene,
        hanabi::scene::build_scene_media_state_from_json(self->media_state_json, "widget"));
    hanabi::scene::sync_scene_audio_samples(
        *self->scene,
        hanabi::scene::build_scene_audio_samples_from_variant(self->audio_samples, "widget"));
    self->scene_ready = true;
    if (self->playing)
        self->scene->play();
    else
        self->scene->pause();

    g_message("HanabiScene: widget reused SceneWallpaper reason=%s generation=%" G_GUINT64_FORMAT " source=%s assets=%s render-ready=%s cached-textures=%zu",
              reason ? reason : "unknown",
              self->project_generation,
              self->project.scene_path.c_str(),
              self->project.assets_path.c_str(),
              self->render_ready ? "true" : "false",
              self->textures.size());
    return TRUE;
}

gboolean hanabi_scene_widget_reload_project(HanabiSceneWidget *self,
                                            const char *project_dir,
                                            const char *user_properties_json) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), FALSE);

    SceneProject project;
    if (!hanabi::scene::load_scene_project_with_overrides(
            project_dir, user_properties_json, project, "widget")) {
        g_warning("HanabiScene: rejecting widget project reload because project load failed: %s",
                  project_dir ? project_dir : "(null)");
        return FALSE;
    }

    const bool project_changed =
        self->project.scene_path != project.scene_path ||
        self->project.assets_path != project.assets_path ||
        g_strcmp0(self->project_dir, project_dir) != 0;
    const bool user_properties_changed =
        g_strcmp0(self->user_properties_json, user_properties_json) != 0;

    g_message("HanabiScene: widget project reload old=%s new=%s project-changed=%s user-properties-changed=%s",
              self->project_dir ? self->project_dir : "(null)",
              project_dir ? project_dir : "(null)",
              project_changed ? "true" : "false",
              user_properties_changed ? "true" : "false");

    g_free(self->project_dir);
    self->project_dir = g_strdup(project_dir);
    g_free(self->user_properties_json);
    self->user_properties_json = g_strdup(user_properties_json);
    self->project = std::move(project);

    if (project_changed) {
        // Keep the currently bound GL texture as a transition frame, but move
        // the import path to a new generation so a new wallpaper cannot reuse a
        // stale cached texture with the same external frame id.
        self->project_generation++;
    }

    if (self->scene) {
        if (project_changed)
            configure_widget_scene_for_current_project(self, "project-reload");
        else
            sync_scene_user_properties(*self->scene, self->project);
    }

    if (project_changed)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_PROJECT_DIR]);
    if (user_properties_changed)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_USER_PROPERTIES_JSON]);

    request_render(self);
    ensure_render_retry(self);
    return TRUE;
}

void hanabi_scene_widget_set_project_dir(HanabiSceneWidget *self, const char *project_dir) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));

    if (g_strcmp0(self->project_dir, project_dir) == 0)
        return;

    hanabi_scene_widget_reload_project(self, project_dir, self->user_properties_json);
}

const char *hanabi_scene_widget_get_project_dir(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), nullptr);
    return self->project_dir;
}

void hanabi_scene_widget_set_user_properties_json(HanabiSceneWidget *self, const char *user_properties_json) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));

    if (g_strcmp0(self->user_properties_json, user_properties_json) == 0)
        return;

    g_free(self->user_properties_json);
    self->user_properties_json = g_strdup(user_properties_json);
    hanabi::scene::apply_user_property_overrides(self->project, self->user_properties_json, "widget");
    if (self->scene) {
        // User-property edits for the same wallpaper are live updates on the
        // reusable SceneWallpaper, matching KDE's property setter model instead
        // of tearing down the native GtkGLArea/render path.
        sync_scene_user_properties(*self->scene, self->project);
    }
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_USER_PROPERTIES_JSON]);
    request_render(self);
    ensure_render_retry(self);
}

const char *hanabi_scene_widget_get_user_properties_json(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), nullptr);
    return self->user_properties_json;
}

void hanabi_scene_widget_set_media_state_json(HanabiSceneWidget *self, const char *media_state_json) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));

    if (g_strcmp0(self->media_state_json, media_state_json) == 0)
        return;

    g_free(self->media_state_json);
    self->media_state_json = g_strdup(media_state_json);
    if (self->scene) {
        hanabi::scene::sync_scene_media_state(
            *self->scene,
            hanabi::scene::build_scene_media_state_from_json(self->media_state_json, "widget"));
    }
    request_render(self);
    ensure_render_retry(self);
}

void hanabi_scene_widget_set_audio_samples(HanabiSceneWidget *self, GVariant *audio_samples) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));

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
            hanabi::scene::build_scene_audio_samples_from_variant(self->audio_samples, "widget"));
    }
    if (!self->playing) {
        request_render(self);
        ensure_render_retry(self);
    }
}

void hanabi_scene_widget_set_muted(HanabiSceneWidget *self, gboolean muted) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    const gboolean changed = self->muted != muted;
    self->muted = muted;
    if (self->scene)
        self->scene->setPropertyBool(wallpaper::PROPERTY_MUTED, self->muted);
    if (changed)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_MUTED]);
}

gboolean hanabi_scene_widget_get_muted(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), FALSE);
    return self->muted;
}

void hanabi_scene_widget_set_volume(HanabiSceneWidget *self, double volume) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    volume = CLAMP(volume, 0.0, 1.0);
    const bool changed = std::abs(self->volume - volume) >= 0.0001;
    self->volume = volume;
    if (self->scene)
        self->scene->setPropertyFloat(wallpaper::PROPERTY_VOLUME, static_cast<float>(self->volume));
    if (changed)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_VOLUME]);
}

double hanabi_scene_widget_get_volume(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), 1.0);
    return self->volume;
}

void hanabi_scene_widget_set_fill_mode(HanabiSceneWidget *self, int fill_mode) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    fill_mode = CLAMP(fill_mode, 0, 2);
    if (self->fill_mode == fill_mode)
        return;
    self->fill_mode = fill_mode;
    if (self->scene)
        self->scene->setPropertyInt32(wallpaper::PROPERTY_FILLMODE, static_cast<int32_t>(to_wallpaper_fill_mode(self->fill_mode)));
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_FILL_MODE]);
}

int hanabi_scene_widget_get_fill_mode(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), 2);
    return self->fill_mode;
}

void hanabi_scene_widget_set_fps(HanabiSceneWidget *self, int fps) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    fps = CLAMP(fps, 5, 240);
    if (self->fps == fps)
        return;
    self->fps = fps;
    if (self->scene)
        self->scene->setPropertyInt32(wallpaper::PROPERTY_FPS, self->fps);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_FPS]);
}

int hanabi_scene_widget_get_fps(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), 30);
    return self->fps;
}

void hanabi_scene_widget_set_gpu_pipeline(HanabiSceneWidget *self, const char *gpu_pipeline) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    const char *next = gpu_pipeline != nullptr ? gpu_pipeline : "nvidia";
    if (g_strcmp0(self->gpu_pipeline, next) == 0)
        return;

    g_free(self->gpu_pipeline);
    self->gpu_pipeline = g_strdup(next);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_GPU_PIPELINE]);
}

const char *hanabi_scene_widget_get_gpu_pipeline(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), nullptr);
    return self->gpu_pipeline;
}

void hanabi_scene_widget_set_render_scale(HanabiSceneWidget *self, double render_scale) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));

    const double effective_scale = MAX(1.0, render_scale);
    if (std::abs(self->render_scale - effective_scale) < 0.0001)
        return;

    self->render_scale = effective_scale;
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_RENDER_SCALE]);
    request_render(self);
    ensure_render_retry(self);
}

double hanabi_scene_widget_get_render_scale(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), 1.0);
    return self->render_scale;
}

void hanabi_scene_widget_play(HanabiSceneWidget *self) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    if (self->playing)
        return;
    self->playing = TRUE;
    if (self->scene)
        self->scene->play();
    request_render(self);
    ensure_render_retry(self);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_PLAYING]);
}

void hanabi_scene_widget_pause(HanabiSceneWidget *self) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    if (!self->playing)
        return;
    self->playing = FALSE;
    if (self->scene)
        self->scene->pause();
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_PLAYING]);
}

gboolean hanabi_scene_widget_get_playing(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), FALSE);
    return self->playing;
}

gboolean hanabi_scene_widget_get_ready(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), FALSE);
    return hanabi_scene_widget_is_ready(self);
}

void hanabi_scene_widget_set_mouse_pos(HanabiSceneWidget *self, double x, double y) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    if (!self->scene)
        return;

    const int width = gtk_widget_get_width(GTK_WIDGET(self));
    const int height = gtk_widget_get_height(GTK_WIDGET(self));
    if (width <= 0 || height <= 0)
        return;

    // Scene renderer expects normalized [0, 1] coordinates.
    const double nx = CLAMP(x / static_cast<double>(width), 0.0, 1.0);
    const double ny = CLAMP(y / static_cast<double>(height), 0.0, 1.0);
    self->scene->mouseInput(nx, ny);
}

void hanabi_scene_widget_set_cursor_left_down(HanabiSceneWidget *self, gboolean down) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));
    if (!self->scene)
        return;

    self->scene->mouseLeftButton(down);
}
