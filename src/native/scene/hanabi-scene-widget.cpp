#include "hanabi-scene-widget.h"

#include <epoxy/gl.h>
#include <gio/gio.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>

#include <array>
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>

#include "SceneWallpaper.hpp"
#include "SceneWallpaperSurface.hpp"
#include "Scene/include/Scene/SceneShader.h"
#include "Swapchain/ExSwapchain.hpp"
#include "Type.hpp"
#include "Utils/Platform.hpp"

namespace {

constexpr const char *CACHE_DIR_NAME = "hanabi-scene";

enum {
    PROP_0,
    PROP_PROJECT_DIR,
    PROP_MUTED,
    PROP_VOLUME,
    PROP_FILL_MODE,
    PROP_FPS,
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
};

struct SceneProject {
    std::string project_dir;
    std::string scene_path;
    std::string assets_path;
    wallpaper::ShaderValueMap user_properties;
};

bool parse_property_default(JsonObject *property, wallpaper::ShaderValue *out_value) {
    if (!json_object_has_member(property, "value"))
        return false;

    JsonNode *value = json_object_get_member(property, "value");
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

    const char *string_value = json_node_get_string(value);
    if (!string_value || !*string_value)
        return false;

    std::vector<float> components;
    g_auto(GStrv) parts = g_strsplit_set(string_value, " ,", -1);
    for (gchar **part = parts; part && *part; part++) {
        if (**part == '\0')
            continue;

        char *endptr = nullptr;
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

bool read_json_file(const char *path, JsonNode **out_root) {
    g_autoptr(GError) error = nullptr;
    g_autofree gchar *contents = nullptr;
    gsize length = 0;
    if (!g_file_get_contents(path, &contents, &length, &error))
        return false;

    g_autoptr(JsonParser) parser = json_parser_new();
    if (!json_parser_load_from_data(parser, contents, static_cast<gssize>(length), &error))
        return false;

    *out_root = json_node_copy(json_parser_get_root(parser));
    return true;
}

std::string resolve_regular_file(const std::string &project_dir, const std::string &relative_path) {
    if (relative_path.empty())
        return {};

    auto path = std::filesystem::path(project_dir) / relative_path;
    if (!std::filesystem::is_regular_file(path))
        return {};

    return path.string();
}

std::string resolve_assets_path(const std::string &project_dir) {
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

bool load_scene_project(const char *project_dir, SceneProject &project) {
    auto manifest_path = std::filesystem::path(project_dir) / "project.json";
    if (!std::filesystem::is_regular_file(manifest_path))
        return false;

    JsonNode *root = nullptr;
    if (!read_json_file(manifest_path.c_str(), &root))
        return false;

    g_autoptr(JsonNode) root_holder = root;
    if (!JSON_NODE_HOLDS_OBJECT(root))
        return false;

    JsonObject *object = json_node_get_object(root);
    const char *type = json_object_has_member(object, "type")
        ? json_object_get_string_member(object, "type")
        : "";
    if (g_ascii_strcasecmp(type, "scene") != 0)
        return false;

    std::string file_member = json_object_has_member(object, "file")
        ? json_object_get_string_member(object, "file")
        : "";
    std::string scene_path = resolve_regular_file(project_dir, file_member);
    if (scene_path.empty())
        scene_path = resolve_regular_file(project_dir, "scene.pkg");
    if (scene_path.empty())
        return false;

    std::string assets_path = resolve_assets_path(project_dir);
    if (assets_path.empty())
        return false;

    if (json_object_has_member(object, "general")) {
        JsonObject *general = json_object_get_object_member(object, "general");
        if (general && json_object_has_member(general, "properties")) {
            JsonObject *properties = json_object_get_object_member(general, "properties");
            if (properties) {
                g_autoptr(GList) members = json_object_get_members(properties);
                for (GList *iter = members; iter; iter = iter->next) {
                    const char *name = static_cast<const char *>(iter->data);
                    JsonObject *property = json_object_get_object_member(properties, name);
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

    const char *vendor = reinterpret_cast<const char *>(glGetString(GL_VENDOR));
    if (support_linear && vendor && g_strrstr(vendor, "AMD"))
        return wallpaper::TexTiling::LINEAR;
    if (support_optimal)
        return wallpaper::TexTiling::OPTIMAL;
    if (support_linear)
        return wallpaper::TexTiling::LINEAR;
    return wallpaper::TexTiling::OPTIMAL;
}

void queue_render_on_main(gpointer data) {
    auto *self = HANABI_SCENE_WIDGET(data);
    gtk_gl_area_queue_render(GTK_GL_AREA(self));
    g_object_unref(self);
}

} // namespace

struct _HanabiSceneWidget {
    GtkGLArea parent_instance;

    gchar *project_dir;
    gboolean muted;
    gdouble volume;
    gint fill_mode;
    gint fps;
    gboolean playing;

    bool gl_ready;
    bool scene_ready;
    bool render_ready;

    GLuint program;
    GLuint vao;
    GLuint vbo;
    GLuint ebo;
    GLuint current_texture;
    gint current_width;
    gint current_height;
    gint render_width;
    gint render_height;
    gdouble render_scale;
    guint render_retry_id;
    std::array<std::uint8_t, GL_UUID_SIZE_EXT> gl_uuid;
    bool has_gl_uuid;

    std::unique_ptr<wallpaper::SceneWallpaper> scene;
    std::unordered_map<int, TextureEntry> textures;
    SceneProject project;
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
    self->current_width = 0;
    self->current_height = 0;
    self->render_width = 0;
    self->render_height = 0;
    if (was_ready)
        g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_READY]);
}

static void hanabi_scene_widget_dispose(GObject *object) {
    auto *self = HANABI_SCENE_WIDGET(object);
    reset_scene_state(self);
    self->textures.clear();
    G_OBJECT_CLASS(hanabi_scene_widget_parent_class)->dispose(object);
}

static void hanabi_scene_widget_finalize(GObject *object) {
    auto *self = HANABI_SCENE_WIDGET(object);
    self->scene.~unique_ptr<wallpaper::SceneWallpaper>();
    self->textures.~unordered_map<int, TextureEntry>();
    self->project.~SceneProject();
    g_clear_pointer(&self->project_dir, g_free);
    G_OBJECT_CLASS(hanabi_scene_widget_parent_class)->finalize(object);
}

static void hanabi_scene_widget_set_property(GObject *object, guint prop_id, const GValue *value, GParamSpec *pspec) {
    auto *self = HANABI_SCENE_WIDGET(object);
    switch (prop_id) {
    case PROP_PROJECT_DIR:
        hanabi_scene_widget_set_project_dir(self, g_value_get_string(value));
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

static void redraw_callback(gpointer data) {
    g_main_context_invoke(nullptr, reinterpret_cast<GSourceFunc>(+[] (gpointer user_data) -> gboolean {
        queue_render_on_main(user_data);
        return G_SOURCE_REMOVE;
    }), data);
}

static bool ensure_scene_initialized(HanabiSceneWidget *self) {
    if (self->scene_ready || self->project.scene_path.empty())
        return self->scene_ready;

    if (!self->scene) {
        self->scene = std::make_unique<wallpaper::SceneWallpaper>();
        if (!self->scene->init()) {
            g_warning("HanabiScene: failed to initialize scene wallpaper");
            self->scene.reset();
            return false;
        }
        self->scene->setPropertyString(
            wallpaper::PROPERTY_CACHE_PATH,
            wallpaper::platform::GetCachePath(CACHE_DIR_NAME).string()
        );
    }

    self->scene->setPropertyObject(
        wallpaper::PROPERTY_USER_PROPERTIES,
        std::make_shared<wallpaper::ShaderValueMap>(self->project.user_properties)
    );
    self->scene->setPropertyString(wallpaper::PROPERTY_ASSETS, self->project.assets_path);
    self->scene->setPropertyString(wallpaper::PROPERTY_SOURCE, self->project.scene_path);
    self->scene->setPropertyFloat(wallpaper::PROPERTY_VOLUME, static_cast<float>(self->volume));
    self->scene->setPropertyBool(wallpaper::PROPERTY_MUTED, self->muted);
    self->scene->setPropertyInt32(wallpaper::PROPERTY_FILLMODE, static_cast<int32_t>(to_wp_fill_mode(self->fill_mode)));
    self->scene->setPropertyInt32(wallpaper::PROPERTY_FPS, self->fps);

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
    info.offscreen = true;
    info.export_mode = wallpaper::ExternalFrameExportMode::OPAQUE_FD;
    info.width = static_cast<uint16_t>(render_width);
    info.height = static_cast<uint16_t>(render_height);
    if (self->has_gl_uuid)
        info.uuid = self->gl_uuid;
    info.offscreen_tiling = pick_tiling();
    info.redraw_callback = [self]() {
        redraw_callback(g_object_ref(self));
    };
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
            if (self->textures.find(handle->id()) == self->textures.end())
                import_texture(self, *handle);

            auto it = self->textures.find(handle->id());
            if (it != self->textures.end()) {
                self->current_texture = it->second.texture;
                self->current_width = it->second.width;
                self->current_height = it->second.height;
                if (!was_ready && hanabi_scene_widget_is_ready(self))
                    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_READY]);
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

static void hanabi_scene_widget_init(HanabiSceneWidget *self) {
    new (&self->scene) std::unique_ptr<wallpaper::SceneWallpaper>();
    new (&self->textures) std::unordered_map<int, TextureEntry>();
    new (&self->project) SceneProject();
    self->volume = 1.0;
    self->fill_mode = 2;
    self->fps = 30;
    self->render_scale = 1.0;
    self->playing = TRUE;

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

void hanabi_scene_widget_set_project_dir(HanabiSceneWidget *self, const char *project_dir) {
    g_return_if_fail(HANABI_SCENE_IS_WIDGET(self));

    if (g_strcmp0(self->project_dir, project_dir) == 0)
        return;

    SceneProject project;
    if (project_dir && *project_dir && !load_scene_project(project_dir, project))
        return;

    g_free(self->project_dir);
    self->project_dir = g_strdup(project_dir);
    self->project = std::move(project);
    reset_scene_state(self);
    discard_cached_textures(self);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_PROJECT_DIR]);
    request_render(self);
    ensure_render_retry(self);
}

const char *hanabi_scene_widget_get_project_dir(HanabiSceneWidget *self) {
    g_return_val_if_fail(HANABI_SCENE_IS_WIDGET(self), nullptr);
    return self->project_dir;
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
        self->scene->setPropertyInt32(wallpaper::PROPERTY_FILLMODE, static_cast<int32_t>(to_wp_fill_mode(self->fill_mode)));
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
