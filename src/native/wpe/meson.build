cmake_exe = find_program('cmake')
sh_exe = find_program('sh')

wpe_build_dir = meson.current_build_dir() / 'cmake-build'
wpe_artifacts = custom_target(
  'hanabi-wpe-artifacts',
  input: files(
    'CMakeLists.txt',
    'hanabi-wpe-dmabuf-texture.c',
    'hanabi-wpe-dmabuf-texture.h',
    'hanabi-wpe-paintable.c',
    'hanabi-wpe-paintable.h',
  ),
  output: [
    'libHanabiWpe.so',
    'HanabiWpe-1.0.typelib',
  ],
  command: [
    sh_exe, '-eu', '-c',
    'echo "==> Configuring HanabiWpe CMake project" && ' +
    '"$1" -S "$2" -B "$3" -DCMAKE_BUILD_TYPE=RelWithDebInfo && ' +
    'echo "==> Building HanabiWpe native bridge" && ' +
    '"$1" --build "$3" --verbose && ' +
    'echo "==> Collecting HanabiWpe build artifacts" && ' +
    '"$1" -E copy_if_different "$3/out/libHanabiWpe.so" "$4" && ' +
    '"$1" -E copy_if_different "$3/out/gir/HanabiWpe-1.0.typelib" "$5"',
    'sh',
    cmake_exe,
    meson.current_source_dir(),
    wpe_build_dir,
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
