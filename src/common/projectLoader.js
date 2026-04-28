const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const wallpaperEngineWorkshopAppId = '431960';

var ProjectType = {
    VIDEO: 'video',
    WEB: 'web',
    SCENE: 'scene',
};

var ScenePropertyType = {
    BOOL: 'bool',
    COLOR: 'color',
    COMBO: 'combo',
    DIRECTORY: 'directory',
    FILE: 'file',
    GROUP: 'group',
    SCENE_TEXTURE: 'scenetexture',
    SLIDER: 'slider',
    TEXT: 'text',
    TEXT_INPUT: 'textinput',
};

// Web and scene wallpapers both use Wallpaper Engine user properties, so one
// neutral GSettings key is the only persisted source of truth for overrides.
var UserPropertyStoreKey = 'user-properties';
var ProjectBrowserFilterKey = {
    STATE: 'project-browser-filter-state',
};
var ProjectContentRatings = [
    'Everyone',
    'Questionable',
    'Mature',
];
var ProjectGenrePresets = [
    'Abstract',
    'Animal',
    'Anime',
    'Cartoon',
    'CGI',
    'Cyberpunk',
    'Fantasy',
    'Game',
    'Girls',
    'Guys',
    'Landscape',
    'Medieval',
    'Memes',
    'MMD',
    'Music',
    'Nature',
    'Pixel art',
    'Relaxing',
    'Retro',
    'Sci-Fi',
    'Sports',
    'Technology',
    'Television',
    'Vehicle',
    'Unspecified',
];

const projectGenrePresetIndex = new Map(
    ProjectGenrePresets.map((tag, index) => [tag, index])
);

const scenePropertyStringTypes = new Set([
    ScenePropertyType.COLOR,
    ScenePropertyType.COMBO,
    ScenePropertyType.DIRECTORY,
    ScenePropertyType.FILE,
    ScenePropertyType.GROUP,
    ScenePropertyType.SCENE_TEXTURE,
    ScenePropertyType.TEXT,
    ScenePropertyType.TEXT_INPUT,
]);

const scenePropertyEditableTypes = new Set([
    ScenePropertyType.BOOL,
    ScenePropertyType.COLOR,
    ScenePropertyType.COMBO,
    ScenePropertyType.DIRECTORY,
    ScenePropertyType.FILE,
    ScenePropertyType.SCENE_TEXTURE,
    ScenePropertyType.SLIDER,
    ScenePropertyType.TEXT_INPUT,
]);

function readJsonFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;

        return JSON.parse(new TextDecoder().decode(contents));
    } catch (_e) {
        return null;
    }
}

function isDirectoryPath(path) {
    if (!path)
        return false;

    const file = Gio.File.new_for_path(path);
    return file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY;
}

function canonicalizeDirectoryPath(path) {
    if (!path)
        return '';

    const file = Gio.File.new_for_path(path);
    try {
        return file.get_path() ?? path;
    } catch (_e) {
        return path;
    }
}

function hasWallpaperEngineInstall(steamLibraryPath) {
    if (!steamLibraryPath)
        return false;

    return isDirectoryPath(GLib.build_filenamev([
        steamLibraryPath,
        'steamapps',
        'common',
        'wallpaper_engine',
    ]));
}

function normalizeLibraryRootPath(path) {
    if (!path)
        return '';

    let current = canonicalizeDirectoryPath(path);
    while (current) {
        if (hasWallpaperEngineInstall(current))
            return current;

        const parent = GLib.path_get_dirname(current);
        if (!parent || parent === current)
            break;
        current = parent;
    }

    return canonicalizeDirectoryPath(path);
}

function getSteamWorkshopDirs(steamLibraryPath) {
    return [
        ['steamapps', 'workshop', 'content', wallpaperEngineWorkshopAppId],
        ['Steamapps', 'Workshop', 'content', wallpaperEngineWorkshopAppId],
        ['Steamapps', 'Workshop', 'Content', wallpaperEngineWorkshopAppId],
        ['steamapps', 'Workshop', 'Content', wallpaperEngineWorkshopAppId],
    ].map(parts => GLib.build_filenamev([steamLibraryPath, ...parts]));
}

function getWallpaperEngineProjectRoots(libraryPath) {
    const normalized = normalizeLibraryRootPath(libraryPath);
    if (!normalized)
        return [];

    if (!hasWallpaperEngineInstall(normalized))
        return [normalized].filter(isDirectoryPath);

    const roots = [
        ...getSteamWorkshopDirs(normalized),
        GLib.build_filenamev([normalized, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'defaultprojects']),
        GLib.build_filenamev([normalized, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'myprojects']),
    ];

    return [...new Set(roots.filter(isDirectoryPath))];
}

function resolveLegacyProjectType(project) {
    const entry = typeof project?.file === 'string' ? project.file.trim().toLowerCase() : '';
    if (!entry)
        return null;

    // Older official Wallpaper Engine scene projects can omit "type" while
    // still pointing at the scene document. Keep the inference narrow so
    // unsupported executables, videos without explicit metadata, and malformed
    // manifests continue to fail closed instead of being routed to a backend
    // that cannot render them.
    if (entry.endsWith('.json') || entry.endsWith('.pkg'))
        return ProjectType.SCENE;

    // Web projects are the only legacy projects we can safely identify from the
    // entry file alone, because their launch surface is an HTML document.
    if (entry.endsWith('.html') || entry.endsWith('.htm'))
        return ProjectType.WEB;

    return null;
}

function resolveProjectType(project) {
    const rawType = typeof project?.type === 'string' ? project.type.trim() : '';
    const type = rawType.toLowerCase();
    switch (type) {
    case ProjectType.VIDEO:
    case ProjectType.WEB:
    case ProjectType.SCENE:
        return type;
    default:
        return rawType ? null : resolveLegacyProjectType(project);
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

function normalizeProjectTags(project) {
    if (!Array.isArray(project?.tags))
        return [];

    return project.tags.filter(tag => typeof tag === 'string' && tag !== '');
}

function normalizeProjectTag(tag) {
    return typeof tag === 'string' ? tag.trim() : '';
}

function normalizeProjectContentRating(contentRating) {
    const normalized = typeof contentRating === 'string' ? contentRating.trim() : '';
    return normalized || ProjectContentRatings[0];
}

function compareProjectGenres(left, right) {
    const leftPresetIndex = projectGenrePresetIndex.has(left)
        ? projectGenrePresetIndex.get(left)
        : Number.MAX_SAFE_INTEGER;
    const rightPresetIndex = projectGenrePresetIndex.has(right)
        ? projectGenrePresetIndex.get(right)
        : Number.MAX_SAFE_INTEGER;

    if (leftPresetIndex !== rightPresetIndex)
        return leftPresetIndex - rightPresetIndex;

    return left.localeCompare(right);
}

function normalizeProjectGenreList(tags) {
    const result = new Set(ProjectGenrePresets);
    (tags ?? []).forEach(tag => {
        const normalizedTag = normalizeProjectTag(tag);
        if (normalizedTag)
            result.add(normalizedTag);
    });
    return [...result].sort(compareProjectGenres);
}

function getProjectFilterTagOptions(projects = []) {
    const tags = [];
    projects.forEach(project => tags.push(...(project?.tags ?? [])));
    return normalizeProjectGenreList(tags);
}

function buildProjectFilterState(filter, availableTags = []) {
    const normalized = filter && typeof filter === 'object' ? filter : {};
    const tags = normalizeProjectGenreList(availableTags);

    const state = {
        type: {
            scene: true,
            web: true,
            video: true,
        },
        contentrating: {
            Everyone: true,
            Questionable: true,
            Mature: false,
        },
        tags: {},
    };

    Object.keys(state.type).forEach(key => {
        if (typeof normalized?.type?.[key] === 'boolean')
            state.type[key] = normalized.type[key];
    });

    Object.keys(state.contentrating).forEach(key => {
        if (typeof normalized?.contentrating?.[key] === 'boolean')
            state.contentrating[key] = normalized.contentrating[key];
    });

    tags.forEach(tag => {
        state.tags[tag] = typeof normalized?.tags?.[tag] === 'boolean'
            ? normalized.tags[tag]
            : true;
    });

    Object.keys(normalized?.tags ?? {}).forEach(tag => {
        const normalizedTag = normalizeProjectTag(tag);
        if (!normalizedTag || Object.prototype.hasOwnProperty.call(state.tags, normalizedTag))
            return;

        state.tags[normalizedTag] = typeof normalized.tags[tag] === 'boolean'
            ? normalized.tags[tag]
            : true;
    });

    return state;
}

function parseProjectFilterState(serialized, availableTags = []) {
    if (!serialized)
        return buildProjectFilterState(null, availableTags);

    try {
        const parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
        return buildProjectFilterState(parsed, availableTags);
    } catch (_e) {
        return buildProjectFilterState(null, availableTags);
    }
}

function serializeProjectFilterState(filter, availableTags = []) {
    const normalized = buildProjectFilterState(filter, [
        ...availableTags,
        ...Object.keys(filter?.tags ?? {}),
    ]);
    const serialized = {
        type: {},
        contentrating: {},
        tags: {},
    };

    Object.keys(normalized.type).forEach(key => {
        serialized.type[key] = normalized.type[key];
    });
    Object.keys(normalized.contentrating).forEach(key => {
        serialized.contentrating[key] = normalized.contentrating[key];
    });
    Object.keys(normalized.tags)
        .sort(compareProjectGenres)
        .forEach(key => {
            serialized.tags[key] = normalized.tags[key];
        });

    return JSON.stringify(serialized);
}

function setProjectFilterInSettings(settings, filter, availableTags = []) {
    if (!settings)
        return;

    settings.set_string(
        ProjectBrowserFilterKey.STATE,
        serializeProjectFilterState(filter, availableTags)
    );
}

function getProjectFilterFromSettings(settings, availableTags = []) {
    if (!settings)
        return buildProjectFilterState(null, availableTags);

    return parseProjectFilterState(
        settings.get_string(ProjectBrowserFilterKey.STATE),
        availableTags
    );
}

function getProjectFilterTagsForProject(project) {
    if (Array.isArray(project?.tags) && project.tags.length > 0)
        return project.tags;

    return ['Unspecified'];
}

function projectMatchesFilter(project, filter) {
    if (filter === null || filter === undefined)
        return true;

    const normalizedFilter = buildProjectFilterState(
        filter,
        getProjectFilterTagsForProject(project)
    );

    if (!normalizedFilter.type[project?.type])
        return false;

    const contentRating = normalizeProjectContentRating(project?.contentrating);
    if (!normalizedFilter.contentrating[contentRating])
        return false;

    return getProjectFilterTagsForProject(project)
        .map(normalizeProjectTag)
        .every(tag => normalizedFilter.tags[tag] !== false);
}

function resolveProjectConfigId(project) {
    if (!project)
        return null;

    const workshopId = project.workshopId;
    if (workshopId !== null && workshopId !== undefined && `${workshopId}` !== '')
        return `workshop:${workshopId}`;

    return project.path ? `path:${project.path}` : null;
}

function normalizeScenePropertyType(type) {
    const normalized = `${type ?? ''}`.trim().toLowerCase();
    switch (normalized) {
    case ScenePropertyType.BOOL:
    case ScenePropertyType.COLOR:
    case ScenePropertyType.COMBO:
    case ScenePropertyType.DIRECTORY:
    case ScenePropertyType.FILE:
    case ScenePropertyType.GROUP:
    case ScenePropertyType.SCENE_TEXTURE:
    case ScenePropertyType.SLIDER:
    case ScenePropertyType.TEXT:
    case ScenePropertyType.TEXT_INPUT:
        return normalized;
    default:
        return normalized || null;
    }
}

function normalizeScenePropertyValue(type, value, fallbackValue = null) {
    const normalizedType = normalizeScenePropertyType(type);
    switch (normalizedType) {
    case ScenePropertyType.BOOL:
        if (typeof value === 'boolean')
            return value;
        if (typeof value === 'number')
            return Math.abs(value) >= 0.0001;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['', '0', 'false', 'off', 'no'].includes(normalized))
                return false;
            if (['1', 'true', 'on', 'yes'].includes(normalized))
                return true;
        }
        return Boolean(fallbackValue);
    case ScenePropertyType.SLIDER: {
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        if (typeof value === 'string') {
            const parsed = Number.parseFloat(value.trim());
            if (Number.isFinite(parsed))
                return parsed;
        }
        return typeof fallbackValue === 'number' && Number.isFinite(fallbackValue)
            ? fallbackValue
            : 0;
    }
    case ScenePropertyType.COLOR:
        if (Array.isArray(value))
            return value.map(component => `${component}`).join(' ');
        if (typeof value === 'string')
            return value.trim();
        if (typeof value === 'number' && Number.isFinite(value))
            return `${value}`;
        return typeof fallbackValue === 'string' ? fallbackValue : '';
    case ScenePropertyType.COMBO:
    case ScenePropertyType.DIRECTORY:
    case ScenePropertyType.FILE:
    case ScenePropertyType.GROUP:
    case ScenePropertyType.SCENE_TEXTURE:
    case ScenePropertyType.TEXT:
    case ScenePropertyType.TEXT_INPUT:
        if (typeof value === 'string')
            return value;
        if (typeof value === 'number' && Number.isFinite(value))
            return `${value}`;
        if (typeof value === 'boolean')
            return value ? 'true' : 'false';
        return typeof fallbackValue === 'string' ? fallbackValue : '';
    default:
        return value ?? fallbackValue;
    }
}

function normalizeWebFilesystemPropertyValue(value) {
    if (typeof value !== 'string')
        return value;

    let normalized = value.trim();
    if (!normalized)
        return '';

    if (normalized.startsWith('file://')) {
        try {
            const path = Gio.File.new_for_uri(normalized).get_path();
            if (typeof path === 'string' && path !== '')
                normalized = path;
        } catch (_e) {
        }
    }

    if (/^[A-Za-z]:[\\/]/.test(normalized))
        return normalized;

    if (normalized.startsWith('/'))
        return normalized.replace(/^\/+/, '');

    return normalized;
}

function areScenePropertyValuesEqual(type, left, right) {
    const normalizedLeft = normalizeScenePropertyValue(type, left);
    const normalizedRight = normalizeScenePropertyValue(type, right);
    if (type === ScenePropertyType.SLIDER)
        return Math.abs(normalizedLeft - normalizedRight) < 0.0001;
    return normalizedLeft === normalizedRight;
}

function normalizeScenePropertyOptions(property) {
    if (!Array.isArray(property?.options))
        return [];

    return property.options.map(option => {
        const text = typeof option?.label === 'string'
            ? option.label
            : typeof option?.text === 'string'
                ? option.text
            : `${option?.value ?? ''}`;
        const rawValue = option?.value ?? text;
        const value = normalizeScenePropertyValue(ScenePropertyType.COMBO, option?.value ?? text, '');
        return {
            text,
            value,
            rawValue: rawValue ?? text,
            condition: typeof option?.condition === 'string' ? option.condition.trim() : '',
        };
    });
}

function normalizeSceneProperty(propertyName, property) {
    if (!property || typeof property !== 'object')
        return null;

    const type = normalizeScenePropertyType(property.type);
    if (!type)
        return null;

    const defaultValue = normalizeScenePropertyValue(type, property.value, '');
    return {
        name: propertyName,
        type,
        text: typeof property.text === 'string' ? property.text : propertyName,
        order: typeof property.order === 'number' && Number.isFinite(property.order) ? property.order : 0,
        condition: typeof property.condition === 'string' ? property.condition.trim() : '',
        mode: typeof property.mode === 'string' ? property.mode.trim().toLowerCase() : '',
        min: typeof property.min === 'number' && Number.isFinite(property.min) ? property.min : null,
        max: typeof property.max === 'number' && Number.isFinite(property.max) ? property.max : null,
        step: typeof property.step === 'number' && Number.isFinite(property.step) ? property.step : null,
        defaultValue,
        editable: scenePropertyEditableTypes.has(type),
        storesString: scenePropertyStringTypes.has(type),
        options: normalizeScenePropertyOptions(property),
    };
}

function normalizeSceneProperties(project) {
    const type = resolveProjectType(project);
    if (type !== ProjectType.SCENE && type !== ProjectType.WEB)
        return [];

    const propertyEntries = project?.general?.properties;
    if (!propertyEntries || typeof propertyEntries !== 'object')
        return [];

    return Object.entries(propertyEntries)
        .map(([propertyName, property]) => normalizeSceneProperty(propertyName, property))
        .filter(Boolean)
        .sort((left, right) => {
            if (left.order !== right.order)
                return left.order - right.order;
            return left.name.localeCompare(right.name);
        });
}

function buildScenePropertyMap(project) {
    const propertyMap = {};
    for (const property of project?.sceneProperties ?? [])
        propertyMap[property.name] = property;
    return propertyMap;
}

function parseStoredScenePropertyOverrides(serialized) {
    if (!serialized)
        return {};

    try {
        const parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        return parsed;
    } catch (_e) {
        return {};
    }
}

function sanitizeStoredScenePropertyOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
        return {};

    const sanitized = {};
    for (const [propertyName, propertyValue] of Object.entries(overrides)) {
        switch (typeof propertyValue) {
        case 'boolean':
        case 'string':
            sanitized[propertyName] = propertyValue;
            break;
        case 'number':
            if (Number.isFinite(propertyValue))
                sanitized[propertyName] = propertyValue;
            break;
        default:
            break;
        }
    }
    return sanitized;
}

function serializeStoredScenePropertyOverrides(overrides) {
    const sanitized = {};
    for (const configId of Object.keys(overrides ?? {}).sort()) {
        const projectOverrides = sanitizeStoredScenePropertyOverrides(overrides[configId]);
        if (Object.keys(projectOverrides).length > 0)
            sanitized[configId] = projectOverrides;
    }

    return Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : '';
}

function getProjectScenePropertyOverrides(serializedOrStore, project) {
    return getProjectUserPropertyOverrides(serializedOrStore, project);
}

function getProjectWebPropertyOverrides(serializedOrStore, project) {
    return getProjectUserPropertyOverrides(serializedOrStore, project);
}

function getProjectUserPropertyOverrides(serializedOrStore, project) {
    const configId = resolveProjectConfigId(project);
    if (!configId)
        return {};

    const store = parseStoredScenePropertyOverrides(serializedOrStore);
    return sanitizeStoredScenePropertyOverrides(store[configId]);
}

function setProjectScenePropertyOverrides(serializedOrStore, project, overrides) {
    return setProjectUserPropertyOverrides(serializedOrStore, project, overrides);
}

function setProjectWebPropertyOverrides(serializedOrStore, project, overrides) {
    return setProjectUserPropertyOverrides(serializedOrStore, project, overrides);
}

function setProjectUserPropertyOverrides(serializedOrStore, project, overrides) {
    const configId = resolveProjectConfigId(project);
    const store = parseStoredScenePropertyOverrides(serializedOrStore);
    if (!configId)
        return store;

    const sanitized = sanitizeStoredScenePropertyOverrides(overrides);
    if (Object.keys(sanitized).length > 0)
        store[configId] = sanitized;
    else
        delete store[configId];

    return store;
}

function resolveScenePropertyValue(property, overrides = {}) {
    if (!property)
        return null;

    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, property.name);
    return normalizeScenePropertyValue(
        property.type,
        hasOverride ? overrides[property.name] : property.defaultValue,
        property.defaultValue
    );
}

function isScenePropertyTruthy(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Math.abs(value) >= 0.0001;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized !== '' && normalized !== '0' && normalized !== 'false';
    }
    return Boolean(value);
}

function parseSceneExpressionNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed)
            return null;
        const parsed = Number.parseFloat(trimmed);
        if (Number.isFinite(parsed) && `${parsed}` === `${Number(trimmed)}`)
            return parsed;
    }
    return null;
}

function createScenePropertyExpressionEvaluator(project, valueMap, enabledMap, stack) {
    const propertyMap = project?.scenePropertiesByName ?? {};

    function isPropertyEnabled(propertyName) {
        if (!Object.prototype.hasOwnProperty.call(propertyMap, propertyName))
            return false;
        if (enabledMap.has(propertyName))
            return enabledMap.get(propertyName);
        if (stack.includes(propertyName))
            return false;

        const property = propertyMap[propertyName];
        if (!property.condition) {
            enabledMap.set(propertyName, true);
            return true;
        }

        stack.push(propertyName);
        const result = evaluateScenePropertyExpression(project, property.condition, valueMap, enabledMap, stack);
        stack.pop();
        enabledMap.set(propertyName, result);
        return result;
    }

    class Parser {
        constructor(expression) {
            this._expression = expression ?? '';
            this._index = 0;
        }

        parse() {
            const value = this._parseOr();
            this._skipWhitespace();
            return value !== undefined && this._index === this._expression.length
                ? isScenePropertyTruthy(value)
                : false;
        }

        _parseOr() {
            let value = this._parseAnd();
            while (value !== undefined) {
                this._skipWhitespace();
                if (!this._consume('||'))
                    break;
                const right = this._parseAnd();
                if (right === undefined)
                    return undefined;
                value = isScenePropertyTruthy(value) || isScenePropertyTruthy(right);
            }
            return value;
        }

        _parseAnd() {
            let value = this._parseComparison();
            while (value !== undefined) {
                this._skipWhitespace();
                if (!this._consume('&&'))
                    break;
                const right = this._parseComparison();
                if (right === undefined)
                    return undefined;
                value = isScenePropertyTruthy(value) && isScenePropertyTruthy(right);
            }
            return value;
        }

        _parseComparison() {
            let value = this._parseUnary();
            if (value === undefined)
                return undefined;

            while (true) {
                this._skipWhitespace();
                const operator = this._consumeOperator(['==', '!=', '<=', '>=', '<', '>']);
                if (!operator)
                    break;

                const right = this._parseUnary();
                if (right === undefined)
                    return undefined;

                if (operator === '==') {
                    value = this._areEqual(value, right);
                    continue;
                }
                if (operator === '!=') {
                    value = !this._areEqual(value, right);
                    continue;
                }

                const leftNumber = parseSceneExpressionNumber(value);
                const rightNumber = parseSceneExpressionNumber(right);
                if (leftNumber === null || rightNumber === null)
                    return undefined;

                switch (operator) {
                case '<':
                    value = leftNumber < rightNumber;
                    break;
                case '<=':
                    value = leftNumber <= rightNumber;
                    break;
                case '>':
                    value = leftNumber > rightNumber;
                    break;
                case '>=':
                    value = leftNumber >= rightNumber;
                    break;
                }
            }

            return value;
        }

        _parseUnary() {
            this._skipWhitespace();
            if (this._consume('!')) {
                const value = this._parseUnary();
                return value === undefined ? undefined : !isScenePropertyTruthy(value);
            }
            return this._parsePrimary();
        }

        _parsePrimary() {
            this._skipWhitespace();
            if (this._consume('(')) {
                const value = this._parseOr();
                this._skipWhitespace();
                return this._consume(')') ? value : undefined;
            }

            const quoted = this._parseQuotedString();
            if (quoted !== undefined)
                return quoted;

            const identifier = this._parseIdentifier();
            if (identifier) {
                if (identifier === 'true')
                    return true;
                if (identifier === 'false')
                    return false;

                const propertyName = this._consume('.value')
                    ? identifier
                    : identifier;
                if (!isPropertyEnabled(propertyName))
                    return undefined;
                return Object.prototype.hasOwnProperty.call(valueMap, propertyName)
                    ? valueMap[propertyName]
                    : undefined;
            }

            return this._parseNumber();
        }

        _parseQuotedString() {
            const quote = this._expression[this._index];
            if (quote !== '"' && quote !== '\'')
                return undefined;

            this._index++;
            let value = '';
            while (this._index < this._expression.length) {
                const current = this._expression[this._index++];
                if (current === quote)
                    return value;
                if (current === '\\' && this._index < this._expression.length) {
                    value += this._expression[this._index++];
                    continue;
                }
                value += current;
            }
            return undefined;
        }

        _parseIdentifier() {
            const rest = this._expression.slice(this._index);
            const match = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
            if (!match)
                return null;
            this._index += match[0].length;
            return match[0];
        }

        _parseNumber() {
            const rest = this._expression.slice(this._index);
            const match = rest.match(/^-?(?:\d+(?:\.\d*)?|\.\d+)/);
            if (!match)
                return undefined;
            this._index += match[0].length;
            const parsed = Number.parseFloat(match[0]);
            return Number.isFinite(parsed) ? parsed : undefined;
        }

        _skipWhitespace() {
            while (this._index < this._expression.length && /\s/.test(this._expression[this._index]))
                this._index++;
        }

        _consume(token) {
            if (!this._expression.startsWith(token, this._index))
                return false;
            this._index += token.length;
            return true;
        }

        _consumeOperator(operators) {
            for (const operator of operators) {
                if (this._consume(operator))
                    return operator;
            }
            return null;
        }

        _areEqual(left, right) {
            const leftNumber = parseSceneExpressionNumber(left);
            const rightNumber = parseSceneExpressionNumber(right);
            if (leftNumber !== null && rightNumber !== null)
                return Math.abs(leftNumber - rightNumber) < 0.0001;
            if (typeof left === 'string' && typeof right === 'string')
                return left.trim() === right.trim();
            return isScenePropertyTruthy(left) === isScenePropertyTruthy(right);
        }
    }

    return expression => new Parser(expression).parse();
}

function evaluateScenePropertyExpression(project, expression, valueMap, enabledMap = new Map(), stack = []) {
    const trimmed = typeof expression === 'string' ? expression.trim() : '';
    if (!trimmed)
        return false;

    const evaluate = createScenePropertyExpressionEvaluator(project, valueMap, enabledMap, stack);
    return evaluate(trimmed);
}

function isScenePropertyVisible(project, property, valueMap, enabledMap = new Map()) {
    if (!property)
        return false;
    if (!property.condition)
        return true;
    return evaluateScenePropertyExpression(project, property.condition, valueMap, enabledMap, []);
}

function buildScenePropertyValueMap(project, overrides = {}) {
    const valueMap = {};
    for (const property of project?.sceneProperties ?? [])
        valueMap[property.name] = resolveScenePropertyValue(property, overrides);
    return valueMap;
}

function buildSceneUserPropertyPayload(project, overrides = {}) {
    if (project?.type !== ProjectType.SCENE)
        return {};

    const payload = {};
    for (const property of project?.sceneProperties ?? []) {
        if (!property.editable)
            continue;

        if (!Object.prototype.hasOwnProperty.call(overrides, property.name))
            continue;

        const value = normalizeScenePropertyValue(property.type, overrides[property.name], property.defaultValue);
        if (areScenePropertyValuesEqual(property.type, value, property.defaultValue))
            continue;

        payload[property.name] = {
            type: property.type,
            value,
        };
    }
    return payload;
}

function buildWebUserPropertyPayload(project, overrides = {}) {
    if (project?.type !== ProjectType.WEB)
        return {};

    const payload = {};
    for (const property of project?.sceneProperties ?? []) {
        if (!property.editable)
            continue;

        let value = resolveScenePropertyValue(property, overrides);
        const entry = {value};
        if ([ScenePropertyType.FILE, ScenePropertyType.DIRECTORY, ScenePropertyType.SCENE_TEXTURE].includes(property.type)) {
            value = normalizeWebFilesystemPropertyValue(value);
            entry.value = value;
        }
        if (property.type === ScenePropertyType.COMBO) {
            const option = property.options.find(option => option.value === `${value}`);
            if (option) {
                value = option.rawValue;
                entry.value = value;
                entry.text = option.text;
            }
        }
        payload[property.name] = entry;
    }
    return payload;
}

function warnInvalidProject(projectDirPath, reason) {
    console.warn(`Hanabi project loader: invalid project "${projectDirPath || '<empty>'}": ${reason}`);
}

function loadProject(projectDirPath, options = {}) {
    const logInvalid = options?.logInvalid === true;

    if (!projectDirPath) {
        if (logInvalid)
            warnInvalidProject(projectDirPath, 'project path is empty');
        return null;
    }

    const projectDir = Gio.File.new_for_path(projectDirPath);
    if (projectDir.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
        if (logInvalid)
            warnInvalidProject(projectDirPath, 'path is not a directory');
        return null;
    }

    const projectJsonPath = GLib.build_filenamev([projectDirPath, 'project.json']);
    const project = readJsonFile(projectJsonPath);
    if (!project) {
        if (logInvalid)
            warnInvalidProject(projectDirPath, 'project.json could not be read or parsed');
        return null;
    }

    if (typeof project !== 'object' || Array.isArray(project)) {
        if (logInvalid)
            warnInvalidProject(projectDirPath, 'project.json root is not an object');
        return null;
    }

    if (typeof project.type === 'string' && project.type.trim() !== '') {
        const normalizedType = project.type.trim().toLowerCase();
        if (![ProjectType.VIDEO, ProjectType.WEB, ProjectType.SCENE].includes(normalizedType)) {
            if (logInvalid)
                warnInvalidProject(projectDirPath, `unsupported project type "${project.type}"`);
            return null;
        }
    }

    // Keep type resolution centralized after validation so explicit metadata
    // always wins, while legacy official scene projects without "type" can use
    // the constrained entry-file inference above.
    const type = resolveProjectType(project);
    if (!type) {
        if (logInvalid)
            warnInvalidProject(projectDirPath, 'project type is missing and could not be inferred from the entry file');
        return null;
    }

    const entry = resolveEntryFile(project, type);
    let entryPath = resolveRegularFile(projectDirPath, entry);
    if (type === ProjectType.SCENE && !entryPath)
        entryPath = resolveRegularFile(projectDirPath, 'scene.pkg');
    if (entry && !entryPath && type !== ProjectType.SCENE) {
        if (logInvalid)
            warnInvalidProject(projectDirPath, `entry file "${entry}" is not a regular file`);
        return null;
    }

    const previewPath = resolvePreviewFile(projectDirPath, project);
    const tags = normalizeProjectTags(project);
    const sceneProperties = normalizeSceneProperties(project);

    return {
        manifest: project,
        manifestPath: projectJsonPath,
        path: projectDirPath,
        basename: GLib.path_get_basename(projectDirPath),
        title: resolveProjectTitle(projectDirPath, project),
        description: typeof project?.description === 'string' ? project.description : '',
        tags,
        contentrating: normalizeProjectContentRating(project?.contentrating),
        workshopId: project?.workshopid ?? null,
        type,
        entry,
        entryPath,
        preview: typeof project?.preview === 'string' && project.preview !== ''
            ? project.preview
            : null,
        previewPath,
        configId: resolveProjectConfigId({
            path: projectDirPath,
            workshopId: project?.workshopid ?? null,
        }),
        sceneProperties,
        scenePropertiesByName: sceneProperties.length > 0
            ? buildScenePropertyMap({sceneProperties})
            : {},
    };
}

function listProjects(parentDirPath, filter = null) {
    const projects = [];
    if (!parentDirPath)
        return projects;

    const projectRoots = getWallpaperEngineProjectRoots(parentDirPath);
    const seenPaths = new Set();
    for (const projectRoot of projectRoots) {
        const dir = Gio.File.new_for_path(projectRoot);
        if (dir.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY)
            continue;

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
            if (!project || seenPaths.has(project.path))
                continue;

            seenPaths.add(project.path);
            projects.push(project);
        }
    }

    return projects
        .sort((a, b) => a.path.localeCompare(b.path))
        .filter(project => projectMatchesFilter(project, filter));
}
