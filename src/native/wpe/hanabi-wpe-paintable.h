#pragma once

#include <gtk/gtk.h>
#include <wpe/wpe-platform.h>

G_BEGIN_DECLS

#define HANABI_WPE_TYPE_PAINTABLE (hanabi_wpe_paintable_get_type())

G_DECLARE_FINAL_TYPE(HanabiWpePaintable,
                     hanabi_wpe_paintable,
                     HANABI_WPE,
                     PAINTABLE,
                     GObject)

HanabiWpePaintable* hanabi_wpe_paintable_new(void);

gboolean hanabi_wpe_paintable_update_from_buffer(HanabiWpePaintable* self,
                                                 WPEBuffer*          buffer,
                                                 GdkDisplay*         display,
                                                 GError**            error);

void hanabi_wpe_paintable_clear(HanabiWpePaintable* self);

gboolean hanabi_wpe_paintable_get_ready(HanabiWpePaintable* self);

G_END_DECLS
