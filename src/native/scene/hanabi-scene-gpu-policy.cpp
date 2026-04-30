#include "hanabi-scene-gpu-policy.hpp"

#include <glib.h>

#include <string_view>

namespace hanabi::scene {

GpuPipelinePolicy parse_gpu_pipeline_policy(const char* value) {
    const std::string_view policy = value != nullptr ? std::string_view(value) : std::string_view();
    if (policy == "va")
        return GpuPipelinePolicy::Va;
    if (policy == "nvidia-stateless")
        return GpuPipelinePolicy::NvidiaStateless;
    if (policy == "nvidia")
        return GpuPipelinePolicy::Nvidia;

    g_warning("HanabiScene: unknown gpu-pipeline '%s', falling back to nvidia",
              value != nullptr ? value : "(null)");
    return GpuPipelinePolicy::Nvidia;
}

const char* gpu_pipeline_policy_name(GpuPipelinePolicy policy) {
    switch (policy) {
    case GpuPipelinePolicy::Va: return "va";
    case GpuPipelinePolicy::NvidiaStateless: return "nvidia-stateless";
    case GpuPipelinePolicy::Nvidia: return "nvidia";
    }
    return "nvidia";
}

wallpaper::VulkanDevicePreference vulkan_device_preference_for_policy(GpuPipelinePolicy policy) {
    switch (policy) {
    case GpuPipelinePolicy::Va: return wallpaper::VulkanDevicePreference::PreferIntegrated;
    case GpuPipelinePolicy::NvidiaStateless:
    case GpuPipelinePolicy::Nvidia: return wallpaper::VulkanDevicePreference::PreferDiscrete;
    }
    return wallpaper::VulkanDevicePreference::PreferDiscrete;
}

wallpaper::GpuPipelinePreference render_gpu_pipeline_preference_for_policy(GpuPipelinePolicy policy) {
    switch (policy) {
    case GpuPipelinePolicy::Va: return wallpaper::GpuPipelinePreference::Va;
    case GpuPipelinePolicy::NvidiaStateless:
        return wallpaper::GpuPipelinePreference::NvidiaStateless;
    case GpuPipelinePolicy::Nvidia: return wallpaper::GpuPipelinePreference::Nvidia;
    }
    return wallpaper::GpuPipelinePreference::Nvidia;
}

} // namespace hanabi::scene
