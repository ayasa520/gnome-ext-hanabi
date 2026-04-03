cmake_minimum_required(VERSION 3.14)
project(HanabiWpe LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GTK4 REQUIRED gtk4)
pkg_check_modules(WPE_PLATFORM REQUIRED wpe-platform-2.0)
pkg_check_modules(GI REQUIRED gobject-introspection-1.0)

find_program(G_IR_SCANNER g-ir-scanner REQUIRED)
find_program(G_IR_COMPILER g-ir-compiler REQUIRED)

add_library(HanabiWpe SHARED
  hanabi-wpe-dmabuf-texture.c
  hanabi-wpe-paintable.c
)

target_include_directories(HanabiWpe
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
  PRIVATE
    ${GTK4_INCLUDE_DIRS}
    ${WPE_PLATFORM_INCLUDE_DIRS}
    ${GI_INCLUDE_DIRS}
)

target_compile_options(HanabiWpe PRIVATE ${GTK4_CFLAGS_OTHER} ${WPE_PLATFORM_CFLAGS_OTHER})
target_link_libraries(HanabiWpe PRIVATE ${GTK4_LIBRARIES} ${WPE_PLATFORM_LIBRARIES})

set_target_properties(HanabiWpe PROPERTIES
  OUTPUT_NAME HanabiWpe
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/out
)

set(WPE_OUT_DIR ${CMAKE_CURRENT_BINARY_DIR}/out)
set(WPE_GIR_DIR ${WPE_OUT_DIR}/gir)
set(WPE_GIR ${WPE_GIR_DIR}/HanabiWpe-1.0.gir)
set(WPE_TYPELIB ${WPE_GIR_DIR}/HanabiWpe-1.0.typelib)

file(MAKE_DIRECTORY ${WPE_GIR_DIR})
set(WPE_GIR_CACHE_DIR ${CMAKE_CURRENT_BINARY_DIR}/gir-cache)
file(MAKE_DIRECTORY ${WPE_GIR_CACHE_DIR})

add_custom_command(
  OUTPUT ${WPE_GIR}
  COMMAND ${CMAKE_COMMAND} -E make_directory ${WPE_GIR_DIR}
  COMMAND ${CMAKE_COMMAND} -E env
          XDG_CACHE_HOME=${WPE_GIR_CACHE_DIR}
          LD_LIBRARY_PATH=${WPE_OUT_DIR}:$ENV{LD_LIBRARY_PATH}
          ${G_IR_SCANNER}
          --warn-all
          --namespace=HanabiWpe
          --nsversion=1.0
          --library=HanabiWpe
          --library-path=${WPE_OUT_DIR}
          --output ${WPE_GIR}
          --identifier-prefix=HanabiWpe
          --symbol-prefix=hanabi_wpe
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-wpe-dmabuf-texture.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-wpe-dmabuf-texture.c
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-wpe-paintable.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-wpe-paintable.c
          --include=GObject-2.0
          --include=Gtk-4.0
          --include=WPEPlatform-2.0
          --pkg gtk4
          --pkg wpe-platform-2.0
          --pkg gobject-2.0
          --pkg gio-2.0
          --cflags-begin
          ${GTK4_CFLAGS}
          ${WPE_PLATFORM_CFLAGS}
          -I${CMAKE_CURRENT_SOURCE_DIR}
          --cflags-end
  DEPENDS HanabiWpe
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-wpe-dmabuf-texture.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-wpe-dmabuf-texture.c
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-wpe-paintable.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-wpe-paintable.c
  VERBATIM
)

add_custom_command(
  OUTPUT ${WPE_TYPELIB}
  COMMAND ${G_IR_COMPILER} ${WPE_GIR} -o ${WPE_TYPELIB}
  DEPENDS ${WPE_GIR}
  VERBATIM
)

add_custom_target(HanabiWpeTypelib ALL DEPENDS ${WPE_TYPELIB})
