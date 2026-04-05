import GLib from 'gi://GLib';

const moduleDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const commonDir = GLib.build_filenamev([moduleDir, 'common']);
if (!imports.searchPath.some(path => path === commonDir))
    imports.searchPath.unshift(commonDir);

const ProjectLoader = imports.projectLoader;

export const ProjectType = ProjectLoader.ProjectType;
export const ScenePropertyType = ProjectLoader.ScenePropertyType;
export const SceneUserPropertyStoreKey = ProjectLoader.SceneUserPropertyStoreKey;
export const areScenePropertyValuesEqual = ProjectLoader.areScenePropertyValuesEqual;
export const buildScenePropertyValueMap = ProjectLoader.buildScenePropertyValueMap;
export const buildSceneUserPropertyPayload = ProjectLoader.buildSceneUserPropertyPayload;
export const evaluateScenePropertyExpression = ProjectLoader.evaluateScenePropertyExpression;
export const getProjectScenePropertyOverrides = ProjectLoader.getProjectScenePropertyOverrides;
export const isScenePropertyVisible = ProjectLoader.isScenePropertyVisible;
export const loadProject = ProjectLoader.loadProject;
export const listProjects = ProjectLoader.listProjects;
export const normalizeScenePropertyValue = ProjectLoader.normalizeScenePropertyValue;
export const parseStoredScenePropertyOverrides = ProjectLoader.parseStoredScenePropertyOverrides;
export const resolveProjectConfigId = ProjectLoader.resolveProjectConfigId;
export const resolveScenePropertyValue = ProjectLoader.resolveScenePropertyValue;
export const serializeStoredScenePropertyOverrides = ProjectLoader.serializeStoredScenePropertyOverrides;
export const setProjectScenePropertyOverrides = ProjectLoader.setProjectScenePropertyOverrides;
