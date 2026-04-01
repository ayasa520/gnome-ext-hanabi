#!/bin/bash

set -eu

EXTENSION_DIR="$1"
SOURCE_ROOT="${MESON_SOURCE_ROOT}"
BUILD_ROOT="${MESON_BUILD_ROOT}"
DESTDIR_ROOT="${DESTDIR:-}"

SCENE_SRC_DIR="${SOURCE_ROOT}/native/scene"
SCENE_BUILD_DIR="${BUILD_ROOT}/native-scene"
SCENE_LIB_DIR="${SCENE_BUILD_DIR}/out"
SCENE_GIR_DIR="${SCENE_BUILD_DIR}/out/gir"

INSTALL_ROOT="${DESTDIR_ROOT}${EXTENSION_DIR}/native/scene"
INSTALL_LIB_DIR="${INSTALL_ROOT}/lib"
INSTALL_TYPELIB_DIR="${INSTALL_ROOT}/girepository-1.0"

mkdir -p "${SCENE_BUILD_DIR}" "${SCENE_GIR_DIR}"

cmake -S "${SCENE_SRC_DIR}" -B "${SCENE_BUILD_DIR}"
cmake --build "${SCENE_BUILD_DIR}" -j"$(nproc)"

mkdir -p /tmp/gir-cache
XDG_CACHE_HOME=/tmp/gir-cache \
g-ir-scanner \
  --warn-all \
  --namespace=HanabiScene \
  --nsversion=1.0 \
  --library=HanabiScene \
  --library-path="${SCENE_LIB_DIR}" \
  --output "${SCENE_GIR_DIR}/HanabiScene-1.0.gir" \
  "${SCENE_SRC_DIR}/hanabi-scene-paintable.h" \
  "${SCENE_SRC_DIR}/hanabi-scene-paintable.cpp" \
  "${SCENE_SRC_DIR}/hanabi-scene-widget.h" \
  "${SCENE_SRC_DIR}/hanabi-scene-widget.cpp" \
  --include=GObject-2.0 \
  --include=Gtk-4.0 \
  --pkg gtk4 \
  --pkg gobject-2.0 \
  --pkg gio-2.0 \
  --pkg json-glib-1.0 \
  --cflags-begin \
  $(pkg-config --cflags gtk4 gobject-2.0 gio-2.0 json-glib-1.0 epoxy) \
  -I"${SCENE_SRC_DIR}" \
  --cflags-end

g-ir-compiler "${SCENE_GIR_DIR}/HanabiScene-1.0.gir" -o "${SCENE_GIR_DIR}/HanabiScene-1.0.typelib"

mkdir -p "${INSTALL_LIB_DIR}" "${INSTALL_TYPELIB_DIR}"
install -m 0755 "${SCENE_LIB_DIR}/libHanabiScene.so" "${INSTALL_LIB_DIR}/libHanabiScene.so"
install -m 0644 "${SCENE_GIR_DIR}/HanabiScene-1.0.typelib" "${INSTALL_TYPELIB_DIR}/HanabiScene-1.0.typelib"
