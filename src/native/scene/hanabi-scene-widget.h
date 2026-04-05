#pragma once

#include <gtk/gtk.h>

G_BEGIN_DECLS

#define HANABI_SCENE_TYPE_WIDGET (hanabi_scene_widget_get_type())

G_DECLARE_FINAL_TYPE(HanabiSceneWidget, hanabi_scene_widget, HANABI_SCENE, WIDGET, GtkGLArea)

GtkWidget *hanabi_scene_widget_new(void);

void hanabi_scene_widget_set_project_dir(HanabiSceneWidget *self, const char *project_dir);
const char *hanabi_scene_widget_get_project_dir(HanabiSceneWidget *self);

void hanabi_scene_widget_set_user_properties_json(HanabiSceneWidget *self, const char *user_properties_json);
const char *hanabi_scene_widget_get_user_properties_json(HanabiSceneWidget *self);

void hanabi_scene_widget_set_muted(HanabiSceneWidget *self, gboolean muted);
gboolean hanabi_scene_widget_get_muted(HanabiSceneWidget *self);

void hanabi_scene_widget_set_volume(HanabiSceneWidget *self, double volume);
double hanabi_scene_widget_get_volume(HanabiSceneWidget *self);

void hanabi_scene_widget_set_fill_mode(HanabiSceneWidget *self, int fill_mode);
int hanabi_scene_widget_get_fill_mode(HanabiSceneWidget *self);

void hanabi_scene_widget_set_fps(HanabiSceneWidget *self, int fps);
int hanabi_scene_widget_get_fps(HanabiSceneWidget *self);

void hanabi_scene_widget_set_render_scale(HanabiSceneWidget *self, double render_scale);
double hanabi_scene_widget_get_render_scale(HanabiSceneWidget *self);

void hanabi_scene_widget_play(HanabiSceneWidget *self);
void hanabi_scene_widget_pause(HanabiSceneWidget *self);
gboolean hanabi_scene_widget_get_playing(HanabiSceneWidget *self);
gboolean hanabi_scene_widget_get_ready(HanabiSceneWidget *self);
void hanabi_scene_widget_set_mouse_pos(HanabiSceneWidget *self, double x, double y);

G_END_DECLS
