var createBackendHelpers = env => {
    const {Gtk, flags, state} = env;
    const {haveContentFit} = flags;

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
    };
};
