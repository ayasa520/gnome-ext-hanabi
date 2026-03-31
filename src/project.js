import GLib from 'gi://GLib';

const moduleDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const commonDir = GLib.build_filenamev([moduleDir, 'common']);
if (!imports.searchPath.some(path => path === commonDir))
    imports.searchPath.unshift(commonDir);

const ProjectLoader = imports.projectLoader;

export const ProjectType = ProjectLoader.ProjectType;
export const loadProject = ProjectLoader.loadProject;
export const listProjects = ProjectLoader.listProjects;
