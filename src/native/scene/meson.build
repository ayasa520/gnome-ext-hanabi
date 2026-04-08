cmake_exe = find_program('cmake')
sh_exe = find_program('sh')

scene_build_dir = meson.current_build_dir() / 'cmake-build'
scene_artifacts = custom_target(
  'hanabi-scene-artifacts',
  input: files(
    'CMakeLists.txt',
    'hanabi-scene-dmabuf-texture.cpp',
    'hanabi-scene-paintable.cpp',
    'hanabi-scene-paintable.h',
    'hanabi-scene-widget.cpp',
    'hanabi-scene-widget.h',
  ),
  output: [
    'libHanabiScene.so',
    'HanabiScene-1.0.typelib',
  ],
  command: [
    sh_exe, '-eu', '-c',
    'echo "==> Configuring HanabiScene CMake project" && ' +
    '"$1" -S "$2" -B "$3" -DCMAKE_BUILD_TYPE=RelWithDebInfo && ' +
    'echo "==> Building HanabiScene native bridge" && ' +
    '"$1" --build "$3" --verbose && ' +
    'echo "==> Collecting HanabiScene build artifacts" && ' +
    '"$1" -E copy_if_different "$3/out/libHanabiScene.so" "$4" && ' +
    '"$1" -E copy_if_different "$3/out/gir/HanabiScene-1.0.typelib" "$5"',
    'sh',
    cmake_exe,
    meson.current_source_dir(),
    scene_build_dir,
    '@OUTPUT0@',
    '@OUTPUT1@',
  ],
  build_by_default: true,
  build_always_stale: true,
  console: true,
  install: true,
  install_dir: [
    libdir,
    typelib_dir,
  ],
)
