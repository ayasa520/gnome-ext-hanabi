#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

#include <gio/gio.h>
#include <glib.h>
#include <json-glib/json-glib.h>

#include "SceneWallpaper.hpp"
#include "Utils/Platform.hpp"
#include "WPUserProperties.hpp"

namespace hanabi::scene
{

struct SceneProject {
    std::string project_dir;
    std::string scene_path;
    std::string assets_path;
    wallpaper::UserPropertyMap default_user_properties;
    wallpaper::UserPropertyMap user_properties;
    std::unordered_map<std::string, std::string> user_property_types;
};

inline void apply_user_property_overrides(SceneProject& project,
                                          const char* user_properties_json,
                                          const char* log_context);

inline wallpaper::FillMode to_wallpaper_fill_mode(int fill_mode) {
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

inline bool property_type_prefers_string(const char* type) {
    if (!type)
        return false;

    return g_ascii_strcasecmp(type, "text") == 0 ||
        g_ascii_strcasecmp(type, "textinput") == 0 ||
        g_ascii_strcasecmp(type, "combo") == 0 ||
        g_ascii_strcasecmp(type, "file") == 0 ||
        g_ascii_strcasecmp(type, "directory") == 0 ||
        g_ascii_strcasecmp(type, "scenetexture") == 0;
}

inline bool property_prefers_string(JsonObject* property) {
    const char* type = json_object_has_member(property, "type")
        ? json_object_get_string_member(property, "type")
        : "";
    return property_type_prefers_string(type);
}

inline bool parse_numeric_components_from_string(const char* text, std::vector<float>* out_components) {
    if (!text || !out_components)
        return false;

    out_components->clear();
    g_auto(GStrv) parts = g_strsplit_set(text, " ,", -1);
    for (gchar** part = parts; part && *part; part++) {
        if (**part == '\0')
            continue;

        char* endptr = nullptr;
        double component = g_ascii_strtod(*part, &endptr);
        if (endptr == *part)
            continue;

        out_components->push_back(static_cast<float>(component));
    }

    return !out_components->empty();
}

inline bool parse_numeric_components(JsonNode* value, std::vector<float>* out_components) {
    if (!value || !out_components)
        return false;

    out_components->clear();

    if (JSON_NODE_HOLDS_ARRAY(value)) {
        JsonArray* array = json_node_get_array(value);
        if (!array)
            return false;

        const auto length = json_array_get_length(array);
        out_components->reserve(length);
        for (guint index = 0; index < length; index++) {
            JsonNode* item = json_array_get_element(array, index);
            if (!item || !JSON_NODE_HOLDS_VALUE(item))
                return false;

            const GType item_type = json_node_get_value_type(item);
            if (item_type != G_TYPE_DOUBLE && item_type != G_TYPE_INT64 && item_type != G_TYPE_BOOLEAN)
                return false;

            if (item_type == G_TYPE_BOOLEAN)
                out_components->push_back(json_node_get_boolean(item) ? 1.0f : 0.0f);
            else
                out_components->push_back(static_cast<float>(json_node_get_double(item)));
        }

        return !out_components->empty();
    }

    if (!JSON_NODE_HOLDS_VALUE(value))
        return false;

    const GType value_type = json_node_get_value_type(value);
    if (value_type == G_TYPE_STRING)
        return parse_numeric_components_from_string(json_node_get_string(value), out_components);

    if (value_type == G_TYPE_DOUBLE || value_type == G_TYPE_INT64) {
        out_components->push_back(static_cast<float>(json_node_get_double(value)));
        return true;
    }

    if (value_type == G_TYPE_BOOLEAN) {
        out_components->push_back(json_node_get_boolean(value) ? 1.0f : 0.0f);
        return true;
    }

    return false;
}

inline bool parse_user_property_value_node(JsonNode* value,
                                           const char* type,
                                           wallpaper::UserPropertyValue* out_value) {
    if (!value || !out_value)
        return false;

    const bool prefer_string = property_type_prefers_string(type);
    if (JSON_NODE_HOLDS_ARRAY(value)) {
        if (prefer_string)
            return false;

        std::vector<float> components;
        if (!parse_numeric_components(value, &components))
            return false;

        *out_value = wallpaper::ShaderValue(components);
        return true;
    }

    if (!JSON_NODE_HOLDS_VALUE(value))
        return false;

    const GType value_type = json_node_get_value_type(value);
    if (g_ascii_strcasecmp(type ? type : "", "bool") == 0) {
        if (value_type == G_TYPE_BOOLEAN) {
            *out_value = wallpaper::ShaderValue(json_node_get_boolean(value) ? 1.0f : 0.0f);
            return true;
        }

        if (value_type == G_TYPE_DOUBLE || value_type == G_TYPE_INT64) {
            *out_value = wallpaper::ShaderValue(std::abs(json_node_get_double(value)) >= 0.0001 ? 1.0f : 0.0f);
            return true;
        }

        if (value_type == G_TYPE_STRING) {
            const char* string_value = json_node_get_string(value);
            const gboolean truthy = string_value &&
                g_ascii_strcasecmp(string_value, "0") != 0 &&
                g_ascii_strcasecmp(string_value, "false") != 0 &&
                *string_value != '\0';
            *out_value = wallpaper::ShaderValue(truthy ? 1.0f : 0.0f);
            return true;
        }

        return false;
    }

    if (value_type == G_TYPE_BOOLEAN) {
        *out_value = wallpaper::ShaderValue(json_node_get_boolean(value) ? 1.0f : 0.0f);
        return true;
    }

    if (value_type == G_TYPE_DOUBLE || value_type == G_TYPE_INT64) {
        if (prefer_string) {
            char buffer[G_ASCII_DTOSTR_BUF_SIZE] = {};
            g_ascii_dtostr(buffer, sizeof(buffer), json_node_get_double(value));
            *out_value = std::string(buffer);
            return true;
        }

        *out_value = wallpaper::ShaderValue(static_cast<float>(json_node_get_double(value)));
        return true;
    }

    if (value_type != G_TYPE_STRING)
        return false;

    const char* string_value = json_node_get_string(value);
    if (!string_value)
        return false;

    if (prefer_string) {
        *out_value = std::string(string_value);
        return true;
    }

    std::vector<float> components;
    if (parse_numeric_components_from_string(string_value, &components)) {
        *out_value = wallpaper::ShaderValue(components);
        return true;
    }

    *out_value = std::string(string_value);
    return true;
}

inline bool parse_property_default(JsonObject* property, wallpaper::UserProperty* out_property) {
    if (!property || !out_property || !json_object_has_member(property, "value"))
        return false;

    JsonNode* value = json_object_get_member(property, "value");
    if (!value)
        return false;

    if (json_object_has_member(property, "condition")) {
        const char* condition = json_object_get_string_member(property, "condition");
        out_property->condition = condition ? condition : "";
    } else {
        out_property->condition.clear();
    }

    const char* type = json_object_has_member(property, "type")
        ? json_object_get_string_member(property, "type")
        : nullptr;

    return parse_user_property_value_node(value, type, &out_property->value);
}

inline bool read_json_file(const char* path, JsonNode** out_root, const char* log_context) {
    g_autoptr(GError) error = nullptr;
    g_autofree gchar* contents = nullptr;
    gsize length = 0;
    if (!g_file_get_contents(path, &contents, &length, &error)) {
        g_warning("HanabiScene(%s): failed to read json file %s: %s",
                  log_context,
                  path,
                  error ? error->message : "(unknown error)");
        return false;
    }

    g_autoptr(JsonParser) parser = json_parser_new();
    if (!json_parser_load_from_data(parser, contents, static_cast<gssize>(length), &error)) {
        g_warning("HanabiScene(%s): failed to parse json file %s: %s",
                  log_context,
                  path,
                  error ? error->message : "(unknown error)");
        return false;
    }

    *out_root = json_node_copy(json_parser_get_root(parser));
    return true;
}

inline std::string resolve_regular_file(const std::string& project_dir, const std::string& relative_path) {
    if (relative_path.empty())
        return {};

    auto path = std::filesystem::path(project_dir) / relative_path;
    if (!std::filesystem::is_regular_file(path))
        return {};

    return path.string();
}

inline std::string resolve_assets_path(const std::string& project_dir) {
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

inline bool load_scene_project(const char* project_dir, SceneProject& project, const char* log_context) {
    auto manifest_path = std::filesystem::path(project_dir) / "project.json";
    if (!std::filesystem::is_regular_file(manifest_path)) {
        g_warning("HanabiScene(%s): project manifest not found: %s", log_context, manifest_path.c_str());
        return false;
    }

    JsonNode* root = nullptr;
    if (!read_json_file(manifest_path.c_str(), &root, log_context))
        return false;

    g_autoptr(JsonNode) root_holder = root;
    if (!JSON_NODE_HOLDS_OBJECT(root)) {
        g_warning("HanabiScene(%s): project manifest root is not an object: %s",
                  log_context,
                  manifest_path.c_str());
        return false;
    }

    JsonObject* object = json_node_get_object(root);
    const char* type = json_object_has_member(object, "type")
        ? json_object_get_string_member(object, "type")
        : "";
    if (g_ascii_strcasecmp(type, "scene") != 0) {
        g_warning("HanabiScene(%s): unsupported project type '%s' in %s",
                  log_context,
                  type,
                  manifest_path.c_str());
        return false;
    }

    std::string file_member = json_object_has_member(object, "file")
        ? json_object_get_string_member(object, "file")
        : "";
    std::string scene_path = resolve_regular_file(project_dir, file_member);
    if (scene_path.empty())
        scene_path = resolve_regular_file(project_dir, "scene.pkg");
    if (scene_path.empty()) {
        g_warning("HanabiScene(%s): failed to resolve scene package under %s", log_context, project_dir);
        return false;
    }

    std::string assets_path = resolve_assets_path(project_dir);
    if (assets_path.empty()) {
        g_warning("HanabiScene(%s): failed to resolve Wallpaper Engine assets for %s",
                  log_context,
                  project_dir);
        return false;
    }

    project = {};

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

                    wallpaper::UserProperty parsed_property;
                    if (!parse_property_default(property, &parsed_property))
                        continue;

                    project.default_user_properties[name] = parsed_property;
                    project.user_properties[name] = std::move(parsed_property);
                    project.user_property_types[name] = json_object_has_member(property, "type")
                        ? json_object_get_string_member(property, "type")
                        : "";
                }
            }
        }
    }

    project.project_dir = project_dir;
    project.scene_path = std::move(scene_path);
    project.assets_path = std::move(assets_path);
    return true;
}

inline bool load_scene_project_with_overrides(const char* project_dir,
                                              const char* user_properties_json,
                                              SceneProject& project,
                                              const char* log_context) {
    if (project_dir && *project_dir &&
        !load_scene_project(project_dir, project, log_context)) {
        return false;
    }

    apply_user_property_overrides(project, user_properties_json, log_context);
    return true;
}

inline void apply_user_property_overrides(SceneProject& project,
                                          const char* user_properties_json,
                                          const char* log_context) {
    project.user_properties = project.default_user_properties;

    if (!user_properties_json || *user_properties_json == '\0')
        return;

    g_autoptr(JsonNode) root = json_from_string(user_properties_json, nullptr);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
        g_warning("HanabiScene(%s): invalid user property override json for %s",
                  log_context,
                  project.project_dir.c_str());
        return;
    }

    JsonObject* overrides = json_node_get_object(root);
    if (!overrides) {
        g_warning("HanabiScene(%s): override json is not an object for %s",
                  log_context,
                  project.project_dir.c_str());
        return;
    }

    g_autoptr(GList) members = json_object_get_members(overrides);
    for (GList* iter = members; iter; iter = iter->next) {
        const char* name = static_cast<const char*>(iter->data);
        auto property_iter = project.user_properties.find(name);
        if (property_iter == project.user_properties.end())
            continue;

        JsonNode* member = json_object_get_member(overrides, name);
        if (!member)
            continue;

        JsonNode* value = member;
        const char* type = nullptr;
        if (JSON_NODE_HOLDS_OBJECT(member)) {
            JsonObject* member_object = json_node_get_object(member);
            if (!member_object || !json_object_has_member(member_object, "value"))
                continue;
            value = json_object_get_member(member_object, "value");
            type = json_object_has_member(member_object, "type")
                ? json_object_get_string_member(member_object, "type")
                : nullptr;
        }

        if (!type) {
            auto type_iter = project.user_property_types.find(name);
            if (type_iter != project.user_property_types.end())
                type = type_iter->second.c_str();
        }

        wallpaper::UserPropertyValue parsed_value;
        if (parse_user_property_value_node(value, type, &parsed_value))
            property_iter->second.value = std::move(parsed_value);
    }
}

inline bool ensure_scene_wallpaper(std::unique_ptr<wallpaper::SceneWallpaper>& scene,
                                   const char* cache_dir_name,
                                   const char* log_context,
                                   const SceneProject& project) {
    if (scene || project.scene_path.empty())
        return !project.scene_path.empty();

    g_message("HanabiScene: creating SceneWallpaper for %s", project.scene_path.c_str());
    scene = std::make_unique<wallpaper::SceneWallpaper>();
    if (!scene->init()) {
        g_warning("HanabiScene(%s): failed to initialize scene wallpaper", log_context);
        scene.reset();
        return false;
    }

    g_message("HanabiScene: SceneWallpaper initialized successfully");
    scene->setPropertyString(
        wallpaper::PROPERTY_CACHE_PATH,
        wallpaper::platform::GetCachePath(cache_dir_name).string());
    return true;
}

inline void sync_scene_user_properties(wallpaper::SceneWallpaper& scene,
                                       const SceneProject& project) {
    scene.setPropertyObject(
        wallpaper::PROPERTY_USER_PROPERTIES,
        std::make_shared<wallpaper::UserPropertyMap>(project.user_properties));
}

inline void configure_scene_wallpaper(wallpaper::SceneWallpaper& scene,
                                      const SceneProject& project,
                                      double volume,
                                      gboolean muted,
                                      int fill_mode,
                                      int fps) {
    sync_scene_user_properties(scene, project);
    scene.setPropertyString(wallpaper::PROPERTY_ASSETS, project.assets_path);
    scene.setPropertyString(wallpaper::PROPERTY_SOURCE, project.scene_path);
    scene.setPropertyFloat(wallpaper::PROPERTY_VOLUME, static_cast<float>(volume));
    scene.setPropertyBool(wallpaper::PROPERTY_MUTED, muted);
    scene.setPropertyInt32(
        wallpaper::PROPERTY_FILLMODE,
        static_cast<int32_t>(to_wallpaper_fill_mode(fill_mode)));
    scene.setPropertyInt32(wallpaper::PROPERTY_FPS, fps);
}

} // namespace hanabi::scene
