//! Linux launch-at-login entries. The locked auto-launch backend writes an
//! unquoted executable in Exec, so AppImage paths containing spaces cannot run
//! (#419). Keep the existing filename and opt-in commands; other OSes keep the
//! plugin's platform-specific startup mechanism.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

fn selected_config_directory(home: &Path, configured: Option<&OsStr>) -> PathBuf {
    // XDG paths must be absolute; empty/unset/relative values use the default.
    configured
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"))
}

fn config_directories<R: Runtime>(app: &AppHandle<R>) -> Result<(PathBuf, PathBuf), String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let selected = selected_config_directory(&home, std::env::var_os("XDG_CONFIG_HOME").as_deref());
    Ok((selected, home.join(".config")))
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
        return remove_entry(config, app_name);
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

fn remove_entry(config: &Path, app_name: &str) -> Result<(), String> {
    match std::fs::remove_file(entry_path(config, app_name)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
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
    // Include ancestors so custom autostart paths and executable aliases do
    // not silently acquire ownership during automatic repair.
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

fn install_legacy_entry(legacy: &Path, selected: &Path) -> Result<(), String> {
    use std::io::Write;
    let contents = std::fs::read(legacy).map_err(|error| error.to_string())?;
    let permissions = std::fs::metadata(legacy)
        .map_err(|error| error.to_string())?
        .permissions();
    std::fs::create_dir_all(selected.parent().expect("entry has a parent"))
        .map_err(|error| error.to_string())?;
    let temporary = selected.with_extension(format!("desktop.migrate-{}", std::process::id()));
    let mut entry = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let written = entry
        .write_all(&contents)
        .and_then(|()| entry.set_permissions(permissions));
    drop(entry);
    // A complete same-directory inode becomes visible atomically. Unlike
    // rename, hard_link cannot replace a selected entry created concurrently.
    let installed = written.and_then(|()| std::fs::hard_link(&temporary, selected));
    let cleanup = std::fs::remove_file(&temporary);
    if let Err(error) = installed {
        return match cleanup {
            Ok(()) => Err(error.to_string()),
            Err(cleanup) => Err(format!(
                "{error}; autostart migration temporary cleanup failed: {cleanup}"
            )),
        };
    }
    if let Err(error) = cleanup {
        // The legacy source is still intact at this point. Do not leave an
        // extra selected launch entry if temporary cleanup prevents success.
        if let Err(rollback) = std::fs::remove_file(selected) {
            return Err(format!(
                "{error}; autostart migration rollback failed: {rollback}"
            ));
        }
        return Err(error.to_string());
    }
    Ok(())
}

fn migrate_legacy_entry(
    selected: &Path,
    legacy: &Path,
    app_name: &str,
    executable: &Path,
) -> Result<(), String> {
    migrate_legacy_entry_with_cleanup(selected, legacy, app_name, executable, remove_entry)
}

fn migrate_legacy_entry_with_cleanup(
    selected: &Path,
    legacy: &Path,
    app_name: &str,
    executable: &Path,
    cleanup: impl FnOnce(&Path, &str) -> Result<(), String>,
) -> Result<(), String> {
    // #420: HOME and XDG_CONFIG_HOME select roots, which may be directory
    // aliases. Resolve those roots while retaining link checks below them.
    let resolve = |path: &Path| {
        let mut ancestor = path;
        let mut missing = Vec::new();
        loop {
            match ancestor.canonicalize() {
                Ok(mut resolved) => {
                    for component in missing.into_iter().rev() {
                        resolved.push(component);
                    }
                    break Ok(resolved);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let component = ancestor.file_name().ok_or_else(|| error.to_string())?;
                    missing.push(component.to_owned());
                    ancestor = ancestor.parent().ok_or_else(|| error.to_string())?;
                }
                Err(error) => break Err(error.to_string()),
            }
        }
    };
    let selected_directory = resolve(selected)?;
    let legacy_directory = resolve(legacy)?;
    let selected = selected_directory.as_path();
    let legacy = legacy_directory.as_path();
    let selected_path = entry_path(selected, app_name);
    let legacy_path = entry_path(legacy, app_name);
    // Automatic migration and repair must leave custom linked paths untouched.
    if has_symlink(&selected_path)? {
        return Ok(());
    }
    if has_symlink(&legacy_path)? {
        repair_legacy_entry(selected, app_name, executable)?;
        return Ok(());
    }
    // Absolute XDG paths may contain `..` without being symlinks. Compare the
    // existing directories so cleanup cannot unlink their shared launch entry.
    let same_directory = selected
        .canonicalize()
        .ok()
        .zip(legacy.canonicalize().ok())
        .is_some_and(|(selected, legacy)| selected == legacy);
    if selected == legacy
        || same_directory
        || !legacy_path
            .try_exists()
            .map_err(|error| error.to_string())?
    {
        repair_legacy_entry(selected, app_name, executable)?;
        return Ok(());
    }
    let already_selected = selected_path
        .try_exists()
        .map_err(|error| error.to_string())?;
    // The existing fallback conveys opt-in, but may contain custom fields.
    // Move its bytes intact; only the recognized old template is repaired below.
    if !already_selected {
        install_legacy_entry(&legacy_path, &selected_path)?;
    }
    if let Err(error) = cleanup(legacy, app_name) {
        // A failed legacy cleanup must not leave a newly duplicated entry.
        if !already_selected {
            if let Err(rollback) = remove_entry(selected, app_name) {
                return Err(format!(
                    "{error}; autostart migration rollback failed: {rollback}"
                ));
            }
        }
        return Err(error);
    }
    repair_legacy_entry(selected, app_name, executable)?;
    Ok(())
}

pub fn migrate<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let (selected, legacy) = config_directories(app)?;
    migrate_legacy_entry(
        &selected,
        &legacy,
        &app.package_info().name,
        &executable_path(app)?,
    )
}

pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let (selected, legacy) = config_directories(app)?;
    let app_name = &app.package_info().name;
    if enabled {
        migrate_legacy_entry(&selected, &legacy, app_name, &executable_path(app)?)?;
        set_entry_enabled(&selected, app_name, &executable_path(app)?, true)
    } else {
        // Clear both owned locations, so a stale fallback entry cannot re-enable
        // login launch after the configured entry has been disabled.
        if selected != legacy {
            remove_entry(&legacy, app_name)?;
        }
        remove_entry(&selected, app_name)
    }
}

pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    migrate(app)?;
    let (selected, _) = config_directories(app)?;
    entry_path(&selected, &app.package_info().name)
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
    fn xdg_selection_honors_only_absolute_nonempty_paths() {
        let home = Path::new("/owned/home");
        for configured in [None, Some(OsStr::new("")), Some(OsStr::new("relative"))] {
            assert_eq!(
                selected_config_directory(home, configured),
                home.join(".config")
            );
        }
        assert_eq!(
            selected_config_directory(home, Some(OsStr::new("/owned/config"))),
            PathBuf::from("/owned/config")
        );
    }

    #[test]
    fn custom_config_creation_detection_removal_and_legacy_migration_preserve_opt_in() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("home/.config");
        let selected = fixture.0.join("custom-config");
        let executable = fixture.0.join("StudyVis.AppImage");
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert!(!entry_path(&selected, "studyvis").exists());
        assert!(!entry_path(&legacy, "studyvis").exists());
        set_entry_enabled(&selected, "studyvis", &executable, true).unwrap();
        assert!(entry_path(&selected, "studyvis").try_exists().unwrap());
        assert!(!entry_path(&legacy, "studyvis").exists());
        remove_entry(&selected, "studyvis").unwrap();
        assert!(!entry_path(&selected, "studyvis").exists());
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert!(entry_path(&selected, "studyvis").exists());
        assert!(!entry_path(&legacy, "studyvis").exists());
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        remove_entry(&selected, "studyvis").unwrap();
        remove_entry(&legacy, "studyvis").unwrap();
        assert!(!entry_path(&selected, "studyvis").exists());
        assert!(!entry_path(&legacy, "studyvis").exists());
    }

    #[test]
    fn migration_preserves_existing_selected_entry_and_rolls_back_on_legacy_cleanup_failure() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("legacy");
        let selected = fixture.0.join("selected");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        set_entry_enabled(&selected, "studyvis", Path::new("/already/selected"), true).unwrap();
        let existing = std::fs::read(entry_path(&selected, "studyvis")).unwrap();
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert_eq!(
            std::fs::read(entry_path(&selected, "studyvis")).unwrap(),
            existing
        );
        assert!(!entry_path(&legacy, "studyvis").exists());
        remove_entry(&selected, "studyvis").unwrap();
        // A directory at the owned filename deterministically rejects removal,
        // including when this suite runs as root.
        std::fs::create_dir(entry_path(&legacy, "studyvis")).unwrap();
        assert!(migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).is_err());
        assert!(!entry_path(&selected, "studyvis").exists());
        assert!(entry_path(&legacy, "studyvis").is_dir());
        std::fs::remove_dir(entry_path(&legacy, "studyvis")).unwrap();
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        let prior = std::fs::read(entry_path(&legacy, "studyvis")).unwrap();
        let error = migrate_legacy_entry_with_cleanup(
            &selected,
            &legacy,
            "studyvis",
            &executable,
            |_, _| Err("injected legacy cleanup failure".into()),
        )
        .unwrap_err();
        assert!(error.contains("injected legacy cleanup failure"));
        assert!(!entry_path(&selected, "studyvis").exists());
        assert_eq!(
            std::fs::read(entry_path(&legacy, "studyvis")).unwrap(),
            prior
        );
    }

    #[test]
    fn interrupted_migration_temporary_never_replaces_or_discards_legacy() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("legacy");
        let selected = fixture.0.join("selected");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        let legacy_path = entry_path(&legacy, "studyvis");
        let selected_path = entry_path(&selected, "studyvis");
        let original = std::fs::read(&legacy_path).unwrap();
        std::fs::create_dir_all(selected_path.parent().unwrap()).unwrap();
        let temporary =
            selected_path.with_extension(format!("desktop.migrate-{}", std::process::id()));
        std::fs::write(&temporary, "[Desktop Entry]\npartial interrupted write").unwrap();
        assert!(migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).is_err());
        assert!(!selected_path.exists());
        assert_eq!(std::fs::read(&legacy_path).unwrap(), original);
        assert_eq!(
            std::fs::read_to_string(&temporary).unwrap(),
            "[Desktop Entry]\npartial interrupted write"
        );
        // A later process uses a different sibling name, so an orphaned
        // interrupted temporary is inert and cannot block complete recovery.
        let orphan = selected_path.with_extension("desktop.migrate-previous-process");
        std::fs::rename(temporary, &orphan).unwrap();
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert_eq!(std::fs::read(&selected_path).unwrap(), original);
        assert!(!legacy_path.exists());
        assert_eq!(
            std::fs::read_to_string(orphan).unwrap(),
            "[Desktop Entry]\npartial interrupted write"
        );
    }

    #[test]
    fn complete_migration_install_never_clobbers_a_concurrent_selected_entry() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("legacy");
        let selected = fixture.0.join("selected");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        let legacy_path = entry_path(&legacy, "studyvis");
        let selected_path = entry_path(&selected, "studyvis");
        let original = std::fs::read(&legacy_path).unwrap();
        std::fs::create_dir_all(selected_path.parent().unwrap()).unwrap();
        // Model a selected entry appearing after migration's initial absence
        // check, before its atomic installation attempts to link the inode.
        std::fs::write(&selected_path, "concurrent custom entry").unwrap();
        assert!(install_legacy_entry(&legacy_path, &selected_path).is_err());
        assert_eq!(
            std::fs::read_to_string(&selected_path).unwrap(),
            "concurrent custom entry"
        );
        assert_eq!(std::fs::read(&legacy_path).unwrap(), original);
        let temporary =
            selected_path.with_extension(format!("desktop.migrate-{}", std::process::id()));
        assert!(!temporary.exists());
    }

    #[test]
    fn migration_installs_complete_bytes_and_permissions_before_legacy_cleanup() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("legacy");
        let selected = fixture.0.join("selected");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        let legacy_path = entry_path(&legacy, "studyvis");
        let selected_path = entry_path(&selected, "studyvis");
        std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let original = std::fs::read(&legacy_path).unwrap();
        migrate_legacy_entry_with_cleanup(
            &selected,
            &legacy,
            "studyvis",
            &executable,
            |config, name| {
                assert_eq!(std::fs::read(&selected_path).unwrap(), original);
                assert_eq!(
                    std::fs::metadata(&selected_path)
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o640
                );
                assert_eq!(std::fs::read(&legacy_path).unwrap(), original);
                remove_entry(config, name)
            },
        )
        .unwrap();
        assert!(!legacy_path.exists());
        assert_eq!(std::fs::read(&selected_path).unwrap(), original);
    }

    #[test]
    fn dotdot_directory_alias_preserves_existing_opt_in() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("home/.config");
        let selected = legacy.join("../.config");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        let original = std::fs::read(entry_path(&legacy, "studyvis")).unwrap();
        assert_ne!(selected, legacy);
        assert_eq!(
            selected.canonicalize().unwrap(),
            legacy.canonicalize().unwrap()
        );
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert!(
            entry_path(&selected, "studyvis").exists(),
            "directory alias must remain opted in"
        );
        assert_eq!(
            std::fs::read(entry_path(&legacy, "studyvis")).unwrap(),
            original
        );
    }

    #[test]
    fn different_directories_with_hardlinked_entries_still_remove_the_duplicate() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("legacy");
        let selected = fixture.0.join("selected");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        std::fs::create_dir_all(entry_path(&selected, "studyvis").parent().unwrap()).unwrap();
        std::fs::hard_link(
            entry_path(&legacy, "studyvis"),
            entry_path(&selected, "studyvis"),
        )
        .unwrap();
        let original = std::fs::read(entry_path(&legacy, "studyvis")).unwrap();
        assert_ne!(
            selected.canonicalize().unwrap(),
            legacy.canonicalize().unwrap()
        );
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert!(entry_path(&selected, "studyvis").exists());
        assert!(!entry_path(&legacy, "studyvis").exists());
        assert_eq!(
            std::fs::read(entry_path(&selected, "studyvis")).unwrap(),
            original
        );
    }

    #[test]
    fn custom_directory_alias_does_not_delete_the_enabled_entry() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("legacy");
        let selected = fixture.0.join("selected");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        std::os::unix::fs::symlink(&legacy, &selected).unwrap();
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert!(entry_path(&selected, "studyvis").exists());
        assert!(entry_path(&legacy, "studyvis").exists());
    }

    #[test]
    fn distinct_symlinked_xdg_root_retains_and_repairs_existing_opt_in() {
        let fixture = Fixture::new();
        let home = fixture.0.join("home");
        let legacy = home.join(".config");
        let target = fixture.0.join("config-target");
        let alias = fixture.0.join("xdg-alias");
        std::fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let selected = selected_config_directory(&home, Some(alias.as_os_str()));
        let executable = fixture.0.join("Current version/StudyVis.AppImage");
        let path = entry_path(&legacy, "studyvis");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, legacy_entry(&executable)).unwrap();

        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();

        let expected = entry_contents("studyvis", &executable).unwrap();
        assert_eq!(
            std::fs::read_to_string(entry_path(&target, "studyvis")).unwrap(),
            expected
        );
        assert!(entry_path(&selected, "studyvis").try_exists().unwrap());
        assert!(!path.exists());
        assert!(std::fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn linked_home_ancestor_retains_legacy_opt_in_in_a_distinct_config_root() {
        let fixture = Fixture::new();
        let target = fixture.0.join("actual-home");
        let home = fixture.0.join("home-alias");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &home).unwrap();
        let legacy = home.join(".config");
        let selected = fixture.0.join("selected");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        let expected = std::fs::read(entry_path(&legacy, "studyvis")).unwrap();

        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();

        assert_eq!(
            std::fs::read(entry_path(&selected, "studyvis")).unwrap(),
            expected
        );
        assert!(!entry_path(&legacy, "studyvis").exists());
    }

    #[test]
    fn missing_xdg_directory_below_linked_home_migrates_existing_opt_in() {
        let fixture = Fixture::new();
        let target = fixture.0.join("actual-home");
        let home = fixture.0.join("home-alias");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &home).unwrap();
        let legacy = home.join(".config");
        let selected =
            selected_config_directory(&home, Some(home.join("new-parent/new-config").as_os_str()));
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        let expected = std::fs::read(entry_path(&legacy, "studyvis")).unwrap();
        assert!(!selected.exists());

        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();

        assert_eq!(
            std::fs::read(entry_path(&selected, "studyvis")).unwrap(),
            expected
        );
        assert!(!entry_path(&legacy, "studyvis").exists());
        assert!(std::fs::symlink_metadata(&home)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn startup_repairs_default_selected_and_migrated_known_templates() {
        for case in ["default", "selected", "migrated"] {
            let fixture = Fixture::new();
            let legacy = fixture.0.join("legacy");
            let selected = if case == "default" {
                legacy.clone()
            } else {
                fixture.0.join("selected")
            };
            let current = fixture.0.join("New version/StudyVis.AppImage");
            let old_path = fixture.0.join("Old version/StudyVis.AppImage");
            std::fs::create_dir_all(old_path.parent().unwrap()).unwrap();
            std::fs::write(&old_path, "old executable").unwrap();
            let old = legacy_entry(&old_path);
            let source = if case == "selected" {
                &selected
            } else {
                &legacy
            };
            let path = entry_path(source, "studyvis");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, old).unwrap();
            migrate_legacy_entry(&selected, &legacy, "studyvis", &current).unwrap();
            let repaired = std::fs::read_to_string(entry_path(&selected, "studyvis")).unwrap();
            assert!(repaired.contains(&format!("Exec={}\n", desktop_exec(&current).unwrap())));
            assert!(!repaired.contains("Old version"));
            if selected != legacy {
                assert!(!entry_path(&legacy, "studyvis").exists());
            }
        }
    }

    #[test]
    fn migration_preserves_custom_source_and_selected_template_bytes() {
        for existing_selected in [false, true] {
            let fixture = Fixture::new();
            let legacy = fixture.0.join("legacy");
            let selected = fixture.0.join("selected");
            let current = fixture.0.join("StudyVis.AppImage");
            let custom = format!(
                "{}\nHidden=true\n",
                legacy_entry(Path::new("/custom/StudyVis"))
            );
            std::fs::create_dir_all(entry_path(&legacy, "studyvis").parent().unwrap()).unwrap();
            std::fs::write(entry_path(&legacy, "studyvis"), &custom).unwrap();
            if existing_selected {
                std::fs::create_dir_all(entry_path(&selected, "studyvis").parent().unwrap())
                    .unwrap();
                std::fs::write(
                    entry_path(&selected, "studyvis"),
                    "custom selected template",
                )
                .unwrap();
            }
            migrate_legacy_entry(&selected, &legacy, "studyvis", &current).unwrap();
            assert_eq!(
                std::fs::read_to_string(entry_path(&selected, "studyvis")).unwrap(),
                if existing_selected {
                    "custom selected template"
                } else {
                    &custom
                }
            );
            assert!(!entry_path(&legacy, "studyvis").exists());
        }
    }

    #[test]
    fn migration_does_not_follow_a_custom_entry_symlink() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("legacy");
        let selected = fixture.0.join("selected");
        let executable = fixture.0.join("StudyVis.AppImage");
        set_entry_enabled(&legacy, "studyvis", &executable, true).unwrap();
        let target = fixture.0.join("custom.desktop");
        let original = legacy_entry(Path::new("/old/StudyVis"));
        std::fs::write(&target, &original).unwrap();
        std::fs::create_dir_all(entry_path(&selected, "studyvis").parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, entry_path(&selected, "studyvis")).unwrap();
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), original);
        assert!(entry_path(&legacy, "studyvis").exists());
        std::fs::remove_file(entry_path(&selected, "studyvis")).unwrap();
        std::fs::remove_file(entry_path(&legacy, "studyvis")).unwrap();
        std::os::unix::fs::symlink(&target, entry_path(&legacy, "studyvis")).unwrap();
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert!(!entry_path(&selected, "studyvis").exists());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), original);
        // A linked fallback does not prevent safe repair of a separate owned
        // selected entry, and its target remains untouched.
        std::fs::write(entry_path(&selected, "studyvis"), legacy_entry(&executable)).unwrap();
        migrate_legacy_entry(&selected, &legacy, "studyvis", &executable).unwrap();
        assert_eq!(
            std::fs::read_to_string(entry_path(&selected, "studyvis")).unwrap(),
            entry_contents("studyvis", &executable).unwrap()
        );
        assert_eq!(std::fs::read_to_string(target).unwrap(), original);
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
    fn startup_migrates_old_version_entry_and_gio_launches_current_spaced_percent_path() {
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
        let legacy = fixture.0.join("fallback");
        let selected = fixture.0.join("selected");
        let old_entry = entry_path(&legacy, "studyvis");
        std::fs::create_dir_all(old_entry.parent().unwrap()).unwrap();
        std::fs::write(&old_entry, legacy_entry(&old)).unwrap();
        assert!(webkit2gtk::gio::DesktopAppInfo::from_filename(&old_entry).is_none());
        migrate_legacy_entry(&selected, &legacy, "studyvis", &current).unwrap();
        assert!(!old_entry.exists());
        let entry = entry_path(&selected, "studyvis");
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
