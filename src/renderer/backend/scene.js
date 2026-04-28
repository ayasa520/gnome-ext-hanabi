var createSceneBackendClass = (env, helpers, baseClasses) => {
    const {Gtk, Gio, GLib, GdkPixbuf, HanabiScene, ProjectType, flags, state} = env;
    const Mpris = imports.mpris;
    const {haveSceneBackend, haveContentFit, haveGraphicsOffload} = flags;
    const {setExpandFill, createConfiguredPicture} = helpers;
    const {BackendController} = baseClasses;
    const MEDIA_CACHE_DIR = GLib.build_filenamev([GLib.get_tmp_dir(), 'hanabi-scene-media-cache']);
    const MEDIA_PLAYBACK_STOPPED = 0;
    const MEDIA_PLAYBACK_PLAYING = 1;
    const MEDIA_PLAYBACK_PAUSED = 2;
    const MEDIA_PLAYBACK_OTHER = 3;
    const sceneMediaDebounceDelayMs = 80;
    const sceneMediaSlowOperationThresholdUs = 20000;
    const thumbnailDecodeSize = 512;
    // These palette constants intentionally describe algorithmic tuning rather than wallpaper-
    // specific behavior. Keeping them together makes future album-art sampling adjustments local
    // and avoids scattering unexplained thresholds through the octree implementation.
    const mediaPaletteSampleGridSize = 48;
    const mediaPaletteOctreeMaxDepth = 6;
    const mediaPaletteMaxSwatches = 12;
    const mediaPaletteMinimumAlpha = 16;
    const mediaPaletteDistinctColorDistance = 0.045;
    const mediaPaletteHighContrastLuminance = 0.55;
    const mediaPaletteDarkTextColor = [0.05, 0.05, 0.05];
    const mediaPaletteLightTextColor = [0.95, 0.95, 0.95];
    const mediaPaletteEmptyPrimaryColor = [0, 0, 0];
    const mediaPaletteEmptySecondaryColor = [1, 1, 1];
    const mediaPaletteSecondaryPrimaryWeight = 0.7;
    const mediaPaletteSecondaryTextWeight = 0.3;
    const mediaPaletteRankPopulationFloor = 0.35;
    const mediaPaletteRankLuminanceWeight = 1.15;
    const mediaPaletteRankTargetLuminance = 0.52;
    const trackedSceneUserProperties = ['hrbigb2'];
    const describeTrackedSceneUserProperties = payload => {
        // These probes intentionally stay tiny and stable because scene project
        // reuse crosses the GJS/native boundary.  When a switch-only regression
        // appears, the log tells us whether the JavaScript side actually sent
        // the user property that controls the suspect wallpaper layer.
        const normalized = payload && typeof payload === 'object' ? payload : {};
        return trackedSceneUserProperties
            .map(name => {
                const entry = normalized[name];
                if (!entry || typeof entry !== 'object')
                    return `${name}=<missing>`;

                return `${name}=${JSON.stringify(entry.value)}:${entry.type ?? 'unknown'}`;
            })
            .join(' ');
    };
    const formatAspect = (width, height) => {
        if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0)
            return 'n/a';

        return (width / height).toFixed(6);
    };

    const detachScenePresentationTarget = target => {
        if (!target)
            return;

        try {
            target.set_paintable?.(null);
        } catch (_e) {
        }

        try {
            target.set_child?.(null);
        } catch (_e) {
        }
    };

    const disposeSceneTarget = target => {
        if (!target)
            return;

        try {
            target.run_dispose?.();
        } catch (e) {
            console.warn(e);
        }
    };

    const clampColorChannel = value => Math.max(0, Math.min(1, Number(value) || 0));
    const clampByte = value => Math.max(0, Math.min(255, Number(value) || 0));
    const cloneMediaColor = color => color.map(channel => clampColorChannel(channel));
    const normalizeByteColor = color => color.map(channel => clampColorChannel(channel / 255));
    const formatMediaColorForLog = color => (Array.isArray(color) ? color : [])
        .map(channel => clampColorChannel(channel).toFixed(3))
        .join(',');
    const colorLuminance = color =>
        0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    const colorDistanceSquared = (left, right) =>
        (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
    const deriveSecondaryColor = (primaryColor, textColor) => primaryColor.map(
        (channel, index) => clampColorChannel(
            channel * mediaPaletteSecondaryPrimaryWeight +
            (textColor[index] ?? 1) * mediaPaletteSecondaryTextWeight
        )
    );
    const createOctreeColorNode = (level, maxDepth) => ({
        level,
        isLeaf: level >= maxDepth,
        count: 0,
        r: 0,
        g: 0,
        b: 0,
        children: level >= maxDepth ? null : new Array(8).fill(null),
    });
    const insertOctreeColor = (node, r, g, b, maxDepth) => {
        node.count++;
        node.r += r;
        node.g += g;
        node.b += b;
        if (node.isLeaf)
            return;

        const bit = 7 - node.level;
        const childIndex =
            (((r >> bit) & 1) << 2) |
            (((g >> bit) & 1) << 1) |
            ((b >> bit) & 1);
        if (!node.children[childIndex])
            node.children[childIndex] = createOctreeColorNode(node.level + 1, maxDepth);
        insertOctreeColor(node.children[childIndex], r, g, b, maxDepth);
    };
    const countOctreeLeaves = node => {
        if (!node)
            return 0;
        if (node.isLeaf)
            return 1;
        return node.children.reduce((sum, child) => sum + countOctreeLeaves(child), 0);
    };
    const findOctreeReductionCandidate = node => {
        if (!node || node.isLeaf)
            return null;

        let candidate = null;
        for (const child of node.children) {
            const childCandidate = findOctreeReductionCandidate(child);
            if (!childCandidate)
                continue;
            if (
                !candidate ||
                childCandidate.level > candidate.level ||
                (childCandidate.level === candidate.level && childCandidate.count < candidate.count)
            )
                candidate = childCandidate;
        }

        const childCount = node.children.filter(Boolean).length;
        if (childCount > 0) {
            if (
                !candidate ||
                node.level > candidate.level ||
                (node.level === candidate.level && node.count < candidate.count)
            )
                candidate = node;
        }
        return candidate;
    };
    const reduceOctreeColorNode = node => {
        if (!node || node.isLeaf)
            return 0;

        // Collapsing the deepest low-population branch is the canonical octree quantization step:
        // each branch already stores accumulated RGB totals, so reducing it preserves the branch's
        // average color while freeing enough leaves to converge on a compact album-art palette.
        const removedLeaves = countOctreeLeaves(node);
        node.isLeaf = true;
        node.children = null;
        return Math.max(0, removedLeaves - 1);
    };
    const collectOctreeSwatches = (node, swatches = []) => {
        if (!node)
            return swatches;
        if (node.isLeaf) {
            if (node.count > 0) {
                swatches.push({
                    count: node.count,
                    color: [node.r / node.count, node.g / node.count, node.b / node.count],
                });
            }
            return swatches;
        }

        node.children.forEach(child => collectOctreeSwatches(child, swatches));
        return swatches;
    };
    const extractOctreePalette = (samples, maxSwatches) => {
        const root = createOctreeColorNode(0, mediaPaletteOctreeMaxDepth);
        samples.forEach(([r, g, b]) => insertOctreeColor(root, r, g, b, mediaPaletteOctreeMaxDepth));

        let leafCount = countOctreeLeaves(root);
        while (leafCount > maxSwatches) {
            const candidate = findOctreeReductionCandidate(root);
            if (!candidate)
                break;
            const removedLeaves = reduceOctreeColorNode(candidate);
            if (removedLeaves <= 0)
                break;
            leafCount -= removedLeaves;
        }

        return collectOctreeSwatches(root);
    };
    const rankPaletteSwatch = swatch => {
        const maxChannel = Math.max(swatch.color[0], swatch.color[1], swatch.color[2]);
        const minChannel = Math.min(swatch.color[0], swatch.color[1], swatch.color[2]);
        const saturation = maxChannel <= 0 ? 0 : (maxChannel - minChannel) / maxChannel;
        const luminance = colorLuminance(normalizeByteColor(swatch.color));

        // Album art often has large black/white borders. Weight population, saturation, and
        // mid-tone luminance together so mediaThumbnailChanged receives a representative accent
        // instead of a flat average that scripts perceive as "not following the cover".
        return swatch.count * (mediaPaletteRankPopulationFloor + saturation) *
            (mediaPaletteRankLuminanceWeight - Math.abs(luminance - mediaPaletteRankTargetLuminance));
    };
    const computeArtworkPalette = pixbuf => {
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        const rowstride = pixbuf.get_rowstride();
        const channels = pixbuf.get_n_channels();
        const pixels = pixbuf.get_pixels();
        const samples = [];
        const stepY = Math.max(1, Math.floor(height / mediaPaletteSampleGridSize));
        const stepX = Math.max(1, Math.floor(width / mediaPaletteSampleGridSize));
        let totalR = 0;
        let totalG = 0;
        let totalB = 0;
        let count = 0;

        for (let y = 0; y < height; y += stepY) {
            for (let x = 0; x < width; x += stepX) {
                const offset = y * rowstride + x * channels;
                const alpha = channels >= 4 ? pixels[offset + 3] : 255;
                if (alpha < mediaPaletteMinimumAlpha)
                    continue;

                const r = clampByte(pixels[offset]);
                const g = clampByte(pixels[offset + 1]);
                const b = clampByte(pixels[offset + 2]);
                totalR += r;
                totalG += g;
                totalB += b;
                count++;
                samples.push([r, g, b]);
            }
        }

        if (count === 0) {
            return {
                primaryColor: cloneMediaColor(mediaPaletteEmptyPrimaryColor),
                secondaryColor: cloneMediaColor(mediaPaletteEmptySecondaryColor),
                tertiaryColor: cloneMediaColor(mediaPaletteEmptySecondaryColor),
                textColor: cloneMediaColor(mediaPaletteEmptySecondaryColor),
                highContrastColor: cloneMediaColor(mediaPaletteEmptySecondaryColor),
            };
        }

        const average = normalizeByteColor([totalR / count, totalG / count, totalB / count]);
        const ranked = extractOctreePalette(samples, mediaPaletteMaxSwatches)
            .sort((left, right) => rankPaletteSwatch(right) - rankPaletteSwatch(left));
        const chooseDistinct = fallback => {
            const picked = [];
            for (const swatch of ranked) {
                const normalized = normalizeByteColor(swatch.color);
                if (picked.every(color =>
                    colorDistanceSquared(color, normalized) > mediaPaletteDistinctColorDistance))
                    picked.push(normalized);
                if (picked.length >= 3)
                    break;
            }
            while (picked.length < 3)
                picked.push(picked[picked.length - 1] ?? fallback);
            return picked;
        };
        const [primaryColor, secondaryCandidate, tertiaryCandidate] = chooseDistinct(average);
        const highContrastColor = colorLuminance(primaryColor) > mediaPaletteHighContrastLuminance
            ? cloneMediaColor(mediaPaletteDarkTextColor)
            : cloneMediaColor(mediaPaletteLightTextColor);
        const secondaryColor = secondaryCandidate ?? deriveSecondaryColor(primaryColor, highContrastColor);
        const tertiaryColor = tertiaryCandidate ?? average;

        return {
            primaryColor,
            secondaryColor,
            tertiaryColor,
            textColor: highContrastColor,
            highContrastColor,
        };
    };
    const mapPlaybackState = playbackStatus => {
        switch (String(playbackStatus ?? '')) {
        case 'Playing':
            return MEDIA_PLAYBACK_PLAYING;
        case 'Paused':
            return MEDIA_PLAYBACK_PAUSED;
        case 'Stopped':
        case '':
            return MEDIA_PLAYBACK_STOPPED;
        default:
            return MEDIA_PLAYBACK_OTHER;
        }
    };
    const readFileAsync = file => new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try {
                resolve(source.read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    const replaceFileAsync = file => new Promise((resolve, reject) => {
        file.replace_async(
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                try {
                    resolve(source.replace_finish(result));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
    const closeStreamAsync = stream => new Promise((resolve, reject) => {
        stream.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try {
                resolve(source.close_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    const loadScaledPixbufAsync = stream => new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            stream,
            thumbnailDecodeSize,
            thumbnailDecodeSize,
            true,
            null,
            (_source, result) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
    const savePixbufToPngStreamAsync = (pixbuf, outputStream) => new Promise((resolve, reject) => {
        pixbuf.save_to_streamv_async(outputStream, 'png', [], [], null, (source, result) => {
            try {
                resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    const closeStreamQuietlyAsync = async stream => {
        if (!stream)
            return;

        try {
            await closeStreamAsync(stream);
        } catch (_e) {
        }
    };

    class SceneMediaMonitor {
        constructor(onStateChanged) {
            this._onStateChanged = onStateChanged;
            this._thumbnailCache = new Map();
            this._thumbnailLoads = new Map();
            this._lastPayloadJson = '';
            this._pendingActive = null;
            this._recomputeSourceId = 0;
            this._recomputeSerial = 0;
            this._destroyed = false;
            GLib.mkdir_with_parents(MEDIA_CACHE_DIR, 0o755);
            this._monitor = new Mpris.MprisMonitor({
                warn: message => console.warn(`HanabiScene media: ${message}`),
                onChanged: ({active}) => this._scheduleRecompute(active),
            });
            void this._recomputeAsync(this._monitor.getActiveSnapshot());
        }

        destroy() {
            this._destroyed = true;
            this._recomputeSerial++;
            if (this._recomputeSourceId) {
                GLib.source_remove(this._recomputeSourceId);
                this._recomputeSourceId = 0;
            }

            this._monitor?.destroy?.();
            this._monitor = null;
            this._pendingActive = null;
            this._thumbnailCache.clear();
            this._thumbnailLoads.clear();
        }

        _scheduleRecompute(active) {
            this._pendingActive = active ? {...active} : null;

            if (this._recomputeSourceId)
                GLib.source_remove(this._recomputeSourceId);

            this._recomputeSourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                sceneMediaDebounceDelayMs,
                () => {
                    this._recomputeSourceId = 0;
                    const nextActive = this._pendingActive;
                    this._pendingActive = null;
                    void this._recomputeAsync(nextActive);
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        async _writeThumbnailAsync(pixbuf, thumbnailPath) {
            const file = Gio.File.new_for_path(thumbnailPath);
            let outputStream = null;

            try {
                outputStream = await replaceFileAsync(file);
                await savePixbufToPngStreamAsync(pixbuf, outputStream);
            } finally {
                await closeStreamQuietlyAsync(outputStream);
            }
        }

        async _loadThumbnailAsync(artUrl) {
            if (!artUrl)
                return null;

            const cached = this._thumbnailCache.get(artUrl);
            if (cached)
                return cached;

            const loading = this._thumbnailLoads.get(artUrl);
            if (loading)
                return loading;

            const loadPromise = this._loadThumbnailUncachedAsync(artUrl);
            this._thumbnailLoads.set(artUrl, loadPromise);

            try {
                const payload = await loadPromise;
                if (payload)
                    this._thumbnailCache.set(artUrl, payload);
                return payload;
            } finally {
                this._thumbnailLoads.delete(artUrl);
            }
        }

        async _loadThumbnailUncachedAsync(artUrl) {
            const startedAtUs = GLib.get_monotonic_time();
            let stream = null;
            try {
                const file = GLib.uri_parse_scheme(artUrl)
                    ? Gio.File.new_for_uri(artUrl)
                    : Gio.File.new_for_path(artUrl);
                stream = await readFileAsync(file);
                const pixbuf = await loadScaledPixbufAsync(stream);
                const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, artUrl, -1);
                const thumbnailPath = GLib.build_filenamev([MEDIA_CACHE_DIR, `${hash}.png`]);
                await this._writeThumbnailAsync(pixbuf, thumbnailPath);

                const palette = computeArtworkPalette(pixbuf);
                const payload = {thumbnailPath, ...palette};
                const elapsedUs = GLib.get_monotonic_time() - startedAtUs;
                if (elapsedUs >= sceneMediaSlowOperationThresholdUs) {
                    console.warn(
                        `HanabiScene media thumbnail load slow: ${(elapsedUs / 1000).toFixed(2)}ms ` +
                        `artUrl=${artUrl} cachePath=${thumbnailPath} ` +
                        `primary=${formatMediaColorForLog(palette.primaryColor)} ` +
                        `secondary=${formatMediaColorForLog(palette.secondaryColor)}`
                    );
                }
                return payload;
            } catch (e) {
                console.warn(`HanabiScene media: failed to load artwork ${artUrl}: ${e}`);
                return null;
            } finally {
                await closeStreamQuietlyAsync(stream);
            }
        }

        _emitPayload(payload) {
            const nextJson = JSON.stringify(payload);
            if (nextJson === this._lastPayloadJson)
                return;

            this._lastPayloadJson = nextJson;
            this._onStateChanged?.(payload);
        }

        async _recomputeAsync(active) {
            const recomputeSerial = ++this._recomputeSerial;
            let payload = {
                title: '',
                artist: '',
                albumTitle: '',
                albumArtist: '',
                subTitle: '',
                genres: '',
                contentType: '',
                hasThumbnail: false,
                playbackState: MEDIA_PLAYBACK_STOPPED,
                primaryColor: [0, 0, 0],
                secondaryColor: [1, 1, 1],
                tertiaryColor: [1, 1, 1],
                textColor: [1, 1, 1],
                highContrastColor: [1, 1, 1],
                thumbnailPath: '',
            };

            if (active) {
                payload.title = active.title || '';
                payload.artist = active.artist || '';
                payload.albumTitle = active.albumTitle || '';
                payload.albumArtist = active.albumArtist || '';
                payload.subTitle = active.subTitle || '';
                payload.genres = active.genres || '';
                payload.contentType = active.contentType || '';
                payload.playbackState = mapPlaybackState(active.playbackStatus);
                const thumbnail = await this._loadThumbnailAsync(active.artUrl);
                if (this._destroyed || recomputeSerial !== this._recomputeSerial)
                    return;

                if (thumbnail) {
                    payload = {
                        ...payload,
                        hasThumbnail: true,
                        primaryColor: thumbnail.primaryColor,
                        secondaryColor: thumbnail.secondaryColor,
                        tertiaryColor: thumbnail.tertiaryColor,
                        textColor: thumbnail.textColor,
                        highContrastColor: thumbnail.highContrastColor,
                        thumbnailPath: thumbnail.thumbnailPath,
                    };
                }
            }

            if (this._destroyed || recomputeSerial !== this._recomputeSerial)
                return;

            this._emitPayload(payload);
        }
    }

    return class SceneBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this.displayName = 'HanabiScene';
            this._destroyed = false;
            this._sceneWidgets = [];
            this._scenePaintables = [];
            this._scenePictures = [];
            this._sceneOffloads = [];
            this._previewPictures = [];
            this._readyStates = new Map();
            this._readySignalHandlers = [];
            this._scaleSignalHandlers = [];
            this._readyCallback = null;
            this._readyResolved = false;
            this._audioSamples = renderer.getCurrentWebAudioFrame?.() ?? new Array(128).fill(0);
            this._sceneUserPropertiesJson = JSON.stringify(project?.scenePropertyPayload ?? {});
            this._sceneMediaStateJson = JSON.stringify({
                title: '',
                artist: '',
                albumTitle: '',
                albumArtist: '',
                subTitle: '',
                genres: '',
                contentType: '',
                hasThumbnail: false,
                playbackState: MEDIA_PLAYBACK_STOPPED,
                primaryColor: [0, 0, 0],
                secondaryColor: [1, 1, 1],
                tertiaryColor: [1, 1, 1],
                textColor: [1, 1, 1],
                highContrastColor: [1, 1, 1],
                thumbnailPath: '',
            });
            this._mediaMonitor = null;
            this._audioSamplesBackendRegistered = false;
            this._activateLiveSceneFeeds();
        }

        destroy() {
            if (this._destroyed)
                return;

            this._destroyed = true;
            if (this._scenePaintables.length > 0) {
                const oldScenePaintables = [...this._scenePaintables];
                oldScenePaintables.forEach(paintable => {
                    try {
                        paintable.pause();
                    } catch (_e) {
                    }
                });
            }

            this._readySignalHandlers = [];
            this._scaleSignalHandlers = [];
            // Renderer windows own GTK widgets and release them during transition teardown.
            // Only dispose the scene objects that are not GTK widgets here.
            this._scenePaintables.forEach(paintable => disposeSceneTarget(paintable));

            this._sceneWidgets = [];
            this._scenePaintables = [];
            this._scenePictures = [];
            this._sceneOffloads = [];
            this._previewPictures = [];
            this._readyStates.clear();
            this._readyCallback = null;
            this._readyResolved = true;
            this._deactivateLiveSceneFeeds();
            this._renderer = null;
            this._project = null;
        }

        canReuseForProject(project) {
            const currentProjectPath = this._project?.path ?? '';
            const nextProjectPath = project?.path ?? '';

            return !this._destroyed &&
                haveSceneBackend &&
                this._project?.type === ProjectType.SCENE &&
                project?.type === ProjectType.SCENE &&
                currentProjectPath !== '' &&
                currentProjectPath === nextProjectPath &&
                Boolean(project?.entryPath) &&
                (this._scenePaintables.length > 0 || this._sceneWidgets.length > 0);
        }

        switchProject(project) {
            if (!this.canReuseForProject(project))
                return false;

            const previousProjectPath = this._project?.path ?? '';
            const nextProjectPath = project?.path ?? '';
            const projectChanged = previousProjectPath !== nextProjectPath;

            if (projectChanged) {
                // Different scene projects can exercise completely different Vulkan render graphs,
                // model resources, shader pipelines, and driver synchronization paths.  Keeping the
                // same native SceneWallpaper alive across those graph changes made Arsenal inherit
                // a previously compiled render path and eventually hit an NVIDIA Xid 109 followed by
                // VK_ERROR_DEVICE_LOST.  Reuse is now intentionally limited to same-project property
                // updates; cross-project switches must allocate a fresh native target so each scene
                // owns a clean Vulkan lifecycle.
                console.log(
                    `HanabiScene: refusing reusable project switch old=${previousProjectPath || '(none)'} ` +
                    `new=${nextProjectPath || '(none)'}`
                );
                return false;
            }

            this._project = project;
            this._sceneUserPropertiesJson = JSON.stringify(project?.scenePropertyPayload ?? {});
            console.log(
                `HanabiScene properties: switch-project old=${previousProjectPath || '(none)'} ` +
                `new=${nextProjectPath || '(none)'} payload-bytes=${this._sceneUserPropertiesJson.length} ` +
                `${describeTrackedSceneUserProperties(project?.scenePropertyPayload)}`
            );

            // Same-project reuse is still valuable for preference edits because it keeps the GTK
            // widget, native target, and render thread stable while only forwarding the small
            // Wallpaper Engine user-property payload that scripts and materials already know how to
            // apply live.
            this.setSceneUserProperties(project?.scenePropertyPayload ?? {});

            this._pushSceneMediaStateToSceneTargets();
            this._pushAudioSamplesToSceneTargets();

            console.log(
                `HanabiScene: reused scene backend project-changed=${projectChanged} ` +
                `old=${previousProjectPath || '(none)'} new=${nextProjectPath || '(none)'} ` +
                `paintables=${this._scenePaintables.length} widgets=${this._sceneWidgets.length}`
            );
            return true;
        }

        _reloadSceneTargetProject(target, project) {
            if (!target)
                return;

            if (target.reload_project) {
                console.log(
                    `HanabiScene properties: reload-target project=${project?.path ?? '(none)'} ` +
                    `payload-bytes=${this._sceneUserPropertiesJson.length} ` +
                    `${describeTrackedSceneUserProperties(project?.scenePropertyPayload)}`
                );
                target.reload_project(project?.path ?? '', this._sceneUserPropertiesJson);
                return;
            }

            // Older local builds may not expose reload_project yet.  Keep this
            // fallback in the same KDE-style order: send the next project's
            // customization first, then change the source-bearing project path.
            target.set_user_properties_json?.(this._sceneUserPropertiesJson);
            target.set_project_dir?.(project?.path ?? '');
        }

        _pushAudioSamplesToSceneTargets() {
            const audioSamplesVariant = new GLib.Variant('ad', this._audioSamples ?? []);
            this._scenePaintables.forEach(paintable => paintable.set_audio_samples?.(audioSamplesVariant));
            this._sceneWidgets.forEach(widget => widget.set_audio_samples?.(audioSamplesVariant));
        }

        _pushSceneMediaStateToSceneTargets() {
            this._scenePaintables.forEach(paintable => paintable.set_media_state_json?.(this._sceneMediaStateJson));
            this._sceneWidgets.forEach(widget => widget.set_media_state_json?.(this._sceneMediaStateJson));
        }

        createWidgetForMonitor(index) {
            if (!this._project.entryPath)
                return this._createPlaceholderWidget('Scene package not found');

            if (haveSceneBackend) {
                const supportsPaintableClass = Boolean(HanabiScene.Paintable);
                const supportsGraphicsOffloadWidget = Boolean(Gtk.GraphicsOffload);
                const paintableSupported = Boolean(HanabiScene.Paintable?.is_supported?.());
                const canUsePaintable =
                    supportsPaintableClass &&
                    paintableSupported;
                const canUseGraphicsOffload =
                    haveGraphicsOffload &&
                    supportsGraphicsOffloadWidget;
                if (canUsePaintable) {
                    const paintable = new HanabiScene.Paintable({
                        'project-dir': this._project.path,
                        'user-properties-json': this._sceneUserPropertiesJson,
                        muted: state.getMute(),
                        volume: state.getVolume(),
                        fps: state.getSceneFps(),
                        'fill-mode': this._getSceneFillMode(),
                        playing: true,
                    });
                    paintable.set_media_state_json?.(this._sceneMediaStateJson);
                    paintable.set_audio_samples?.(new GLib.Variant('ad', this._audioSamples ?? []));
                    this._scenePaintables.push(paintable);
                    this._trackReady(index, paintable);

                    const picture = createConfiguredPicture(new Gtk.Picture({
                        paintable,
                    }));
                    this._scenePictures.push(picture);

                    if (canUseGraphicsOffload) {
                        const offload = setExpandFill(Gtk.GraphicsOffload.new(picture));
                        offload.set_enabled(Gtk.GraphicsOffloadEnabled.ENABLED);
                        this._sceneOffloads.push(offload);
                        this._trackRenderScale(index, paintable, offload, {
                            kind: 'paintable-offload',
                            picture,
                        });
                        return offload;
                    }

                    this._trackRenderScale(index, paintable, picture, {
                        kind: 'paintable-picture',
                        picture,
                    });
                    return picture;
                }

                const sceneWidget = setExpandFill(new HanabiScene.Widget({
                    'project-dir': this._project.path,
                    'user-properties-json': this._sceneUserPropertiesJson,
                    muted: state.getMute(),
                    volume: state.getVolume(),
                    fps: state.getSceneFps(),
                    'fill-mode': this._getSceneFillMode(),
                    playing: true,
                }));
                sceneWidget.set_media_state_json?.(this._sceneMediaStateJson);
                sceneWidget.set_audio_samples?.(new GLib.Variant('ad', this._audioSamples ?? []));
                this._sceneWidgets.push(sceneWidget);
                this._trackReady(index, sceneWidget);
                this._trackRenderScale(index, sceneWidget, sceneWidget, {
                    kind: 'native-widget',
                });
                return sceneWidget;
            }

            if (!this._project.previewPath)
                return this._createPlaceholderWidget('Scene preview is not available');

            const picture = createConfiguredPicture(
                Gtk.Picture.new_for_file(Gio.File.new_for_path(this._project.previewPath))
            );
            this._previewPictures.push(picture);
            this._readyStates.set(index, true);
            return picture;
        }

        setPlay() {
            this._setScenePlayback(true, true);
        }

        setPause() {
            this._setScenePlayback(false, true);
        }

        setMute(_mute) {
            this._scenePaintables.forEach(paintable => paintable.set_muted(_mute));
            this._sceneWidgets.forEach(widget => widget.set_muted(_mute));
        }

        setVolume(_volume) {
            this._scenePaintables.forEach(paintable => paintable.set_volume(_volume));
            this._sceneWidgets.forEach(widget => widget.set_volume(_volume));
        }

        setAudioSamples(samples) {
            this._audioSamples = Array.isArray(samples)
                ? samples
                : new Array(128).fill(0);
            this._pushAudioSamplesToSceneTargets();
        }

        setSceneFps(fps) {
            this._scenePaintables.forEach(paintable => paintable.set_fps?.(fps));
            this._sceneWidgets.forEach(widget => widget.set_fps?.(fps));
        }

        setSceneUserProperties(payload) {
            this._sceneUserPropertiesJson = JSON.stringify(payload ?? {});
            console.log(
                `HanabiScene properties: live-update payload-bytes=${this._sceneUserPropertiesJson.length} ` +
                `${describeTrackedSceneUserProperties(payload)}`
            );
            this._scenePaintables.forEach(paintable => paintable.set_user_properties_json?.(this._sceneUserPropertiesJson));
            this._sceneWidgets.forEach(widget => widget.set_user_properties_json?.(this._sceneUserPropertiesJson));
        }

        dispatchPointerEvent(event) {
            const sceneTarget = this._scenePaintables[event.monitorIndex] ?? this._sceneWidgets[event.monitorIndex];
            if (!sceneTarget)
                return;

            if (['mousemove', 'mousedown', 'mouseup'].includes(event.type) && sceneTarget.set_mouse_pos)
                sceneTarget.set_mouse_pos(event.x, event.y);

            if (event.button !== 1 || !sceneTarget.set_cursor_left_down)
                return;

            if (event.type === 'mousedown')
                sceneTarget.set_cursor_left_down(true);
            else if (event.type === 'mouseup')
                sceneTarget.set_cursor_left_down(false);
        }

        applyContentFit(fit) {
            if (!haveContentFit)
                return;

            const fillMode = this._getSceneFillMode();
            this._scenePaintables.forEach(paintable => paintable.set_fill_mode?.(fillMode));
            this._sceneWidgets.forEach(widget => widget.set_fill_mode?.(fillMode));
            this._scenePictures.forEach(picture => picture.set_content_fit(fit));
            this._previewPictures.forEach(picture => picture.set_content_fit(fit));
            console.log(
                `HanabiScene geometry: content-fit-applied fit=${this._describeContentFitForLog()} ` +
                `fill-mode=${fillMode} scene-pictures=${this._scenePictures.length} ` +
                `preview-pictures=${this._previewPictures.length}`
            );
        }

        waitUntilReady(callback) {
            this._readyCallback = callback;
            this._resolveReadyIfNeeded();
        }

        prepareForTransitionOut() {
            this._setScenePlayback(false, false);
            this._deactivateLiveSceneFeeds();
        }

        _getSceneFillMode() {
            if (!haveContentFit)
                return 2;

            switch (state.getContentFit()) {
            case Gtk.ContentFit.FILL:
                return 0;
            case Gtk.ContentFit.CONTAIN:
            case Gtk.ContentFit.SCALE_DOWN:
                return 1;
            case Gtk.ContentFit.COVER:
            default:
                return 2;
            }
        }

        _trackReady(index, target) {
            const updateReadyState = () => {
                this._readyStates.set(index, Boolean(target.ready));
                this._resolveReadyIfNeeded();
            };

            updateReadyState();
            this._readySignalHandlers.push([target, target.connect('notify::ready', updateReadyState)]);
        }

        _describeContentFitForLog() {
            if (!haveContentFit)
                return 'unavailable';

            const fit = state.getContentFit();
            switch (fit) {
            case Gtk.ContentFit.FILL:
                return `FILL(${fit})`;
            case Gtk.ContentFit.CONTAIN:
                return `CONTAIN(${fit})`;
            case Gtk.ContentFit.COVER:
                return `COVER(${fit})`;
            case Gtk.ContentFit.SCALE_DOWN:
                return `SCALE_DOWN(${fit})`;
            default:
                return `UNKNOWN(${fit})`;
            }
        }

        _describeMonitorForLog(index) {
            const monitor = this._renderer?._monitors?.[index] ?? null;
            const geometry = monitor?.get_geometry?.() ?? null;
            if (!geometry)
                return 'monitor=n/a monitor-aspect=n/a monitor-scale=n/a';

            return `monitor=${geometry.x},${geometry.y} ${geometry.width}x${geometry.height} ` +
                `monitor-aspect=${formatAspect(geometry.width, geometry.height)} ` +
                `monitor-scale=${monitor.get_scale_factor?.() ?? 'n/a'}`;
        }

        _describeWidgetForLog(label, widget) {
            if (!widget)
                return `${label}=n/a`;

            const width = widget.get_width?.() ?? 'n/a';
            const height = widget.get_height?.() ?? 'n/a';
            const scale = widget.get_scale_factor?.() ?? 'n/a';
            return `${label}=${width}x${height} ${label}-aspect=${formatAspect(width, height)} ${label}-scale=${scale}`;
        }

        _describeSceneTargetForLog(sceneTarget) {
            if (!sceneTarget)
                return 'target=n/a';

            let renderScale = 'n/a';
            try {
                renderScale = sceneTarget.get_property?.('render-scale') ?? 'n/a';
            } catch (_e) {
            }

            const intrinsicWidth = sceneTarget.get_intrinsic_width?.() ?? 'n/a';
            const intrinsicHeight = sceneTarget.get_intrinsic_height?.() ?? 'n/a';
            return `target-render-scale=${renderScale} target-intrinsic=${intrinsicWidth}x${intrinsicHeight} ` +
                `target-intrinsic-aspect=${formatAspect(intrinsicWidth, intrinsicHeight)}`;
        }

        _logScenePresentationGeometry(index, phase, sceneTarget, widget, options = {}) {
            const picture = options.picture ?? null;
            const root = widget?.get_root?.() ?? null;
            const parent = widget?.get_parent?.() ?? null;
            const pictureFit = picture?.get_content_fit?.() ?? 'n/a';

            console.log(
                `HanabiScene geometry: phase=${phase} monitor-index=${index} kind=${options.kind ?? 'unknown'} ` +
                `${this._describeMonitorForLog(index)} content-fit=${this._describeContentFitForLog()} ` +
                `fill-mode=${this._getSceneFillMode()} picture-fit=${pictureFit} ` +
                `${this._describeSceneTargetForLog(sceneTarget)} ` +
                `${this._describeWidgetForLog('presentation-widget', widget)} ` +
                `${this._describeWidgetForLog('picture', picture)} ` +
                `${this._describeWidgetForLog('parent', parent)} ` +
                `${this._describeWidgetForLog('root', root)}`
            );
        }

        _queueScenePresentationGeometryLog(index, phase, sceneTarget, widget, options) {
            // GTK may not have assigned widget sizes at construction time.  Queueing
            // an idle diagnostic captures the first allocation that GTK computes for
            // the presentation widget, which is the exact place a whole-scene aspect
            // stretch would appear after the Vulkan texture has already been rendered.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!this._destroyed)
                    this._logScenePresentationGeometry(index, phase, sceneTarget, widget, options);

                return GLib.SOURCE_REMOVE;
            });
        }

        _trackRenderScale(index, sceneTarget, widget, options = {}) {
            if (!sceneTarget?.set_property || !widget?.connect)
                return;

            const monitor = this._renderer._monitors?.[index] ?? null;
            const updateRenderScale = () => {
                const scale = Math.max(
                    1,
                    widget.get_scale_factor?.() ?? 1,
                    monitor?.get_scale_factor?.() ?? 1
                );
                sceneTarget.set_property('render-scale', scale);
                this._logScenePresentationGeometry(index, 'render-scale-update', sceneTarget, widget, options);
            };

            updateRenderScale();
            this._queueScenePresentationGeometryLog(index, 'post-create-idle', sceneTarget, widget, options);
            this._scaleSignalHandlers.push([widget, widget.connect('map', () => {
                updateRenderScale();
                this._queueScenePresentationGeometryLog(index, 'post-map-idle', sceneTarget, widget, options);
            })]);
            this._scaleSignalHandlers.push([widget, widget.connect('notify::scale-factor', updateRenderScale)]);
        }

        _resolveReadyIfNeeded() {
            if (this._readyResolved || !this._readyCallback)
                return;

            if (this._readyStates.size === 0 || [...this._readyStates.values()].every(Boolean)) {
                this._readyResolved = true;
                const callback = this._readyCallback;
                this._readyCallback = null;
                callback();
            }
        }

        _activateLiveSceneFeeds() {
            if (!this._mediaMonitor) {
                this._mediaMonitor = new SceneMediaMonitor(payload => {
                    this._sceneMediaStateJson = JSON.stringify(payload ?? {});
                    this._pushSceneMediaStateToSceneTargets();
                });
            }

            if (!this._audioSamplesBackendRegistered) {
                this._renderer.registerAudioSamplesBackend?.(this);
                this._audioSamplesBackendRegistered = true;
            }
        }

        _deactivateLiveSceneFeeds() {
            this._mediaMonitor?.destroy?.();
            this._mediaMonitor = null;

            if (this._audioSamplesBackendRegistered) {
                this._renderer.unregisterAudioSamplesBackend?.(this);
                this._audioSamplesBackendRegistered = false;
            }
        }

        _setScenePlayback(isPlaying, updateState) {
            if (isPlaying) {
                this._scenePaintables.forEach(paintable => paintable.play());
                this._sceneWidgets.forEach(widget => widget.play());
            } else {
                this._scenePaintables.forEach(paintable => paintable.pause());
                this._sceneWidgets.forEach(widget => widget.pause());
            }

            if (updateState)
                this._renderer._setPlayingState(isPlaying);
        }
    };
};
