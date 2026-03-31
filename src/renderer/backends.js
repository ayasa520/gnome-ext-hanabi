const GLib = imports.gi.GLib;
const System = imports.system;

let backendDir = imports.searchPath
    .map(path => GLib.build_filenamev([path, 'backend']))
    .find(path => GLib.file_test(path, GLib.FileTest.IS_DIR));

if (!backendDir) {
    backendDir = GLib.build_filenamev([
        GLib.path_get_dirname(System.programInvocationName),
        'backend',
    ]);
}

if (!imports.searchPath.some(path => path === backendDir))
    imports.searchPath.unshift(backendDir);

const BackendCommon = imports.common;
const BackendBase = imports.base;
const BackendVideo = imports.video;
const BackendWeb = imports.web;
const BackendScene = imports.scene;

var createBackendFactory = env => {
    const helpers = BackendCommon.createBackendHelpers(env);
    const baseClasses = BackendBase.createBaseBackendClasses(env, helpers);
    const VideoBackend = BackendVideo.createVideoBackendClass(env, helpers, baseClasses);
    const WebBackend = BackendWeb.createWebBackendClass(env, helpers, baseClasses);
    const SceneBackend = BackendScene.createSceneBackendClass(env, helpers, baseClasses);
    const {InvalidProjectBackend} = baseClasses;
    const {ProjectType} = env;

    return (renderer, project) => {
        switch (project?.type) {
        case ProjectType.VIDEO:
            return new VideoBackend(renderer, project);
        case ProjectType.WEB:
            return new WebBackend(renderer, project);
        case ProjectType.SCENE:
            return new SceneBackend(renderer, project);
        default:
            return new InvalidProjectBackend(renderer, project);
        }
    };
};
