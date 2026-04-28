var createBackendHelpers = env => {
    const {Gtk, Gio, GLib, Soup, flags, state} = env;
    const {haveContentFit} = flags;

    const guessWebProjectMimeType = path => {
        if (typeof path !== 'string' || path === '')
            return 'application/octet-stream';

        try {
            const [contentType] = Gio.content_type_guess(path, null);
            const mimeType = contentType
                ? Gio.content_type_get_mime_type(contentType)
                : null;
            if (mimeType)
                return mimeType;
        } catch (_e) {
        }

        const extension = path.split('.').pop()?.toLowerCase?.() ?? '';
        switch (extension) {
        case 'css':
            return 'text/css';
        case 'gif':
            return 'image/gif';
        case 'htm':
        case 'html':
            return 'text/html';
        case 'jpeg':
        case 'jpg':
            return 'image/jpeg';
        case 'js':
            return 'application/javascript';
        case 'json':
            return 'application/json';
        case 'mp3':
            return 'audio/mpeg';
        case 'mp4':
            return 'video/mp4';
        case 'ogg':
            return 'audio/ogg';
        case 'png':
            return 'image/png';
        case 'svg':
            return 'image/svg+xml';
        case 'wav':
            return 'audio/wav';
        case 'webm':
            return 'video/webm';
        case 'webp':
            return 'image/webp';
        default:
            return 'application/octet-stream';
        }
    };

    const normalizeServedWebProjectMimeType = (path, sniffedMimeType) => {
        const extension = typeof path === 'string'
            ? path.split('.').pop()?.toLowerCase?.() ?? ''
            : '';

        // Wallpaper Engine web projects often use legacy XHTML doctypes while
        // still relying on permissive HTML syntax such as boolean `autoplay`
        // attributes and unquoted placeholder source values. Gio can sniff those
        // `.html` files as `application/xhtml+xml`, which makes WPEWebKit switch
        // to XML parsing and stop at the first non-XHTML attribute. Extension wins
        // for browser entry documents so both WPEWebKit and gstcef load the same
        // forgiving HTML surface.
        if (extension === 'html' || extension === 'htm')
            return 'text/html';

        return sniffedMimeType || guessWebProjectMimeType(path);
    };

    const parseWebProjectRangeHeader = (value, totalLength) => {
        if (typeof value !== 'string' || !value.startsWith('bytes=') || !Number.isFinite(totalLength) || totalLength <= 0)
            return null;

        const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i);
        if (!match)
            return null;

        const [, startText, endText] = match;
        if (startText === '' && endText === '')
            return null;

        let start = 0;
        let end = totalLength - 1;

        if (startText === '') {
            const suffixLength = Number.parseInt(endText, 10);
            if (!Number.isFinite(suffixLength) || suffixLength <= 0)
                return null;
            start = Math.max(0, totalLength - suffixLength);
        } else {
            start = Number.parseInt(startText, 10);
            if (!Number.isFinite(start) || start < 0 || start >= totalLength)
                return null;

            if (endText !== '') {
                end = Number.parseInt(endText, 10);
                if (!Number.isFinite(end) || end < start)
                    return null;
                end = Math.min(end, totalLength - 1);
            }
        }

        return {start, end};
    };

    const isWebProjectFileNotFoundError = error => {
        try {
            return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) === true;
        } catch (_e) {
            return false;
        }
    };

    const hasUnclosedJavaScriptBlockComment = source => {
        let quote = '';
        let blockComment = false;
        let lineComment = false;
        let escaped = false;

        for (let i = 0; i < source.length; i++) {
            const char = source[i];
            const next = source[i + 1] ?? '';

            if (lineComment) {
                if (char === '\n' || char === '\r')
                    lineComment = false;
                continue;
            }

            if (blockComment) {
                // JavaScript block comments do not nest. While scanning a
                // comment, only the first closing delimiter can return the
                // lexer to normal source text; any inner "/*" is comment text.
                if (char === '*' && next === '/') {
                    blockComment = false;
                    i++;
                }
                continue;
            }

            if (quote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }

                if (char === '\\') {
                    escaped = true;
                    continue;
                }

                if (char === quote)
                    quote = '';
                continue;
            }

            if (char === '"' || char === '\'' || char === '`') {
                quote = char;
                continue;
            }

            if (char === '/' && next === '/') {
                lineComment = true;
                i++;
                continue;
            }

            if (char === '/' && next === '*') {
                blockComment = true;
                i++;
            }
        }

        return blockComment;
    };

    const repairLegacyWebProjectJavaScript = (relativePath, data) => {
        if (!/\.js$/i.test(relativePath))
            return data;

        const source = new TextDecoder().decode(data);
        if (!hasUnclosedJavaScriptBlockComment(source))
            return data;

        // Some Wallpaper Engine HTML5 exports ship optional extension files that
        // disable their whole body with a trailing block comment, which Chromium
        // rejects as a syntax error. Closing that comment in the served response
        // preserves the author's intended no-op script without mutating the
        // workshop file on disk.
        console.warn(`Repairing local web project script with an unclosed block comment: ${relativePath}`);
        return new TextEncoder().encode(`${source}\n*/\n`);
    };

    const injectWebProjectHeadFragment = (html, fragment) => {
        // HTML compatibility fragments must be injected into the live response
        // instead of the workshop directory. Keeping this helper small gives the
        // individual repair rules one responsibility: detect their legacy quirk
        // and provide the fragment that fixes it.
        if (/<\/head>/i.test(html))
            return html.replace(/<\/head>/i, `${fragment}</head>`);
        if (/<body[^>]*>/i.test(html))
            return html.replace(/<body[^>]*>/i, match => `${match}${fragment}`);
        return `${fragment}${html}`;
    };

    const legacyAbsoluteClockPattern = /<div\b(?=[^>]*\bid\s*=\s*["']time["'])(?=[^>]*\bclass\s*=\s*["'][^"']*\btime\b[^"']*["'])(?=[^>]*\bstyle\s*=\s*["'][^"']*position\s*:\s*absolute)(?=[^>]*\bstyle\s*=\s*["'][^"']*left\s*:\s*500px)(?=[^>]*\bstyle\s*=\s*["'][^"']*top\s*:\s*400px)[^>]*>/i;
    const legacyAbsoluteClockCenteringStyle = `<style id="hanabi-legacy-absolute-clock-centering">
#time.time {
  position: absolute !important;
  left: 50% !important;
  top: 50% !important;
  -webkit-transform: translate(-50%, -50%) translateZ(20px) rotateX(calc(var(--mouse-y) * 80deg)) rotateY(calc(var(--mouse-x) * 45deg)) !important;
  transform: translate(-50%, -50%) translateZ(20px) rotateX(calc(var(--mouse-y) * 80deg)) rotateY(calc(var(--mouse-x) * 45deg)) !important;
}
</style>`;

    const repairLegacyWebProjectHtml = (relativePath, html) => {
        if (!/\.(?:html?|xhtml)$/i.test(relativePath))
            return html;

        if (html.includes('hanabi-legacy-absolute-clock-centering'))
            return html;

        if (!legacyAbsoluteClockPattern.test(html))
            return html;

        // Some older Wallpaper Engine web projects place a clock at fixed
        // 1920x1080 design coordinates, for example left:500px/top:400px. That
        // happens to look centered on the author's source canvas, but it drifts
        // when Hanabi renders the page in a different logical viewport. Override
        // only this recognizable legacy clock shape in the served response, while
        // preserving its original mouse-driven 3D transform.
        console.warn(`Centering legacy fixed-coordinate clock in local web project document: ${relativePath}`);
        return injectWebProjectHeadFragment(html, legacyAbsoluteClockCenteringStyle);
    };

    // LocalWebProjectHttpServer is the single document-root adapter for web
    // wallpapers. Both WPEWebKit and gstcefsrc consume this abstraction so
    // backend-specific rendering code does not need to know how project files,
    // HTTP ranges, root-entry fallback, or optional HTML bootstrap injection are
    // served.
    class LocalWebProjectHttpServer {
        constructor(project, options = {}) {
            this._project = project;
            this._server = null;
            this._baseUri = '';
            this._browserUri = '';
            this._stateVersion = 0;
            this._state = {
                version: this._stateVersion,
                userProperties: options.initialUserProperties ?? {},
                generalProperties: options.initialGeneralProperties ?? {},
                paused: Boolean(options.initialPaused),
                directorySnapshots: options.initialDirectorySnapshots ?? {},
            };
            this._localMediaHttpUrlPrefix = options.localMediaHttpUrlPrefix ?? '';
            this._bootstrapScriptBuilder = typeof options.bootstrapScriptBuilder === 'function'
                ? options.bootstrapScriptBuilder
                : null;
            this._start();
        }

        get browserUri() {
            return this._browserUri;
        }

        destroy() {
            // The HTTP server owns the loopback listener for the active web
            // wallpaper. Disconnect it explicitly during backend teardown so a
            // project switch releases the old document root immediately instead
            // of waiting for JavaScript object finalization.
            try {
                this._server?.disconnect?.();
            } catch (_e) {
            }
            this._server = null;
            this._baseUri = '';
            this._browserUri = '';
        }

        updateState(nextState = {}) {
            this._state = {
                ...this._state,
                ...nextState,
                directorySnapshots: nextState.directorySnapshots ?? this._state.directorySnapshots,
                userProperties: nextState.userProperties ?? this._state.userProperties,
                generalProperties: nextState.generalProperties ?? this._state.generalProperties,
                version: ++this._stateVersion,
            };
        }

        _start() {
            if (!Soup?.Server) {
                console.warn('Local web project HTTP server unavailable: libsoup is missing');
                return;
            }

            try {
                this._server = new Soup.Server({
                    server_header: 'HanabiWebProject',
                });
                this._server.add_handler('/', (_server, message) => {
                    this._handleMessage(message);
                });
                this._server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);

                const uri = this._server.get_uris()?.[0] ?? null;
                if (!uri) {
                    console.warn('Local web project HTTP server started without an advertised URI');
                    return;
                }

                this._baseUri = uri.to_string().replace(/\/$/, '');

                // Backends intentionally load the project root URL, not the
                // entry file URL. The HTTP document root stays aligned with the
                // wallpaper directory, while "/" still resolves to the manifest
                // entry internally for projects whose entry is index.html or a
                // custom HTML file.
                this._browserUri = `${this._baseUri}/`;
                console.log(`Local web project HTTP server listening at ${this._browserUri}`);
            } catch (e) {
                this._server = null;
                this._baseUri = '';
                this._browserUri = '';
                console.warn(`Failed to start local web project HTTP server: ${e}`);
            }
        }

        _handleMessage(message) {
            const method = message.get_method?.() ?? 'GET';
            if (method !== 'GET' && method !== 'HEAD') {
                message.set_status(Soup.Status.NOT_IMPLEMENTED, null);
                return;
            }

            const requestPath = message.get_uri()?.get_path?.() ?? '/';
            if (requestPath === '/__hanabi__/state') {
                this._serveState(method, message);
                return;
            }

            this._serveProjectFile(method, message, requestPath);
        }

        _serveState(method, message) {
            const responseHeaders = message.get_response_headers();
            responseHeaders.replace('Cache-Control', 'no-store, no-cache, must-revalidate');
            responseHeaders.replace('Pragma', 'no-cache');
            responseHeaders.replace('Expires', '0');

            const body = method === 'HEAD'
                ? new Uint8Array(0)
                : new TextEncoder().encode(JSON.stringify(this._state));
            responseHeaders.set_content_type('application/json', null);
            responseHeaders.set_content_length(body.length);
            message.set_status(Soup.Status.OK, null);
            message.set_response('application/json', Soup.MemoryUse.COPY, body);
        }

        _serveProjectFile(method, message, requestPath) {
            const relativePath = this._resolveRequestedRelativePath(requestPath);
            if (!relativePath) {
                message.set_status(Soup.Status.NOT_FOUND, null);
                return;
            }

            const filePath = GLib.build_filenamev([this._project.path, relativePath]);
            if (!this._isWithinProjectRoot(filePath)) {
                message.set_status(Soup.Status.NOT_FOUND, null);
                return;
            }

            const file = Gio.File.new_for_path(filePath);
            if (!file.query_exists(null)) {
                // GameMaker HTML5 projects commonly use a synchronous HEAD
                // request to implement file_exists(). Returning 404 for a
                // missing save/config file keeps that probe false, while a 500
                // makes the runtime believe the file exists and then parse the
                // empty GET response as project data.
                message.set_status(Soup.Status.NOT_FOUND, null);
                return;
            }

            try {
                const info = file.query_info(
                    'standard::content-type,standard::size,standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                if (info.get_file_type() !== Gio.FileType.REGULAR) {
                    message.set_status(Soup.Status.NOT_FOUND, null);
                    return;
                }

                const [bytes] = file.load_bytes(null);
                let data = bytes.get_data();
                let mimeType = normalizeServedWebProjectMimeType(
                    filePath,
                    Gio.content_type_get_mime_type(info.get_content_type?.() ?? '')
                );
                const isHtml = /\.(?:html?|xhtml)$/i.test(filePath);
                data = repairLegacyWebProjectJavaScript(relativePath, data);

                if (isHtml) {
                    let html = new TextDecoder().decode(data);
                    html = repairLegacyWebProjectHtml(relativePath, html);
                    if (this._bootstrapScriptBuilder)
                        html = this._injectBootstrapScript(html);
                    data = new TextEncoder().encode(html);
                    mimeType = 'text/html';
                }

                const responseHeaders = message.get_response_headers();
                responseHeaders.replace('Accept-Ranges', 'bytes');
                responseHeaders.set_content_type(mimeType, null);

                const requestedRange = parseWebProjectRangeHeader(
                    message.get_request_headers()?.get_one?.('Range') ?? '',
                    data.length
                );

                if ((message.get_request_headers()?.get_one?.('Range') ?? '') && !requestedRange) {
                    message.set_status(416, 'Range Not Satisfiable');
                    responseHeaders.replace('Content-Range', `bytes */${data.length}`);
                    message.set_response(
                        'application/octet-stream',
                        Soup.MemoryUse.STATIC,
                        new Uint8Array(0)
                    );
                    return;
                }

                const start = requestedRange?.start ?? 0;
                const end = requestedRange?.end ?? (data.length - 1);
                const body = method === 'HEAD'
                    ? new Uint8Array(0)
                    : data.slice(start, end + 1);

                if (requestedRange) {
                    message.set_status(Soup.Status.PARTIAL_CONTENT, null);
                    responseHeaders.set_content_range(start, end, data.length);
                    responseHeaders.set_content_length(end - start + 1);
                } else {
                    message.set_status(Soup.Status.OK, null);
                    responseHeaders.set_content_length(data.length);
                }

                message.set_response(
                    mimeType,
                    Soup.MemoryUse.COPY,
                    body
                );
            } catch (e) {
                if (isWebProjectFileNotFoundError(e)) {
                    message.set_status(Soup.Status.NOT_FOUND, null);
                    return;
                }

                console.warn(`Failed to serve local web project file ${filePath}: ${e}`);
                message.set_status(Soup.Status.INTERNAL_SERVER_ERROR, null);
            }
        }

        _injectBootstrapScript(html) {
            const script = `<script>${this._bootstrapScriptBuilder('/__hanabi__/state', this._localMediaHttpUrlPrefix, this._state)}</script>`;
            return injectWebProjectHeadFragment(html, script);
        }

        _resolveRequestedRelativePath(requestPath) {
            const normalizedRequestPath = requestPath === '/' ? `/${this._project.entry ?? 'index.html'}` : requestPath;
            const trimmed = normalizedRequestPath.replace(/^\/+/, '');
            if (trimmed === '')
                return this._project.entry ?? 'index.html';

            let decoded = trimmed;
            try {
                decoded = decodeURIComponent(trimmed);
            } catch (_e) {
            }

            const segments = decoded
                .split('/')
                .filter(segment => segment !== '' && segment !== '.');
            if (segments.some(segment => segment === '..'))
                return null;

            return segments.join('/');
        }

        _isWithinProjectRoot(candidatePath) {
            const normalizedRoot = GLib.build_filenamev([this._project.path]);
            const normalizedCandidate = GLib.build_filenamev([candidatePath]);
            return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
        }
    }

    const setExpandFill = widget => {
        widget.set({
            hexpand: true,
            vexpand: true,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
        });
        return widget;
    };

    const createConfiguredPicture = picture => {
        setExpandFill(picture);
        picture.set({
            can_shrink: true,
        });
        if (haveContentFit)
            picture.set_content_fit(state.getContentFit());
        return picture;
    };

    const buildWebPointerDispatchScript = scriptEvent => `
        (() => {
            const data = ${JSON.stringify(scriptEvent)};
            const state = window.__hanabiPointerState || (window.__hanabiPointerState = {
                isDown: false,
                isDragging: false,
                downX: 0,
                downY: 0,
                downButton: -1,
                downTarget: null,
                dragTarget: null,
                dragDataTransfer: null,
                hasMovedSinceDown: false,
                lastClickAt: 0,
                lastClickX: 0,
                lastClickY: 0,
            });
            const target = document.elementFromPoint(data.x, data.y) || document.body;
            if (!target)
                return;
            const normalizedButton = Math.max(0, data.button - 1);

            const common = {
                bubbles: true,
                cancelable: true,
                clientX: data.x,
                clientY: data.y,
                screenX: data.x,
                screenY: data.y,
                button: normalizedButton,
                buttons: data.type === 'mousedown'
                    ? (1 << normalizedButton)
                    : (data.type === 'mouseup' ? 0 : (state.isDown ? (1 << Math.max(0, state.downButton)) : 0)),
            };

            const pointerEventType = data.type === 'mousedown'
                ? 'pointerdown'
                : (data.type === 'mouseup' ? 'pointerup' : (data.type === 'mousemove' ? 'pointermove' : data.type));
            if (typeof PointerEvent !== 'undefined' && pointerEventType !== 'wheel') {
                const pointerEvent = new PointerEvent(pointerEventType, {
                    ...common,
                    pointerId: 1,
                    pointerType: 'mouse',
                    isPrimary: true,
                    pressure: data.type === 'mouseup' ? 0 : (state.isDown || data.type === 'mousedown' ? 0.5 : 0),
                });
                target.dispatchEvent(pointerEvent);
            }

            let domEvent;
            if (data.type === 'wheel') {
                domEvent = new WheelEvent('wheel', {
                    ...common,
                    deltaX: data.deltaX,
                    deltaY: data.deltaY,
                });
            } else {
                domEvent = new MouseEvent(data.type, common);
            }
            target.dispatchEvent(domEvent);

            const distance = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);
            const CLICK_MOVE_TOLERANCE = 8;
            const DBLCLICK_MOVE_TOLERANCE = 8;
            const DBLCLICK_INTERVAL_MS = 400;
            const DRAG_START_TOLERANCE = 8;
            const updateRangeValueFromPointer = (rangeEl, shouldDispatchChange) => {
                if (!rangeEl || rangeEl.tagName !== 'INPUT' || String(rangeEl.type).toLowerCase() !== 'range')
                    return;

                const min = Number(rangeEl.min || 0);
                const max = Number(rangeEl.max || 100);
                const step = Number(rangeEl.step || 1);
                const rect = rangeEl.getBoundingClientRect();
                if (!rect || rect.width <= 0 || max <= min)
                    return;

                const rawRatio = (data.x - rect.left) / rect.width;
                const ratio = Math.max(0, Math.min(1, rawRatio));
                const rawValue = min + ratio * (max - min);
                const steppedValue = step > 0 ? Math.round(rawValue / step) * step : rawValue;
                const clampedValue = Math.max(min, Math.min(max, steppedValue));
                const nextValue = String(clampedValue);
                if (rangeEl.value === nextValue)
                    return;

                rangeEl.value = nextValue;
                rangeEl.dispatchEvent(new Event('input', {bubbles: true}));
                if (shouldDispatchChange)
                    rangeEl.dispatchEvent(new Event('change', {bubbles: true}));
            };
            const createDataTransfer = () => {
                if (typeof DataTransfer !== 'undefined') {
                    try {
                        return new DataTransfer();
                    } catch (_e) {
                    }
                }

                return {
                    dropEffect: 'move',
                    effectAllowed: 'all',
                    files: [],
                    items: [],
                    types: [],
                    _data: {},
                    clearData(type) {
                        if (type)
                            delete this._data[type];
                        else
                            this._data = {};
                        this.types = Object.keys(this._data);
                    },
                    getData(type) {
                        return this._data[type] ?? '';
                    },
                    setData(type, value) {
                        this._data[type] = String(value);
                        this.types = Object.keys(this._data);
                    },
                    setDragImage() {},
                };
            };
            const createDragEvent = (eventType, eventTarget, dataTransfer) => {
                const dragCommon = {
                    bubbles: true,
                    cancelable: true,
                    clientX: data.x,
                    clientY: data.y,
                    screenX: data.x,
                    screenY: data.y,
                    button: normalizedButton,
                    buttons: state.isDown ? (1 << Math.max(0, state.downButton)) : 0,
                };

                let dragEvent;
                if (typeof DragEvent !== 'undefined') {
                    try {
                        dragEvent = new DragEvent(eventType, {
                            ...dragCommon,
                            dataTransfer,
                        });
                    } catch (_e) {
                    }
                }

                if (!dragEvent) {
                    dragEvent = new MouseEvent(eventType, dragCommon);
                    try {
                        Object.defineProperty(dragEvent, 'dataTransfer', {
                            value: dataTransfer,
                            configurable: true,
                        });
                    } catch (_e) {
                    }
                }

                eventTarget.dispatchEvent(dragEvent);
            };

            if (data.type === 'mousedown') {
                state.isDown = true;
                state.isDragging = false;
                state.downX = data.x;
                state.downY = data.y;
                state.downButton = normalizedButton;
                state.downTarget = target;
                state.dragTarget = null;
                state.dragDataTransfer = null;
                state.hasMovedSinceDown = false;
            } else if (data.type === 'mousemove' && state.isDown) {
                if (distance(data.x, data.y, state.downX, state.downY) > CLICK_MOVE_TOLERANCE)
                    state.hasMovedSinceDown = true;

                const shouldStartDrag =
                    !state.isDragging &&
                    state.downButton === 0 &&
                    distance(data.x, data.y, state.downX, state.downY) > DRAG_START_TOLERANCE;
                if (shouldStartDrag && state.downTarget) {
                    state.isDragging = true;
                    state.dragTarget = state.downTarget;
                    state.dragDataTransfer = createDataTransfer();
                    createDragEvent('dragstart', state.dragTarget, state.dragDataTransfer);
                }

                if (state.isDragging && state.dragTarget) {
                    createDragEvent('drag', state.dragTarget, state.dragDataTransfer);
                    createDragEvent('dragover', target, state.dragDataTransfer);
                }

                if (state.downButton === 0 && state.downTarget)
                    updateRangeValueFromPointer(state.downTarget, false);
            } else if (data.type === 'mouseup') {
                const releasedButton = normalizedButton;
                const sameButton = state.downButton === releasedButton;
                const isDrag = state.hasMovedSinceDown;
                const sameTarget = state.downTarget && (target === state.downTarget || state.downTarget.contains(target));

                if (state.isDragging && state.dragTarget) {
                    createDragEvent('drop', target, state.dragDataTransfer);
                    createDragEvent('dragend', state.dragTarget, state.dragDataTransfer);
                }

                if (state.downButton === 0 && state.downTarget)
                    updateRangeValueFromPointer(state.downTarget, true);

                if (state.isDown && sameButton && !isDrag && sameTarget) {
                    const clickTarget = state.downTarget;
                    const clickEvent = new MouseEvent('click', {
                        ...common,
                        detail: 1,
                    });
                    clickTarget.dispatchEvent(clickEvent);

                    const now = Date.now();
                    const isDoubleClick =
                        now - state.lastClickAt <= DBLCLICK_INTERVAL_MS &&
                        distance(data.x, data.y, state.lastClickX, state.lastClickY) <= DBLCLICK_MOVE_TOLERANCE;

                    if (isDoubleClick) {
                        const dblClickEvent = new MouseEvent('dblclick', {
                            ...common,
                            detail: 2,
                        });
                        clickTarget.dispatchEvent(dblClickEvent);
                        state.lastClickAt = 0;
                    } else {
                        state.lastClickAt = now;
                        state.lastClickX = data.x;
                        state.lastClickY = data.y;
                    }
                }

                state.isDown = false;
                state.isDragging = false;
                state.downButton = -1;
                state.downTarget = null;
                state.dragTarget = null;
                state.dragDataTransfer = null;
                state.hasMovedSinceDown = false;
            }
        })();
    `;

    return {
        setExpandFill,
        createConfiguredPicture,
        buildWebPointerDispatchScript,
        LocalWebProjectHttpServer,
    };
};
