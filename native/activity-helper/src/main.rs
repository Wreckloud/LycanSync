use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

const SCAN_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct GameInstall {
    name: String,
    directory: String,
}

#[derive(Clone, PartialEq, Eq)]
struct DetectedGame {
    name: String,
    started_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityEvent<'a> {
    activity_type: Option<&'a str>,
    activity_name: Option<&'a str>,
    started_at_epoch_seconds: Option<u64>,
}

fn main() {
    let mut games = discover_games();
    let refresh_kind = ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet);
    let mut system = System::new();
    let mut last_activity: Option<DetectedGame> = None;
    let mut missing_scans = 0_u8;
    let mut catalog_refresh = 0_u8;

    loop {
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind);
        let detected = detect_game(&system, &games);
        let next_activity = match detected {
            Some(game) => {
                missing_scans = 0;
                Some(game)
            }
            None if last_activity.is_some() && missing_scans == 0 => {
                missing_scans = 1;
                last_activity.clone()
            }
            None => {
                missing_scans = 0;
                None
            }
        };

        if next_activity != last_activity {
            write_event(next_activity.as_ref());
            last_activity = next_activity;
        }

        catalog_refresh = catalog_refresh.saturating_add(1);
        if catalog_refresh >= 30 {
            games = discover_games();
            catalog_refresh = 0;
        }
        thread::sleep(SCAN_INTERVAL);
    }
}

fn detect_game(system: &System, games: &[GameInstall]) -> Option<DetectedGame> {
    let foreground_pid = foreground_process_id();
    let mut candidates: Vec<(bool, u64, &GameInstall)> = Vec::new();
    for (pid, process) in system.processes() {
        let Some(executable) = process.exe() else {
            continue;
        };
        if ignored_executable(executable) {
            continue;
        }
        let executable_path = normalized_path(executable);
        let Some(game) = games.iter().find(|game| executable_path.starts_with(&game.directory)) else {
            continue;
        };
        if let Some(candidate) = candidates.iter_mut().find(|candidate| candidate.2.directory == game.directory) {
            candidate.0 |= pid.as_u32() == foreground_pid;
            candidate.1 = candidate.1.min(process.start_time());
        } else {
            candidates.push((pid.as_u32() == foreground_pid, process.start_time(), game));
        }
    }
    candidates.into_iter().max_by(compare_detected).map(|(_, started_at, game)| DetectedGame {
        name: game.name.clone(),
        started_at,
    })
}

fn compare_detected(left: &(bool, u64, &GameInstall), right: &(bool, u64, &GameInstall)) -> Ordering {
    left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1))
}

fn foreground_process_id() -> u32 {
    unsafe {
        let window = GetForegroundWindow();
        let mut process_id = 0_u32;
        if window.0.is_null() {
            return 0;
        }
        GetWindowThreadProcessId(window, Some(&mut process_id));
        process_id
    }
}

fn ignored_executable(path: &Path) -> bool {
    let name = path.file_stem().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    ["crash", "report", "unins", "setup", "unitycrashhandler", "easyanticheat", "beservice"]
        .iter().any(|fragment| name.contains(fragment))
}

fn discover_games() -> Vec<GameInstall> {
    steam_apps_directories().into_iter().flat_map(|apps| read_manifests(&apps)).collect()
}

fn steam_apps_directories() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = env::var_os("STEAM_PATH") {
        roots.push(PathBuf::from(root));
    }
    if let Some(program_files) = env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files).join("Steam"));
    }

    let mut apps_directories = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let default_apps = root.join("steamapps");
        push_unique(&mut apps_directories, &mut seen, default_apps.clone());
        let libraries = fs::read_to_string(default_apps.join("libraryfolders.vdf")).unwrap_or_default();
        for line in libraries.lines() {
            if let Some(path) = vdf_value(line, "path") {
                push_unique(&mut apps_directories, &mut seen,
                    PathBuf::from(path.replace("\\\\", "\\")).join("steamapps"));
            }
        }
    }
    apps_directories
}

fn read_manifests(apps_directory: &Path) -> Vec<GameInstall> {
    let Ok(entries) = fs::read_dir(apps_directory) else {
        return Vec::new();
    };
    entries.flatten().filter_map(|entry| {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
            return None;
        }
        let content = fs::read_to_string(entry.path()).ok()?;
        let name = content.lines().find_map(|line| vdf_value(line, "name"))?;
        let install_directory = content.lines().find_map(|line| vdf_value(line, "installdir"))?;
        Some(GameInstall {
            name,
            directory: normalized_path(&apps_directory.join("common").join(install_directory)),
        })
    }).collect()
}

fn vdf_value(line: &str, expected_key: &str) -> Option<String> {
    let mut values = line.split('"').skip(1).step_by(2);
    let key = values.next()?.trim();
    let value = values.next()?.trim();
    (key.eq_ignore_ascii_case(expected_key) && !value.is_empty()).then(|| value.to_owned())
}

fn push_unique(values: &mut Vec<PathBuf>, seen: &mut HashSet<String>, value: PathBuf) {
    let key = normalized_path(&value);
    if seen.insert(key) {
        values.push(value);
    }
}

fn normalized_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    if !value.ends_with('\\') {
        value.push('\\');
    }
    value
}

fn write_event(activity: Option<&DetectedGame>) {
    let event = ActivityEvent {
        activity_type: activity.map(|_| "GAME"),
        activity_name: activity.map(|game| game.name.as_str()),
        started_at_epoch_seconds: activity.map(|game| game.started_at),
    };
    if let Ok(line) = serde_json::to_string(&event) {
        let mut stdout = io::stdout().lock();
        let _ = writeln!(stdout, "{line}");
        let _ = stdout.flush();
    }
}
