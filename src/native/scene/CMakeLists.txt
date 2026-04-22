cmake_minimum_required(VERSION 3.14)
project(HanabiScene LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GTK4 REQUIRED gtk4)
pkg_check_modules(GDK_PIXBUF REQUIRED gdk-pixbuf-2.0)
pkg_check_modules(EPOXY REQUIRED epoxy)
pkg_check_modules(GI REQUIRED gobject-introspection-1.0)
pkg_check_modules(JSON_GLIB REQUIRED json-glib-1.0)

find_program(G_IR_SCANNER g-ir-scanner REQUIRED)
find_program(G_IR_COMPILER g-ir-compiler REQUIRED)

set(WESCENE_RENDERER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/wallpaper-scene-renderer)

add_subdirectory(${WESCENE_RENDERER_DIR}
                 ${CMAKE_CURRENT_BINARY_DIR}/wallpaper-scene-renderer)

add_library(HanabiScene SHARED
  hanabi-scene-dmabuf-texture.cpp
  hanabi-scene-paintable.cpp
  hanabi-scene-widget.cpp
)

target_include_directories(HanabiScene
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
  PRIVATE
    ${GTK4_INCLUDE_DIRS}
    ${GDK_PIXBUF_INCLUDE_DIRS}
    ${EPOXY_INCLUDE_DIRS}
    ${GI_INCLUDE_DIRS}
    ${JSON_GLIB_INCLUDE_DIRS}
    ${WESCENE_RENDERER_DIR}/src
    ${WESCENE_RENDERER_DIR}/third_party
)

target_compile_options(HanabiScene PRIVATE ${GTK4_CFLAGS_OTHER} ${GDK_PIXBUF_CFLAGS_OTHER} ${EPOXY_CFLAGS_OTHER} ${JSON_GLIB_CFLAGS_OTHER})
target_link_libraries(HanabiScene PRIVATE ${GTK4_LIBRARIES} ${GDK_PIXBUF_LIBRARIES} ${EPOXY_LIBRARIES} ${JSON_GLIB_LIBRARIES} wescene-renderer)

set_target_properties(HanabiScene PROPERTIES
  OUTPUT_NAME HanabiScene
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/out
)

set(SCENE_OUT_DIR ${CMAKE_CURRENT_BINARY_DIR}/out)
set(SCENE_GIR_DIR ${SCENE_OUT_DIR}/gir)
set(SCENE_GIR ${SCENE_GIR_DIR}/HanabiScene-1.0.gir)
set(SCENE_TYPELIB ${SCENE_GIR_DIR}/HanabiScene-1.0.typelib)

file(MAKE_DIRECTORY ${SCENE_GIR_DIR})
set(SCENE_GIR_CACHE_DIR ${CMAKE_CURRENT_BINARY_DIR}/gir-cache)
file(MAKE_DIRECTORY ${SCENE_GIR_CACHE_DIR})

add_custom_command(
  OUTPUT ${SCENE_GIR}
  COMMAND ${CMAKE_COMMAND} -E make_directory ${SCENE_GIR_DIR}
  COMMAND ${CMAKE_COMMAND} -E env
          XDG_CACHE_HOME=${SCENE_GIR_CACHE_DIR}
          LD_LIBRARY_PATH=${SCENE_OUT_DIR}:$ENV{LD_LIBRARY_PATH}
          ${G_IR_SCANNER}
          --warn-all
          --namespace=HanabiScene
          --nsversion=1.0
          --library=HanabiScene
          --library-path=${SCENE_OUT_DIR}
          --output ${SCENE_GIR}
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-scene-paintable.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-scene-paintable.cpp
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-scene-widget.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-scene-widget.cpp
          --include=GObject-2.0
          --include=Gtk-4.0
          --pkg gtk4
          --pkg gdk-pixbuf-2.0
          --pkg gobject-2.0
          --pkg gio-2.0
          --pkg json-glib-1.0
          --cflags-begin
          ${GTK4_CFLAGS}
          ${GDK_PIXBUF_CFLAGS}
          ${EPOXY_CFLAGS}
          ${JSON_GLIB_CFLAGS}
          -I${CMAKE_CURRENT_SOURCE_DIR}
          --cflags-end
  DEPENDS HanabiScene
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-scene-paintable.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-scene-paintable.cpp
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-scene-widget.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-scene-widget.cpp
  VERBATIM
)

add_custom_command(
  OUTPUT ${SCENE_TYPELIB}
  COMMAND ${G_IR_COMPILER} ${SCENE_GIR} -o ${SCENE_TYPELIB}
  DEPENDS ${SCENE_GIR}
  VERBATIM
)

add_custom_target(HanabiSceneTypelib ALL DEPENDS ${SCENE_TYPELIB})
