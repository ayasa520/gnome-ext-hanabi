# Scripting Guide

The Hanabi extension can be extended and automated using scripts, allowing users to customize their wallpaper experience.  
This guide provides an overview of how to use scripts to interact with the Hanabi extension.

## Using gsettings

You can modify all Hanabi extension settings through the `gsettings` command.

For example, to change the wallpaper project, use the following command:

```bash
gsettings set io.github.jeffshee.hanabi-extension project-path '<project_path>'
```

Replace `<project_path>` with the path to a directory containing a `project.json` wallpaper project.

### Example: Switching Wallpaper with Night Theme Switcher Extension

When using the Hanabi extension in combination with the [Night Theme Switcher Extension](https://gitlab.com/rmnvgr/nightthemeswitcher-gnome-shell-extension/) by Romain Vigier, you can run different commands to switch wallpapers based on the selected theme.

Here's how to do it:

- Sunrise

```bash
gsettings set io.github.jeffshee.hanabi-extension project-path '<light_theme_project_path>'
```

- Sunset

```bash
gsettings set io.github.jeffshee.hanabi-extension project-path '<dark_theme_project_path>'
```

![](images/night-theme-switcher-run-commands.png)

#### Result 😍

![](images/night-theme-switcher.gif)

## Writing scripts

_Note: You can find all the example scripts in the `docs/scripts` directory._

### Example: Random Wallpaper

You can write a script that randomly selects a wallpaper project from a directory and sets it as your wallpaper at specified intervals.

Here's a sample script in Python:

```python
import os
import random
import subprocess
import time

dir_path = '/path/to/wallpaper-projects-directory' # Set the path to your directory
interval = 30 # Set the interval in seconds

while True:
    project_paths = []
    for entry in os.scandir(dir_path):
        if entry.is_dir() and os.path.isfile(os.path.join(entry.path, 'project.json')):
            project_paths.append(entry.path)

    if project_paths:
        project_path = random.choice(project_paths)
        gsettings_command = f"gsettings set io.github.jeffshee.hanabi-extension project-path '{project_path}'"
        print(f"Project path: {project_path}")
        subprocess.run(["bash", "-c", gsettings_command])

    time.sleep(interval)
```

## Contributing

If you've created a useful script, please consider submitting a pull request, making it available for others to use!

When submitting, please include your script in the `docs/scripts` directory.

Contributions to improve this guide are also welcome! ✨
