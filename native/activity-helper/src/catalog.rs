use crate::detection::{GameInstall, normalize_path};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub fn discover_games() -> Vec<GameInstall> {
    let mut games: Vec<_> = steam_apps_directories()
        .into_iter()
        .flat_map(|apps| read_steam_manifests(&apps))
        .collect();
    if let Some(program_data) = env::var_os("ProgramData") {
        let directory = PathBuf::from(program_data).join("Epic/EpicGamesLauncher/Data/Manifests");
        if let Ok(entries) = fs::read_dir(directory) {
            for entry in entries.flatten() {
                if entry
                    .path()
                    .extension()
                    .is_none_or(|extension| extension != "item")
                {
                    continue;
                }
                if let Ok(content) = fs::read_to_string(entry.path())
                    && let Some(game) = epic_manifest(&content)
                {
                    games.push(game);
                }
            }
        }
    }
    games.sort_by(|left, right| {
        right
            .directory
            .len()
            .cmp(&left.directory.len())
            .then_with(|| left.key.cmp(&right.key))
    });
    games
}

fn steam_apps_directories() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = env::var_os("STEAM_PATH") {
        roots.push(PathBuf::from(root));
    }
    if let Some(root) = crate::windows::steam_directory() {
        roots.push(root);
    }
    if let Some(program_files) = env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files).join("Steam"));
    }
    let mut directories = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let apps = root.join("steamapps");
        push_unique(&mut directories, &mut seen, apps.clone());
        if let Ok(libraries) = fs::read_to_string(apps.join("libraryfolders.vdf")) {
            for line in libraries.lines() {
                if let Some(path) = vdf_value(line, "path") {
                    push_unique(
                        &mut directories,
                        &mut seen,
                        PathBuf::from(path.replace("\\\\", "\\")).join("steamapps"),
                    );
                }
            }
        }
    }
    directories
}

fn read_steam_manifests(directory: &Path) -> Vec<GameInstall> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let app_id = file_name
                .strip_prefix("appmanifest_")?
                .strip_suffix(".acf")?;
            let content = fs::read_to_string(entry.path()).ok()?;
            steam_manifest(app_id, &content, directory)
        })
        .collect()
}

fn steam_manifest(app_id: &str, content: &str, directory: &Path) -> Option<GameInstall> {
    let name = content.lines().find_map(|line| vdf_value(line, "name"))?;
    let install_directory = content
        .lines()
        .find_map(|line| vdf_value(line, "installdir"))?;
    // 清单内容不能让匹配目录逃逸到整个磁盘或其他库。
    if install_directory.contains(['/', '\\', ':'])
        || matches!(install_directory.as_str(), "." | "..")
    {
        return None;
    }
    Some(GameInstall {
        key: format!("steam:{app_id}"),
        name,
        directory: format!(
            "{}\\",
            normalize_path(
                &directory
                    .join("common")
                    .join(install_directory)
                    .to_string_lossy()
            )
        ),
    })
}

fn epic_manifest(content: &str) -> Option<GameInstall> {
    let manifest: serde_json::Value = serde_json::from_str(content).ok()?;
    let name = manifest.get("DisplayName")?.as_str()?.trim();
    let key = manifest.get("AppName")?.as_str()?.trim();
    let directory = normalize_path(manifest.get("InstallLocation")?.as_str()?.trim());
    let executable = manifest.get("LaunchExecutable")?.as_str()?;
    // 排除引擎/资源包及没有可运行目标的条目，安装本身不是正在运行的证据。
    if name.is_empty()
        || key.is_empty()
        || executable.is_empty()
        || key.starts_with("UE_")
        || manifest
            .get("bIsIncompleteInstall")
            .and_then(|value| value.as_bool())
            == Some(true)
        || directory.len() <= 3
        || !directory
            .as_bytes()
            .get(1)
            .is_some_and(|value| *value == b':')
    {
        return None;
    }
    Some(GameInstall {
        key: format!("epic:{key}"),
        name: name.to_owned(),
        directory: format!("{}\\", directory.trim_end_matches('\\')),
    })
}

fn vdf_value(line: &str, expected_key: &str) -> Option<String> {
    let mut values = line.split('"').skip(1).step_by(2);
    let key = values.next()?.trim();
    let value = values.next()?.trim();
    (key.eq_ignore_ascii_case(expected_key) && !value.is_empty()).then(|| value.to_owned())
}

fn push_unique(values: &mut Vec<PathBuf>, seen: &mut HashSet<String>, value: PathBuf) {
    if seen.insert(normalize_path(&value.to_string_lossy())) {
        values.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn steam_name_comes_from_manifest_not_window_title() {
        let content = "\"name\" \"Fixed Game Name\"\n\"installdir\" \"Game\"";
        let game = steam_manifest("123", content, Path::new("D:/Steam/steamapps")).unwrap();
        assert_eq!(game.name, "Fixed Game Name");
        assert_eq!(game.key, "steam:123");
        assert!(game.directory.ends_with("\\common\\game\\"));
        assert!(
            steam_manifest(
                "123",
                "\"name\" \"X\"\n\"installdir\" \"..\"",
                Path::new("D:/Steam")
            )
            .is_none()
        );
    }
    #[test]
    fn epic_valid_game_only_and_directory_has_a_boundary() {
        let content = r#"{"DisplayName":"Game","AppName":"game-id","InstallLocation":"D:\\Epic\\Game","LaunchExecutable":"Game.exe"}"#;
        let game = epic_manifest(content).unwrap();
        assert_eq!(game.key, "epic:game-id");
        assert_eq!(game.directory, "d:\\epic\\game\\");
        assert!(epic_manifest(&content.replace("game-id", "UE_5.6")).is_none());
        assert!(epic_manifest("{}").is_none());
    }
}
