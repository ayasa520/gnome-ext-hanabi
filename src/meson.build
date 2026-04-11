metaconf = configuration_data()
metaconf.set('settings_schema', schema)
metaconf.set('uuid', uuid)
metaconf.set('version', meson.project_version())
sh = find_program('sh')
cmake_exe = find_program('cmake')

gstcefsrc_install_dir = join_paths(libdir, 'hanabi-extension', 'gstcefsrc')

runtimeconf = configuration_data()
runtimeconf.set('native_scene_libdir', libdir)
runtimeconf.set('native_scene_typelib_dir', typelib_dir)
runtimeconf.set('enable_gstcefsrc_web_backend', get_option('gstcefsrc-web-backend') ? 'true' : 'false')
runtimeconf.set_quoted('gstcefsrc_artifacts_dir', gstcefsrc_install_dir)
runtimeconf.set_quoted('gstcefsrc_subprocess_path', join_paths(gstcefsrc_install_dir, 'gstcefsubprocess'))
runtimeconf.set_quoted('gstcefsrc_cache_dir', '/tmp/gstcef-cache')
runtimeconf.set_quoted(
  'gstcefsrc_chrome_extra_flags',
  'use-angle=default,ignore-gpu-blocklist,enable-gpu-rasterization,enable-logging=stderr'
)

configure_file(
  input: 'metadata.json.in',
  output: 'metadata.json',
  configuration: metaconf,
  install_dir: install_dir
)

configured_build_config = configure_file(
  input: 'buildConfig.js.in',
  output: 'buildConfig.js',
  configuration: runtimeconf,
)

configured_native_runtime = configure_file(
  input: 'renderer/nativeRuntimeConfig.js.in',
  output: 'nativeRuntimeConfig.js',
  configuration: runtimeconf,
)

if get_option('gstcefsrc-web-backend')
  gstcefsrc_cef_version = '139.0.28+g55ab8a8+chromium-139.0.7258.139'
  gstcefsrc_cef_escaped_version = '139.0.28%2Bg55ab8a8%2Bchromium-139.0.7258.139'
  gstcefsrc_cef_platform = ''
  if host_machine.system() == 'linux'
    if ['aarch64', 'arm', 'arm64'].contains(host_machine.cpu_family())
      gstcefsrc_cef_platform = 'linuxarm64'
    elif host_machine.cpu_family() == 'x86_64'
      gstcefsrc_cef_platform = 'linux64'
    elif ['x86', 'x86_32', 'i686'].contains(host_machine.cpu_family())
      gstcefsrc_cef_platform = 'linux32'
    endif
  elif host_machine.system() == 'darwin'
    if ['aarch64', 'arm64'].contains(host_machine.cpu_family())
      gstcefsrc_cef_platform = 'macosarm64'
    else
      gstcefsrc_cef_platform = 'macosx64'
    endif
  elif host_machine.system() == 'windows'
    if host_machine.cpu_family() == 'x86_64'
      gstcefsrc_cef_platform = 'windows64'
    else
      gstcefsrc_cef_platform = 'windows32'
    endif
  endif

  if gstcefsrc_cef_platform == ''
    error('Unsupported gstcefsrc CEF platform for @0@/@1@'.format(
      host_machine.system(),
      host_machine.cpu_family(),
    ))
  endif

  gstcefsrc_buildconf = configuration_data()
  gstcefsrc_buildconf.set('gstcefsrc_source_dir', join_paths(meson.project_source_root(), 'src', 'native', 'third_party', 'gstcefsrc'))
  gstcefsrc_buildconf.set('gstcefsrc_build_dir', join_paths(meson.current_build_dir(), 'gstcefsrc-build'))
  gstcefsrc_buildconf.set('gstcefsrc_stage_dir', join_paths(meson.current_build_dir(), 'gstcefsrc-stage'))
  gstcefsrc_buildconf.set('gstcefsrc_install_dir', gstcefsrc_install_dir)
  gstcefsrc_buildconf.set('gstcefsrc_download_stamp_path', join_paths(meson.current_build_dir(), 'gstcefsrc-cef-downloaded.stamp'))
  gstcefsrc_buildconf.set('gstcefsrc_cef_platform', gstcefsrc_cef_platform)
  gstcefsrc_buildconf.set('gstcefsrc_cef_version', gstcefsrc_cef_version)
  gstcefsrc_buildconf.set('gstcefsrc_cef_escaped_version', gstcefsrc_cef_escaped_version)
  gstcefsrc_buildconf.set(
    'gstcefsrc_cef_root_dir',
    join_paths(
      meson.project_source_root(),
      'src',
      'native',
      'third_party',
      'gstcefsrc',
      'third_party',
      'cef',
      'cef_binary_@0@_@1@'.format(gstcefsrc_cef_version, gstcefsrc_cef_platform),
    )
  )

  configured_gstcefsrc_download_script = configure_file(
    input: 'download-gstcefsrc-cef.cmake.in',
    output: 'download-gstcefsrc-cef.cmake',
    configuration: gstcefsrc_buildconf,
  )

  configured_gstcefsrc_build_script = configure_file(
    input: 'build-gstcefsrc-subproject.sh.in',
    output: 'build-gstcefsrc-subproject.sh',
    configuration: gstcefsrc_buildconf,
  )

  configured_gstcefsrc_install_script = configure_file(
    input: 'install-gstcefsrc-artifacts.sh.in',
    output: 'install-gstcefsrc-artifacts.sh',
    configuration: gstcefsrc_buildconf,
  )

  gstcefsrc_download_stamp = custom_target(
    'gstcefsrc-cef-download',
    output: 'gstcefsrc-cef-downloaded.stamp',
    command: [
      sh,
      '-eu',
      '-c',
      'echo "==> Downloading gstcefsrc CEF bundle" && "$1" -P "$2"',
      'sh',
      cmake_exe,
      configured_gstcefsrc_download_script,
    ],
    build_by_default: true,
    build_always_stale: true,
    console: true,
  )

  gstcefsrc_build_stamp = custom_target(
    'gstcefsrc-subproject-build',
    output: 'gstcefsrc-built.stamp',
    input: gstcefsrc_download_stamp,
    command: [
      sh,
      configured_gstcefsrc_build_script,
      '@INPUT0@',
      '@OUTPUT@',
    ],
    build_by_default: true,
    build_always_stale: true,
    console: true,
  )

  meson.add_install_script(
    sh,
    configured_gstcefsrc_install_script,
    gstcefsrc_build_stamp,
  )
endif

root_sources = [
  'extension.js',
  'prefs.js',
  'project.js',
]

common_sources = [
  'common/projectLoader.js',
]

prefs_sources = [
  'prefs/main.js',
  'prefs/projectBrowser.js',
  'prefs/rows.js',
]

shell_integration_sources = [
  'shell/integration/autoPause.js',
  'shell/integration/gnomeShellOverride.js',
  'shell/integration/roundedCornersEffect.js',
  'shell/integration/windowManager.js',
]

shell_logger_source = 'shell/logger.js'

shell_service_sources = [
  'shell/services/dbus.js',
  'shell/services/launcher.js',
  'shell/services/playbackState.js',
  'shell/services/rendererManager.js',
  'shell/services/settingsBindings.js',
]

shell_ui_sources = [
  'shell/ui/panelMenu.js',
  'shell/ui/wallpaper.js',
]

extra_sources = [
  '../LICENSE',
  'assets/hanabi-symbolic.svg',
]

renderer = [
  'renderer/renderer.js',
  'renderer/backends.js',
  'renderer/stylesheet.css',
]

renderer_backends = [
  'renderer/backend/base.js',
  'renderer/backend/common.js',
  'renderer/backend/video.js',
  'renderer/backend/web.js',
  'renderer/backend/webGstCef.js',
  'renderer/backend/scene.js',
]

install_data(root_sources + extra_sources, install_dir: install_dir)
install_data(configured_build_config, install_dir: install_dir)
install_data(common_sources, install_dir: join_paths(install_dir, 'common'))
install_data(prefs_sources, install_dir: join_paths(install_dir, 'prefs'))
install_data(shell_logger_source, install_dir: join_paths(install_dir, 'shell'))
install_data(shell_integration_sources, install_dir: join_paths(install_dir, 'shell', 'integration'))
install_data(shell_service_sources, install_dir: join_paths(install_dir, 'shell', 'services'))
install_data(shell_ui_sources, install_dir: join_paths(install_dir, 'shell', 'ui'))

install_data(renderer, install_dir: join_paths(install_dir, 'renderer'))
install_data(configured_native_runtime, install_dir: join_paths(install_dir, 'renderer'))
install_data(renderer_backends, install_dir: join_paths(install_dir, 'renderer', 'backend'))

install_data('schemas/@0@.gschema.xml'.format(schema),
  install_dir: schema_dir
)

subdir('native/scene')
subdir('native/wpe')
subdir('po')
