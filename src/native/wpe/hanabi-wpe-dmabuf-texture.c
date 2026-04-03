#include "hanabi-wpe-dmabuf-texture.h"

#include <errno.h>
#include <gio/gio.h>
#include <unistd.h>

typedef struct {
    guint n_planes;
    int*  fds;
} HanabiWpeOwnedPlaneFds;

static void
hanabi_wpe_owned_plane_fds_free(gpointer data)
{
    HanabiWpeOwnedPlaneFds* owned = data;
    if (!owned)
        return;

    for (guint plane = 0; plane < owned->n_planes; plane++) {
        if (owned->fds[plane] >= 0)
            close(owned->fds[plane]);
    }

    g_free(owned->fds);
    g_free(owned);
}

gboolean
hanabi_wpe_dmabuf_buffer_can_build_texture(WPEBufferDMABuf* buffer)
{
#if GTK_CHECK_VERSION(4, 14, 0)
    return buffer != NULL &&
        wpe_buffer_get_width(WPE_BUFFER(buffer)) > 0 &&
        wpe_buffer_get_height(WPE_BUFFER(buffer)) > 0 &&
        wpe_buffer_dma_buf_get_format(buffer) != 0 &&
        wpe_buffer_dma_buf_get_n_planes(buffer) > 0;
#else
    return FALSE;
#endif
}

GdkTexture*
hanabi_wpe_dmabuf_texture_new_from_buffer(WPEBufferDMABuf* buffer,
                                          GdkDisplay*      display,
                                          GdkTexture*      update_texture,
                                          GError**         error)
{
#if GTK_CHECK_VERSION(4, 14, 0)
    if (!hanabi_wpe_dmabuf_buffer_can_build_texture(buffer)) {
        g_set_error_literal(
            error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED, "buffer is not importable as dma-buf");
        return NULL;
    }

    if (!display) {
        g_set_error_literal(
            error, G_IO_ERROR, G_IO_ERROR_FAILED, "a GdkDisplay is required for dma-buf import");
        return NULL;
    }

    guint n_planes = wpe_buffer_dma_buf_get_n_planes(buffer);

    HanabiWpeOwnedPlaneFds* owned = g_new0(HanabiWpeOwnedPlaneFds, 1);
    owned->n_planes = n_planes;
    owned->fds = g_new(gint, n_planes);
    for (guint plane = 0; plane < n_planes; plane++)
        owned->fds[plane] = -1;

    for (guint plane = 0; plane < n_planes; plane++) {
        int fd = dup(wpe_buffer_dma_buf_get_fd(buffer, plane));
        if (fd < 0) {
            g_set_error(error,
                        G_IO_ERROR,
                        g_io_error_from_errno(errno),
                        "failed to duplicate dma-buf fd: %s",
                        g_strerror(errno));
            hanabi_wpe_owned_plane_fds_free(owned);
            return NULL;
        }

        owned->fds[plane] = fd;
    }

    GdkDmabufTextureBuilder* builder = gdk_dmabuf_texture_builder_new();
    gdk_dmabuf_texture_builder_set_display(builder, display);
    gdk_dmabuf_texture_builder_set_width(builder, wpe_buffer_get_width(WPE_BUFFER(buffer)));
    gdk_dmabuf_texture_builder_set_height(builder, wpe_buffer_get_height(WPE_BUFFER(buffer)));
    gdk_dmabuf_texture_builder_set_fourcc(builder, wpe_buffer_dma_buf_get_format(buffer));
    gdk_dmabuf_texture_builder_set_modifier(builder, wpe_buffer_dma_buf_get_modifier(buffer));
    gdk_dmabuf_texture_builder_set_n_planes(builder, n_planes);

    if (update_texture)
        gdk_dmabuf_texture_builder_set_update_texture(builder, update_texture);

    for (guint plane = 0; plane < n_planes; plane++) {
        gdk_dmabuf_texture_builder_set_fd(builder, plane, owned->fds[plane]);
        gdk_dmabuf_texture_builder_set_offset(
            builder, plane, wpe_buffer_dma_buf_get_offset(buffer, plane));
        gdk_dmabuf_texture_builder_set_stride(
            builder, plane, wpe_buffer_dma_buf_get_stride(buffer, plane));
    }

    GdkTexture* texture = gdk_dmabuf_texture_builder_build(
        builder, hanabi_wpe_owned_plane_fds_free, owned, error);
    g_object_unref(builder);
    return texture;
#else
    g_set_error_literal(
        error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED, "GTK build is missing dma-buf texture APIs");
    return NULL;
#endif
}
