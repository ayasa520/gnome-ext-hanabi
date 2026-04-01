#include "hanabi-scene-dmabuf-texture.h"

#include <gio/gio.h>

#include <array>
#include <cerrno>
#include <cstring>
#include <unistd.h>

namespace {

struct OwnedPlaneFds {
    guint n_planes { 0 };
    std::array<int, wallpaper::ExHandle::MAX_PLANES> fds;

    OwnedPlaneFds() { fds.fill(-1); }
};

void owned_plane_fds_free(gpointer data) {
    auto* owned = static_cast<OwnedPlaneFds*>(data);
    if (!owned)
        return;

    for (guint plane = 0; plane < owned->n_planes; plane++) {
        if (owned->fds[plane] >= 0)
            close(owned->fds[plane]);
    }

    delete owned;
}

} // namespace

gboolean hanabi_scene_dmabuf_frame_can_build_texture(const wallpaper::ExHandle& frame) {
#if GTK_CHECK_VERSION(4, 14, 0)
    return frame.isDmabuf() && frame.width > 0 && frame.height > 0 && frame.drm_fourcc != 0 &&
        frame.drm_modifier != wallpaper::ExHandle::INVALID_DRM_MODIFIER && frame.n_planes > 0;
#else
    return FALSE;
#endif
}

GdkTexture* hanabi_scene_dmabuf_texture_new_from_frame(const wallpaper::ExHandle& frame,
                                                       GdkDisplay*               display,
                                                       GdkTexture*               update_texture,
                                                       GError**                  error) {
#if GTK_CHECK_VERSION(4, 14, 0)
    if (!hanabi_scene_dmabuf_frame_can_build_texture(frame)) {
        g_set_error_literal(
            error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED, "frame is not importable as dma-buf");
        return nullptr;
    }

    if (!display) {
        g_set_error_literal(
            error, G_IO_ERROR, G_IO_ERROR_FAILED, "a GdkDisplay is required for dma-buf import");
        return nullptr;
    }

    auto* owned = new OwnedPlaneFds();
    owned->n_planes = frame.n_planes;

    for (guint plane = 0; plane < frame.n_planes; plane++) {
        const int fd = dup(frame.planes[plane].fd);
        if (fd < 0) {
            g_set_error(error,
                        G_IO_ERROR,
                        g_io_error_from_errno(errno),
                        "failed to duplicate dma-buf fd: %s",
                        std::strerror(errno));
            owned_plane_fds_free(owned);
            return nullptr;
        }

        owned->fds[plane] = fd;
    }

    auto* builder = gdk_dmabuf_texture_builder_new();
    gdk_dmabuf_texture_builder_set_display(builder, display);
    gdk_dmabuf_texture_builder_set_width(builder, frame.width);
    gdk_dmabuf_texture_builder_set_height(builder, frame.height);
    gdk_dmabuf_texture_builder_set_fourcc(builder, frame.drm_fourcc);
    gdk_dmabuf_texture_builder_set_modifier(builder, frame.drm_modifier);
    gdk_dmabuf_texture_builder_set_premultiplied(builder, frame.premultiplied);
    gdk_dmabuf_texture_builder_set_n_planes(builder, frame.n_planes);

    if (update_texture)
        gdk_dmabuf_texture_builder_set_update_texture(builder, update_texture);

    for (guint plane = 0; plane < frame.n_planes; plane++) {
        gdk_dmabuf_texture_builder_set_fd(builder, plane, owned->fds[plane]);
        gdk_dmabuf_texture_builder_set_stride(builder, plane, frame.planes[plane].stride);
        gdk_dmabuf_texture_builder_set_offset(builder, plane, frame.planes[plane].offset);
    }

    auto* texture = gdk_dmabuf_texture_builder_build(builder, owned_plane_fds_free, owned, error);
    g_object_unref(builder);
    return texture;
#else
    g_set_error_literal(
        error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED, "GTK build is missing dma-buf texture APIs");
    return nullptr;
#endif
}
