#pragma once

#include <gtk/gtk.h>
#include <wpe/wpe-platform.h>

G_BEGIN_DECLS

/**
 * hanabi_wpe_dmabuf_buffer_can_build_texture:
 * @buffer: a #WPEBufferDMABuf
 *
 * Returns whether @buffer contains enough metadata to build a #GdkTexture.
 *
 * Returns: %TRUE if the buffer can be imported as a dma-buf texture
 */
gboolean hanabi_wpe_dmabuf_buffer_can_build_texture(WPEBufferDMABuf* buffer);

/**
 * hanabi_wpe_dmabuf_texture_new_from_buffer:
 * @buffer: a #WPEBufferDMABuf
 * @display: a #GdkDisplay
 * @update_texture: (nullable) (transfer none): an existing texture to update, or %NULL
 * @error: (nullable): return location for a #GError, or %NULL
 *
 * Imports a WPE dma-buf buffer into a new #GdkTexture.
 *
 * Returns: (transfer full) (nullable): a newly imported #GdkTexture, or %NULL on error
 */
GdkTexture* hanabi_wpe_dmabuf_texture_new_from_buffer(WPEBufferDMABuf* buffer,
                                                      GdkDisplay*      display,
                                                      GdkTexture*      update_texture,
                                                      GError**         error);

G_END_DECLS
