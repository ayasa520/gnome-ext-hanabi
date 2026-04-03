project(
  'hanabi-extension',
  version: '1',
  license: 'GPL-3.0-or-later',
  meson_version: '>= 0.57.0'
)

uuid = 'hanabi-extension@jeffshee.github.io'

prefix = get_option('prefix')
datadir = join_paths(prefix, get_option('datadir'))
libdir = join_paths(prefix, get_option('libdir'))
typelib_dir = join_paths(libdir, 'girepository-1.0')
extensions_dir = join_paths(datadir, 'gnome-shell', 'extensions')
install_dir = join_paths(extensions_dir, uuid)

schema = 'io.github.jeffshee.hanabi-extension'
schema_dir = join_paths(datadir, 'glib-2.0', 'schemas')

gnome = import('gnome')
i18n = import('i18n')

runconf = configuration_data()
runconf.set('extension_install_dir', install_dir)

configure_file(
  input: 'run-config.sh.in',
  output: 'run-config.sh',
  configuration: runconf,
)

npm_exe = find_program('npm', required: false)
if npm_exe.found()
  run_target('dev', command: [ npm_exe, 'install', '--save-dev' ])
endif

subdir('src')

gnome.post_install(
  glib_compile_schemas: true,
)
