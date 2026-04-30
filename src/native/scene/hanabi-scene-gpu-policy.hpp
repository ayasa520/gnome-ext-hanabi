#pragma once

#include "SceneWallpaperSurface.hpp"

namespace hanabi::scene {

enum class GpuPipelinePolicy {
    Nvidia,
    NvidiaStateless,
    Va,
};

GpuPipelinePolicy parse_gpu_pipeline_policy(const char* value);
const char* gpu_pipeline_policy_name(GpuPipelinePolicy policy);
wallpaper::VulkanDevicePreference vulkan_device_preference_for_policy(GpuPipelinePolicy policy);
wallpaper::GpuPipelinePreference render_gpu_pipeline_preference_for_policy(GpuPipelinePolicy policy);

} // namespace hanabi::scene
