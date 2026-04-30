#!/usr/bin/env gjs -m

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const moduleDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
if (!imports.searchPath.some(path => path === moduleDir))
    imports.searchPath.unshift(moduleDir);

const GpuPipelinePolicy = imports.gpuPipelinePolicy;
const schemaId = 'io.github.jeffshee.hanabi-extension';

function readConfiguredPipeline() {
    try {
        return Gio.Settings.new(schemaId).get_string('gpu-pipeline');
    } catch (_e) {
        return GpuPipelinePolicy.GpuPipeline.AUTO;
    }
}

const {environment} = GpuPipelinePolicy.buildRendererEnvironment(readConfiguredPipeline());
Object.entries(environment).forEach(([name, value]) => {
    print(`export ${name}=${GLib.shell_quote(value)};`);
});
