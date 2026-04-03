#include "hanabi-wpe-paintable.h"

#include "hanabi-wpe-dmabuf-texture.h"

#include <gio/gio.h>

struct _HanabiWpePaintable {
    GObject parent_instance;

    GdkTexture* current_texture;
    gint        intrinsic_width;
    gint        intrinsic_height;
};

static GParamSpec* properties[2] = {NULL, NULL};

static gboolean
hanabi_wpe_is_little_endian(void)
{
    const guint32 value = 0x01020304;
    return ((const guint8*)&value)[0] == 0x04;
}

static GdkMemoryFormat
hanabi_wpe_memory_format_from_shm(WPEBufferSHM* buffer)
{
    switch (wpe_buffer_shm_get_format(buffer)) {
    case WPE_PIXEL_FORMAT_ARGB8888:
    default:
        return hanabi_wpe_is_little_endian()
            ? GDK_MEMORY_B8G8R8A8_PREMULTIPLIED
            : GDK_MEMORY_A8R8G8B8_PREMULTIPLIED;
    }
}

static GdkTexture*
hanabi_wpe_texture_new_from_buffer(WPEBuffer*  buffer,
                                   GdkDisplay* display,
                                   GError**    error)
{
    const gint width = wpe_buffer_get_width(buffer);
    const gint height = wpe_buffer_get_height(buffer);
    if (width <= 0 || height <= 0) {
        g_set_error_literal(
            error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT, "buffer has invalid dimensions");
        return NULL;
    }

    if (WPE_IS_BUFFER_DMA_BUF(buffer))
        return hanabi_wpe_dmabuf_texture_new_from_buffer(
            WPE_BUFFER_DMA_BUF(buffer), display, NULL, error);

    if (WPE_IS_BUFFER_SHM(buffer)) {
        WPEBufferSHM* shm = WPE_BUFFER_SHM(buffer);
        GBytes* bytes = wpe_buffer_shm_get_data(shm);
        if (!bytes) {
            g_set_error_literal(
                error, G_IO_ERROR, G_IO_ERROR_FAILED, "failed to get shm buffer bytes");
            return NULL;
        }

        return gdk_memory_texture_new(
            width,
            height,
            hanabi_wpe_memory_format_from_shm(shm),
            bytes,
            wpe_buffer_shm_get_stride(shm));
    }

    g_autoptr(GBytes) bytes = wpe_buffer_import_to_pixels(buffer, error);
    if (!bytes)
        return NULL;

    return gdk_memory_texture_new(
        width,
        height,
        hanabi_wpe_is_little_endian()
            ? GDK_MEMORY_B8G8R8A8_PREMULTIPLIED
            : GDK_MEMORY_A8R8G8B8_PREMULTIPLIED,
        bytes,
        width * 4);
}

static void
hanabi_wpe_paintable_snapshot(GdkPaintable* paintable,
                              GdkSnapshot*  snapshot,
                              gdouble       width,
                              gdouble       height)
{
    HanabiWpePaintable* self = HANABI_WPE_PAINTABLE(paintable);
    if (!self->current_texture)
        return;

    graphene_rect_t bounds;
    graphene_rect_init(&bounds, 0.0f, 0.0f, (gfloat)width, (gfloat)height);
    gtk_snapshot_append_texture(GTK_SNAPSHOT(snapshot), self->current_texture, &bounds);
}

static GdkPaintable*
hanabi_wpe_paintable_get_current_image(GdkPaintable* paintable)
{
    HanabiWpePaintable* self = HANABI_WPE_PAINTABLE(paintable);
    if (self->current_texture)
        return GDK_PAINTABLE(g_object_ref(self->current_texture));

    return gdk_paintable_new_empty(MAX(1, self->intrinsic_width), MAX(1, self->intrinsic_height));
}

static GdkPaintableFlags
hanabi_wpe_paintable_get_flags(GdkPaintable* _paintable)
{
    return (GdkPaintableFlags)0;
}

static gint
hanabi_wpe_paintable_get_intrinsic_width(GdkPaintable* paintable)
{
    return HANABI_WPE_PAINTABLE(paintable)->intrinsic_width;
}

static gint
hanabi_wpe_paintable_get_intrinsic_height(GdkPaintable* paintable)
{
    return HANABI_WPE_PAINTABLE(paintable)->intrinsic_height;
}

static gdouble
hanabi_wpe_paintable_get_intrinsic_aspect_ratio(GdkPaintable* paintable)
{
    HanabiWpePaintable* self = HANABI_WPE_PAINTABLE(paintable);
    if (self->intrinsic_width <= 0 || self->intrinsic_height <= 0)
        return 0.0;

    return (gdouble)self->intrinsic_width / (gdouble)self->intrinsic_height;
}

static void
hanabi_wpe_paintable_paintable_init(GdkPaintableInterface* iface)
{
    iface->snapshot = hanabi_wpe_paintable_snapshot;
    iface->get_current_image = hanabi_wpe_paintable_get_current_image;
    iface->get_flags = hanabi_wpe_paintable_get_flags;
    iface->get_intrinsic_width = hanabi_wpe_paintable_get_intrinsic_width;
    iface->get_intrinsic_height = hanabi_wpe_paintable_get_intrinsic_height;
    iface->get_intrinsic_aspect_ratio = hanabi_wpe_paintable_get_intrinsic_aspect_ratio;
}

G_DEFINE_TYPE_WITH_CODE(HanabiWpePaintable,
                        hanabi_wpe_paintable,
                        G_TYPE_OBJECT,
                        G_IMPLEMENT_INTERFACE(
                            GDK_TYPE_PAINTABLE,
                            hanabi_wpe_paintable_paintable_init))

static void
hanabi_wpe_paintable_dispose(GObject* object)
{
    HanabiWpePaintable* self = HANABI_WPE_PAINTABLE(object);
    g_clear_object(&self->current_texture);
    G_OBJECT_CLASS(hanabi_wpe_paintable_parent_class)->dispose(object);
}

static void
hanabi_wpe_paintable_get_property(GObject*    object,
                                  guint       prop_id,
                                  GValue*     value,
                                  GParamSpec* pspec)
{
    HanabiWpePaintable* self = HANABI_WPE_PAINTABLE(object);

    switch (prop_id) {
    case 1:
        g_value_set_boolean(value, self->current_texture != NULL);
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
    }
}

static void
hanabi_wpe_paintable_class_init(HanabiWpePaintableClass* klass)
{
    GObjectClass* object_class = G_OBJECT_CLASS(klass);
    object_class->dispose = hanabi_wpe_paintable_dispose;
    object_class->get_property = hanabi_wpe_paintable_get_property;

    properties[1] = g_param_spec_boolean("ready",
                                         NULL,
                                         NULL,
                                         FALSE,
                                         (GParamFlags)(G_PARAM_READABLE | G_PARAM_EXPLICIT_NOTIFY));
    g_object_class_install_properties(object_class, G_N_ELEMENTS(properties), properties);
}

static void
hanabi_wpe_paintable_init(HanabiWpePaintable* self)
{
    self->intrinsic_width = 0;
    self->intrinsic_height = 0;
}

HanabiWpePaintable*
hanabi_wpe_paintable_new(void)
{
    return HANABI_WPE_PAINTABLE(g_object_new(HANABI_WPE_TYPE_PAINTABLE, NULL));
}

gboolean
hanabi_wpe_paintable_update_from_buffer(HanabiWpePaintable* self,
                                        WPEBuffer*          buffer,
                                        GdkDisplay*         display,
                                        GError**            error)
{
    g_return_val_if_fail(HANABI_WPE_IS_PAINTABLE(self), FALSE);
    g_return_val_if_fail(WPE_IS_BUFFER(buffer), FALSE);
    g_return_val_if_fail(GDK_IS_DISPLAY(display), FALSE);

    g_autoptr(GdkTexture) next_texture =
        hanabi_wpe_texture_new_from_buffer(buffer, display, error);
    if (!next_texture)
        return FALSE;

    const gint next_width = gdk_texture_get_width(next_texture);
    const gint next_height = gdk_texture_get_height(next_texture);
    const gboolean size_changed =
        next_width != self->intrinsic_width || next_height != self->intrinsic_height;
    const gboolean was_ready = self->current_texture != NULL;

    g_clear_object(&self->current_texture);
    self->current_texture = g_object_ref(next_texture);
    self->intrinsic_width = next_width;
    self->intrinsic_height = next_height;

    if (!was_ready)
        g_object_notify_by_pspec(G_OBJECT(self), properties[1]);
    if (size_changed)
        gdk_paintable_invalidate_size(GDK_PAINTABLE(self));
    gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
    return TRUE;
}

void
hanabi_wpe_paintable_clear(HanabiWpePaintable* self)
{
    g_return_if_fail(HANABI_WPE_IS_PAINTABLE(self));

    const gboolean was_ready = self->current_texture != NULL;
    g_clear_object(&self->current_texture);
    self->intrinsic_width = 0;
    self->intrinsic_height = 0;
    if (was_ready)
        g_object_notify_by_pspec(G_OBJECT(self), properties[1]);
    gdk_paintable_invalidate_size(GDK_PAINTABLE(self));
    gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
}

gboolean
hanabi_wpe_paintable_get_ready(HanabiWpePaintable* self)
{
    g_return_val_if_fail(HANABI_WPE_IS_PAINTABLE(self), FALSE);
    return self->current_texture != NULL;
}
