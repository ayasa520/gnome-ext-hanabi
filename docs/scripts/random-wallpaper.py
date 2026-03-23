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
