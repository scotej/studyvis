//! Linux launch-at-login entries. The locked auto-launch backend writes an
//! unquoted executable in Exec, so AppImage paths containing spaces cannot run
//! (#419). Keep the existing filename and opt-in commands; other OSes keep the
//! plugin's platform-specific startup mechanism.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

fn config_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map(|home| home.join(".config"))
        .map_err(|error| error.to_string())
}

// Desktop Entry Exec has two escaping layers: command-line quoting followed
// by the general string-value escapes. Percent is a field-code introducer,
// even inside a quoted executable, so a literal percent must become %%.
fn desktop_exec(executable: &Path) -> Result<String, String> {
    let executable = executable
        .to_str()
        .ok_or("The application path isn't valid UTF-8")?;
    if executable.contains(['=', '\0']) {
        return Err("The application path can't be represented in a Desktop Entry".into());
    }
    let mut argument = String::from("\"");
    for character in executable.chars() {
        match character {
            '"' | '`' | '$' | '\\' => {
                argument.push('\\');
                argument.push(character);
            }
            '%' => argument.push_str("%%"),
            _ => argument.push(character),
        }
    }
    argument.push('"');
    let mut value = String::new();
    for character in argument.chars() {
        match character {
            '\\' => value.push_str("\\\\"),
            '\n' => value.push_str("\\n"),
            '\r' => value.push_str("\\r"),
            '\t' => value.push_str("\\t"),
            _ => value.push(character),
        }
    }
    // GIO checks the executable before expanding %% and otherwise looks for
    // a literal doubled-percent filename. Use env only for that case so GIO
    // validates a stable executable and expands our actual path as its argument.
    // env execs the AppImage directly; no shell interprets any path characters.
    if executable.contains('%') {
        Ok(format!("/usr/bin/env -- {value}"))
    } else {
        Ok(value)
    }
}

fn entry_path(config: &Path, app_name: &str) -> PathBuf {
    config.join("autostart").join(format!("{app_name}.desktop"))
}

fn set_entry_enabled(
    config: &Path,
    app_name: &str,
    executable: &Path,
    enabled: bool,
) -> Result<(), String> {
    let path = entry_path(config, app_name);
    if !enabled {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        };
    }
    let command = desktop_exec(executable)?;
    std::fs::create_dir_all(path.parent().expect("autostart entry has a parent"))
        .map_err(|error| error.to_string())?;
    std::fs::write(
        path,
        format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName={app_name}\nExec={command}\nStartupNotify=false\nTerminal=false\n"
        ),
    )
    .map_err(|error| error.to_string())
}

pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let executable = app
        .env()
        .appimage
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(std::env::current_exe)
        .map_err(|error| error.to_string())?;
    set_entry_enabled(
        &config_directory(app)?,
        &app.package_info().name,
        &executable,
        enabled,
    )
}

pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    entry_path(&config_directory(app)?, &app.package_info().name)
        .try_exists()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use webkit2gtk::gio::prelude::AppInfoExt;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "studyvis-autostart-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn entries_remain_opt_in_and_disable_is_idempotent() {
        let fixture = Fixture::new();
        let executable = fixture.0.join("StudyVis.AppImage");
        let entry = entry_path(&fixture.0, "studyvis");
        assert!(!entry.exists());
        set_entry_enabled(&fixture.0, "studyvis", &executable, true).unwrap();
        assert!(entry.exists());
        set_entry_enabled(&fixture.0, "studyvis", &executable, false).unwrap();
        set_entry_enabled(&fixture.0, "studyvis", &executable, false).unwrap();
        assert!(!entry.exists());
    }

    #[test]
    fn gio_launches_actual_paths_with_spaces_and_reserved_characters() {
        let fixture = Fixture::new();
        for name in [
            "StudyVis.AppImage",
            "Study Apps/StudyVis.AppImage",
            "quoted \"$`\\%f/StudyVis.AppImage",
        ] {
            let executable = fixture.0.join(name);
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(
                &executable,
                "#!/bin/sh\nprintf '%s\\n%s\\n' \"$#\" \"$0\" > \"$0.marker\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            set_entry_enabled(&fixture.0, "studyvis", &executable, true).unwrap();
            let entry = entry_path(&fixture.0, "studyvis");
            let desktop =
                webkit2gtk::gio::DesktopAppInfo::from_filename(&entry).unwrap_or_else(|| {
                    panic!(
                        "GIO rejected {name}: {}",
                        std::fs::read_to_string(&entry).unwrap()
                    )
                });
            desktop
                .launch(&[], None::<&webkit2gtk::gio::AppLaunchContext>)
                .unwrap();
            let marker = PathBuf::from(format!("{}.marker", executable.display()));
            let deadline = Instant::now() + Duration::from_secs(5);
            while !marker.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(
                std::fs::read_to_string(marker).unwrap(),
                format!("0\n{}\n", executable.display())
            );
        }
    }

    #[test]
    fn invalid_exec_path_is_rejected_before_an_entry_is_created() {
        let fixture = Fixture::new();
        assert!(set_entry_enabled(
            &fixture.0,
            "studyvis",
            Path::new("/tmp/name=value.AppImage"),
            true
        )
        .is_err());
        assert!(!entry_path(&fixture.0, "studyvis").exists());
    }
}
