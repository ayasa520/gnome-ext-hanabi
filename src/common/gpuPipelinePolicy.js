const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

var GpuPipeline = {
    AUTO: 'auto',
    NVIDIA: 'nvidia',
    NVIDIA_STATELESS: 'nvidia-stateless',
    VA: 'va',
};

var NvidiaVendorId = '0x10de';

var normalizeGpuPipeline = value => {
    switch (`${value ?? ''}`.trim().toLowerCase()) {
    case GpuPipeline.VA:
    case GpuPipeline.NVIDIA:
    case GpuPipeline.NVIDIA_STATELESS:
    case GpuPipeline.AUTO:
        return `${value}`.trim().toLowerCase();
    default:
        return GpuPipeline.AUTO;
    }
};

var isNvidiaPipeline = pipeline => {
    const normalized = normalizeGpuPipeline(pipeline);
    return normalized === GpuPipeline.NVIDIA ||
        normalized === GpuPipeline.NVIDIA_STATELESS;
};

var readTextFile = path => {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(contents).trim();
    } catch (_e) {
        return null;
    }
};

var findDrmCardByVendor = vendorId => {
    const drmDir = Gio.File.new_for_path('/sys/class/drm');
    if (!drmDir.query_exists(null))
        return null;

    let fileEnum = null;
    try {
        fileEnum = drmDir.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        let info;
        while ((info = fileEnum.next_file(null))) {
            const name = info.get_name();
            if (!/^card\d+$/.test(name))
                continue;

            const vendor = readTextFile(`/sys/class/drm/${name}/device/vendor`)?.toLowerCase();
            if (vendor === vendorId.toLowerCase())
                return `/dev/dri/${name}`;
        }
    } catch (_e) {
        return null;
    } finally {
        try {
            fileEnum?.close(null);
        } catch (_e) {
        }
    }

    return null;
};

var hasGstElementFactoryByInspect = factoryName => {
    if (!factoryName || !GLib.find_program_in_path('gst-inspect-1.0'))
        return false;

    try {
        const subprocess = Gio.Subprocess.new(
            ['gst-inspect-1.0', factoryName],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        return subprocess.wait_check(null);
    } catch (_e) {
        return false;
    }
};

var resolveGpuPipeline = (pipeline, hasFactory = hasGstElementFactoryByInspect) => {
    const normalized = normalizeGpuPipeline(pipeline);
    if (normalized !== GpuPipeline.AUTO)
        return normalized;

    if (hasFactory('nvh264dec'))
        return GpuPipeline.NVIDIA;
    if (hasFactory('nvh264sldec'))
        return GpuPipeline.NVIDIA_STATELESS;
    if (hasFactory('vah264dec') && hasFactory('vapostproc'))
        return GpuPipeline.VA;

    return GpuPipeline.NVIDIA;
};

var buildRendererEnvironment = (pipeline, options = {}) => {
    const resolved = resolveGpuPipeline(
        pipeline,
        options.hasFactory ?? hasGstElementFactoryByInspect
    );
    const environment = {};

    if (!isNvidiaPipeline(resolved))
        return {resolved, environment};

    // These variables must be set before GJS loads GTK/GDK/WPE. They make the renderer's
    // presentation stack follow the same NVIDIA device selected for the decode/render pipeline.
    environment.DRI_PRIME = '1';
    environment.__NV_PRIME_RENDER_OFFLOAD = '1';
    environment.__GLX_VENDOR_LIBRARY_NAME = 'nvidia';
    environment.__VK_LAYER_NV_optimus = 'NVIDIA_only';

    const nvidiaDrmDevice = findDrmCardByVendor(NvidiaVendorId);
    if (nvidiaDrmDevice) {
        // Headless WPE chooses a DRM device independently from GTK. Keep it on the NVIDIA
        // DRM node too, otherwise WPE may produce Intel-modified dma-bufs that GDK/NVIDIA
        // rejects as unsupported.
        environment.WPE_DRM_DEVICE = nvidiaDrmDevice;
    }

    return {resolved, environment};
};

var applyEnvironmentToLauncher = (launcher, pipeline, options = {}) => {
    const policy = buildRendererEnvironment(pipeline, options);
    Object.entries(policy.environment).forEach(([name, value]) => {
        launcher.setenv(name, value);
    });
    return policy;
};

var environmentToEnvVector = environment => {
    return Object.entries(environment).map(([name, value]) => `${name}=${value}`);
};
