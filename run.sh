#!/bin/bash

# Check if the script is being run as root
if [ "$(id -u)" -eq 0 ]; then
    echo "Error: This script should not be run as root" >&2
    exit 1
fi

UUID="hanabi-extension@jeffshee.github.io"

if [ "$1" == "install" ]; then
    shift
    rm -rf .build
    MESON_ARGS=("$@")
    HAS_PREFIX=0
    for arg in "${MESON_ARGS[@]}"; do
        case "$arg" in
            --prefix|--prefix=*)
                HAS_PREFIX=1
                break
                ;;
        esac
    done
    if [ "$HAS_PREFIX" -eq 0 ]; then
        MESON_ARGS=(--prefix="$HOME/.local/" "${MESON_ARGS[@]}")
    fi
    meson setup .build "${MESON_ARGS[@]}" && ninja -C .build install
elif [ "$1" == "enable" ]; then
    gnome-extensions enable "$UUID"
elif [ "$1" == "disable" ]; then
    gnome-extensions disable "$UUID"
elif [ "$1" == "prefs" ]; then
    gnome-extensions prefs "$UUID"
elif [ "$1" == "reset" ]; then
    gnome-extensions reset "$UUID"
elif [ "$1" == "uninstall" ]; then
    gnome-extensions uninstall "$UUID"
elif [ "$1" == "renderer" ]; then
    shift
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    RUN_CONFIG="$SCRIPT_DIR/.build/run-config.sh"
    if [ ! -f "$RUN_CONFIG" ]; then
        echo "Error: renderer requires an installed build. Run '$0 install' first." >&2
        exit 1
    fi

    # shellcheck source=/dev/null
    . "$RUN_CONFIG"

    RENDERER_SCRIPT="$HANABI_EXTENSION_INSTALL_DIR/renderer/renderer.js"
    if [ ! -f "$RENDERER_SCRIPT" ]; then
        echo "Error: Installed renderer not found at '$RENDERER_SCRIPT'. Run '$0 install' first." >&2
        exit 1
    fi

    "$RENDERER_SCRIPT" --standalone "$@"
elif [ "$1" == "log" ]; then
    journalctl -f -o cat /usr/bin/gnome-shell
elif [ "$1" == "pot" ]; then
    POT_FILE="src/po/hanabi-extension@jeffshee.github.io.pot"
    find src/ -iname "*.js" -print0 | xargs -0 xgettext --from-code=UTF-8 --output="$POT_FILE"
    sed -i "s/SOME DESCRIPTIVE TITLE./Gnome Shell Extension - Hanabi/g" "$POT_FILE"
    sed -i "s/YEAR THE PACKAGE'S COPYRIGHT HOLDER/2023 Jeff Shee (jeffshee8969@gmail.com)/g" "$POT_FILE"
    sed -i "s/PACKAGE package/gnome-ext-hanabi package/g" "$POT_FILE"
    sed -i "s/PACKAGE VERSION/1/g" "$POT_FILE"
    sed -i "s/CHARSET/UTF-8/g" "$POT_FILE"
elif [ "$1" == "help" ]; then
    echo "Valid actions are:"
    echo "  - install: Installs the extension."
    echo "  - enable: Enables the extension."
    echo "  - disable: Disables the extension."
    echo "  - prefs: Opens the extension preferences."
    echo "  - reset: Resets the extension settings."
    echo "  - uninstall: Uninstalls the extension."
    echo "  - renderer: Runs the renderer with the given arguments."
    echo "  - log: Displays the GNOME Shell log."
    echo "  - pot: Generate template pot file."
    echo "Usage: $0 [action]"
    echo "Run '$0 help' to see this message."
    exit 0
else
    echo "Error: Invalid action. Run '$0 help' to see valid actions." >&2
    exit 1
fi
