import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const ProjectType = {
    VIDEO: 'video',
    WEB: 'web',
    SCENE: 'scene',
};

function readJsonFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;

        return JSON.parse(new TextDecoder().decode(contents));
    } catch (e) {
        return null;
    }
}

function resolveProjectType(project) {
    const type = `${project?.type ?? ''}`.toLowerCase();
    switch (type) {
    case ProjectType.VIDEO:
    case ProjectType.WEB:
    case ProjectType.SCENE:
        return type;
    default:
        return null;
    }
}

function resolveEntryFile(project, type) {
    if (typeof project?.file === 'string' && project.file !== '')
        return project.file;

    if (type === ProjectType.WEB)
        return 'index.html';

    return null;
}

function resolveRegularFile(projectDirPath, relativePath) {
    if (!relativePath)
        return null;

    const filePath = GLib.build_filenamev([projectDirPath, relativePath]);
    const file = Gio.File.new_for_path(filePath);
    if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.REGULAR)
        return null;

    return filePath;
}

function resolvePreviewFile(projectDirPath, project) {
    const candidates = [
        'preview.gif',
        project?.preview,
        'preview.jpg',
        'preview.jpeg',
        'preview.png',
        'preview.webp',
    ].filter(Boolean);

    for (const candidate of candidates) {
        const previewPath = resolveRegularFile(projectDirPath, candidate);
        if (previewPath)
            return previewPath;
    }

    return null;
}

function resolveProjectTitle(projectDirPath, project) {
    const title = typeof project?.title === 'string' ? project.title.trim() : '';
    if (title)
        return title;

    return GLib.path_get_basename(projectDirPath);
}

export function loadProject(projectDirPath) {
    if (!projectDirPath)
        return null;

    const projectDir = Gio.File.new_for_path(projectDirPath);
    if (projectDir.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY)
        return null;

    const projectJsonPath = GLib.build_filenamev([projectDirPath, 'project.json']);
    const project = readJsonFile(projectJsonPath);
    if (!project)
        return null;

    const type = resolveProjectType(project);
    if (!type)
        return null;

    const entry = resolveEntryFile(project, type);
    let entryPath = resolveRegularFile(projectDirPath, entry);
    if (type === ProjectType.SCENE && !entryPath)
        entryPath = resolveRegularFile(projectDirPath, 'scene.pkg');
    if (entry && !entryPath && type !== ProjectType.SCENE)
        return null;

    const previewPath = resolvePreviewFile(projectDirPath, project);
    const tags = Array.isArray(project?.tags)
        ? project.tags.filter(tag => typeof tag === 'string' && tag !== '')
        : [];

    return {
        path: projectDirPath,
        basename: GLib.path_get_basename(projectDirPath),
        title: resolveProjectTitle(projectDirPath, project),
        description: typeof project?.description === 'string' ? project.description : '',
        tags,
        workshopId: project?.workshopid ?? null,
        type,
        entryPath,
        previewPath,
    };
}

export function listProjects(parentDirPath) {
    const projects = [];
    if (!parentDirPath)
        return projects;

    const dir = Gio.File.new_for_path(parentDirPath);
    if (dir.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY)
        return projects;

    const enumerator = dir.enumerate_children(
        'standard::*',
        Gio.FileQueryInfoFlags.NONE,
        null
    );

    let info;
    while ((info = enumerator.next_file(null))) {
        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            continue;

        const child = dir.get_child(info.get_name());
        const project = loadProject(child.get_path());
        if (project)
            projects.push(project);
    }

    return projects.sort((a, b) => a.path.localeCompare(b.path));
}
