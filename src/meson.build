metaconf = configuration_data()
metaconf.set('settings_schema', schema)
metaconf.set('uuid', uuid)
metaconf.set('version', meson.project_version())

runtimeconf = configuration_data()
runtimeconf.set('native_scene_libdir', libdir)
runtimeconf.set('native_scene_typelib_dir', typelib_dir)

configure_file(
  input: 'metadata.json.in',
  output: 'metadata.json',
  configuration: metaconf,
  install_dir: install_dir
)

configured_native_runtime = configure_file(
  input: 'renderer/nativeRuntimeConfig.js.in',
  output: 'nativeRuntimeConfig.js',
  configuration: runtimeconf,
)

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
  'renderer/backend/scene.js',
]

install_data(root_sources + extra_sources, install_dir: install_dir)
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
