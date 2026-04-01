#pragma once

#include <gtk/gtk.h>

#include "Swapchain/ExSwapchain.hpp"

gboolean hanabi_scene_dmabuf_frame_can_build_texture(const wallpaper::ExHandle& frame);

GdkTexture* hanabi_scene_dmabuf_texture_new_from_frame(const wallpaper::ExHandle& frame,
                                                       GdkDisplay*               display,
                                                       GdkTexture*               update_texture,
                                                       GError**                  error);
