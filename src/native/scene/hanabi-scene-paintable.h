#pragma once

#include <gtk/gtk.h>

G_BEGIN_DECLS

#define HANABI_SCENE_TYPE_PAINTABLE (hanabi_scene_paintable_get_type())

G_DECLARE_FINAL_TYPE(HanabiScenePaintable,
                     hanabi_scene_paintable,
                     HANABI_SCENE,
                     PAINTABLE,
                     GObject)

HanabiScenePaintable* hanabi_scene_paintable_new(void);
gboolean              hanabi_scene_paintable_is_supported(void);

void        hanabi_scene_paintable_set_project_dir(HanabiScenePaintable* self, const char* project_dir);
const char* hanabi_scene_paintable_get_project_dir(HanabiScenePaintable* self);
gboolean    hanabi_scene_paintable_reload_project(HanabiScenePaintable* self,
                                                  const char* project_dir,
                                                  const char* user_properties_json);

void        hanabi_scene_paintable_set_user_properties_json(HanabiScenePaintable* self, const char* user_properties_json);
const char* hanabi_scene_paintable_get_user_properties_json(HanabiScenePaintable* self);
void        hanabi_scene_paintable_set_media_state_json(HanabiScenePaintable* self, const char* media_state_json);
void        hanabi_scene_paintable_set_audio_samples(HanabiScenePaintable* self, GVariant* audio_samples);

void     hanabi_scene_paintable_set_muted(HanabiScenePaintable* self, gboolean muted);
gboolean hanabi_scene_paintable_get_muted(HanabiScenePaintable* self);

void   hanabi_scene_paintable_set_volume(HanabiScenePaintable* self, double volume);
double hanabi_scene_paintable_get_volume(HanabiScenePaintable* self);

void hanabi_scene_paintable_set_fill_mode(HanabiScenePaintable* self, int fill_mode);
int  hanabi_scene_paintable_get_fill_mode(HanabiScenePaintable* self);

void hanabi_scene_paintable_set_fps(HanabiScenePaintable* self, int fps);
int  hanabi_scene_paintable_get_fps(HanabiScenePaintable* self);

void   hanabi_scene_paintable_set_render_scale(HanabiScenePaintable* self, double render_scale);
double hanabi_scene_paintable_get_render_scale(HanabiScenePaintable* self);

void     hanabi_scene_paintable_play(HanabiScenePaintable* self);
void     hanabi_scene_paintable_pause(HanabiScenePaintable* self);
gboolean hanabi_scene_paintable_get_playing(HanabiScenePaintable* self);
gboolean hanabi_scene_paintable_get_ready(HanabiScenePaintable* self);

void hanabi_scene_paintable_set_mouse_pos(HanabiScenePaintable* self, double x, double y);
void hanabi_scene_paintable_set_cursor_left_down(HanabiScenePaintable* self, gboolean down);

G_END_DECLS
