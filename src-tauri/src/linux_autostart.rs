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

fn executable_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.env()
        .appimage
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(std::env::current_exe)
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
    let contents = entry_contents(app_name, executable)?;
    std::fs::create_dir_all(path.parent().expect("autostart entry has a parent"))
        .map_err(|error| error.to_string())?;
    std::fs::write(path, contents).map_err(|error| error.to_string())
}

fn entry_contents(app_name: &str, executable: &Path) -> Result<String, String> {
    let command = desktop_exec(executable)?;
    Ok(format!(
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName={app_name}\nExec={command}\nStartupNotify=false\nTerminal=false\n"
    ))
}

// Startup may repair only the exact template produced by auto-launch 0.5.0
// with StudyVis's empty argument list. The old executable can name a previous
// version; recognizing the template does not require it to equal today's path.
fn is_legacy_entry(contents: &str, app_name: &str, executable: &Path) -> bool {
    let prefix = format!(
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName={app_name}\nComment={app_name}startup script\nExec="
    );
    contents
        .strip_prefix(&prefix)
        .and_then(|value| value.strip_suffix(" \nStartupNotify=false\nTerminal=false"))
        .is_some_and(|path| {
            let old = Path::new(path);
            !path.contains(['\n', '\r', '\0'])
                && old.is_absolute()
                // A raw Exec with arguments can look like one absolute path.
                // Repair only today's known path or an existing full old path;
                // unknown removed paths require an explicit user enable.
                && (old == executable
                    || (!has_symlink(old).unwrap_or(true)
                        && std::fs::metadata(old).is_ok_and(|metadata| metadata.is_file())))
        })
}

fn has_symlink(path: &Path) -> Result<bool, String> {
    // Include ancestor directories, so a custom linked config/autostart path
    // is not silently followed by automatic startup repair or migration.
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(false)
}

fn repair_legacy_entry(config: &Path, app_name: &str, executable: &Path) -> Result<bool, String> {
    let path = entry_path(config, app_name);
    if has_symlink(&path)? {
        return Ok(false);
    }
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Ok(false);
    }
    let contents = std::fs::read(&path).map_err(|error| error.to_string())?;
    if !std::str::from_utf8(&contents)
        .is_ok_and(|value| is_legacy_entry(value, app_name, executable))
    {
        return Ok(false);
    }
    // Keep the existing opted-in file intact unless a complete replacement can
    // be renamed into place. Never truncate it during automatic startup repair.
    use std::io::Write;
    let contents = entry_contents(app_name, executable)?;
    let temporary = path.with_extension(format!("desktop.repair-{}", std::process::id()));
    let mut replacement = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = replacement
        .write_all(contents.as_bytes())
        .and_then(|()| replacement.set_permissions(metadata.permissions()));
    drop(replacement);
    let result = result.and_then(|()| std::fs::rename(&temporary, &path));
    if let Err(error) = result {
        if let Err(cleanup) = std::fs::remove_file(&temporary) {
            return Err(format!(
                "{error}; autostart repair cleanup failed: {cleanup}"
            ));
        }
        return Err(error.to_string());
    }
    Ok(true)
}

pub fn repair_legacy<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    repair_legacy_entry(
        &config_directory(app)?,
        &app.package_info().name,
        &executable_path(app)?,
    )?;
    Ok(())
}

pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    set_entry_enabled(
        &config_directory(app)?,
        &app.package_info().name,
        &executable_path(app)?,
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

    fn legacy_entry(executable: &Path) -> String {
        format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName=studyvis\nComment=studyvisstartup script\nExec={} \nStartupNotify=false\nTerminal=false",
            executable.display()
        )
    }

    #[test]
    fn startup_repairs_old_version_entry_and_gio_launches_current_spaced_percent_path() {
        let fixture = Fixture::new();
        let old = fixture.0.join("Old version/StudyVis-v1.AppImage");
        let current = fixture.0.join("New version 100%/StudyVis-v2.AppImage");
        for executable in [&old, &current] {
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(
                executable,
                "#!/bin/sh\nprintf '%s\\n%s\\n' \"$#\" \"$0\" > \"$0.marker\"\n",
            )
            .unwrap();
            std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let entry = entry_path(&fixture.0, "studyvis");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, legacy_entry(&old)).unwrap();
        assert!(webkit2gtk::gio::DesktopAppInfo::from_filename(&entry).is_none());
        assert!(repair_legacy_entry(&fixture.0, "studyvis", &current).unwrap());
        webkit2gtk::gio::DesktopAppInfo::from_filename(&entry)
            .expect("repaired entry must parse")
            .launch(&[], None::<&webkit2gtk::gio::AppLaunchContext>)
            .unwrap();
        let marker = PathBuf::from(format!("{}.marker", current.display()));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            std::fs::read_to_string(marker).unwrap(),
            format!("0\n{}\n", current.display())
        );
        assert!(!PathBuf::from(format!("{}.marker", old.display())).exists());
    }

    #[test]
    fn startup_preserves_absent_custom_and_already_valid_entries() {
        let fixture = Fixture::new();
        let executable = fixture.0.join("StudyVis.AppImage");
        let entry = entry_path(&fixture.0, "studyvis");
        assert!(!repair_legacy_entry(&fixture.0, "studyvis", &executable).unwrap());
        assert!(!entry.exists());
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        let old = fixture.0.join("Old version/StudyVis.AppImage");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, "old executable").unwrap();
        let legacy = legacy_entry(&old);
        for custom in [
            legacy.replace("Comment=studyvisstartup script", "Comment=custom"),
            format!("{legacy}\nHidden=true\n"),
            legacy_entry(Path::new("relative/StudyVis.AppImage")),
            legacy_entry(Path::new("/usr/bin/env --custom-arg")),
            legacy_entry(Path::new("/missing/old/StudyVis.AppImage")),
        ] {
            std::fs::write(&entry, &custom).unwrap();
            assert!(!repair_legacy_entry(&fixture.0, "studyvis", &executable).unwrap());
            assert_eq!(std::fs::read_to_string(&entry).unwrap(), custom);
        }
        // A currently running executable is known even if an updater has
        // replaced/removed its on-disk filename since this process launched.
        std::fs::write(&entry, legacy_entry(&executable)).unwrap();
        assert!(repair_legacy_entry(&fixture.0, "studyvis", &executable).unwrap());
        let valid = std::fs::read(&entry).unwrap();
        assert!(!repair_legacy_entry(&fixture.0, "studyvis", Path::new("/new/version")).unwrap());
        assert_eq!(std::fs::read(entry).unwrap(), valid);
    }

    #[test]
    fn failed_atomic_repair_preserves_the_prior_entry() {
        let fixture = Fixture::new();
        let current = fixture.0.join("StudyVis.AppImage");
        let entry = entry_path(&fixture.0, "studyvis");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        let original = legacy_entry(&current);
        std::fs::write(&entry, &original).unwrap();
        let temporary = entry.with_extension(format!("desktop.repair-{}", std::process::id()));
        std::fs::write(&temporary, "existing unrelated file").unwrap();
        assert!(repair_legacy_entry(&fixture.0, "studyvis", &current).is_err());
        assert_eq!(std::fs::read_to_string(&entry).unwrap(), original);
        assert_eq!(
            std::fs::read_to_string(temporary).unwrap(),
            "existing unrelated file"
        );
    }

    #[test]
    fn startup_does_not_follow_entry_or_directory_symlinks() {
        let fixture = Fixture::new();
        let config = fixture.0.join("config");
        let executable = fixture.0.join("StudyVis.AppImage");
        let target = fixture.0.join("custom.desktop");
        let original = legacy_entry(&executable);
        std::fs::write(&target, &original).unwrap();
        let entry = entry_path(&config, "studyvis");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &entry).unwrap();
        assert!(!repair_legacy_entry(&config, "studyvis", &executable).unwrap());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), original);
        std::fs::remove_file(&entry).unwrap();
        std::fs::write(&entry, &original).unwrap();
        let alias = fixture.0.join("alias");
        std::os::unix::fs::symlink(&config, &alias).unwrap();
        assert!(!repair_legacy_entry(&alias, "studyvis", &executable).unwrap());
        assert_eq!(std::fs::read_to_string(&entry).unwrap(), original);
        let autostart_alias = fixture.0.join("another-config");
        std::fs::create_dir(&autostart_alias).unwrap();
        std::os::unix::fs::symlink(config.join("autostart"), autostart_alias.join("autostart"))
            .unwrap();
        assert!(!repair_legacy_entry(&autostart_alias, "studyvis", &executable).unwrap());
        assert_eq!(std::fs::read_to_string(entry).unwrap(), original);
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
