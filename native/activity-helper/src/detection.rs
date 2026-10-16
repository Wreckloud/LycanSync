use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone)]
pub struct GameInstall {
    pub key: String,
    pub name: String,
    pub directory: String,
}

pub struct ProcessSnapshot {
    pub pid: u32,
    pub executable: String,
    pub started_at: u64,
}

pub struct WindowSnapshot {
    pub pid: u32,
    pub title: String,
    pub visible: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ActivityMapping {
    pub executable: String,
    pub name: String,
}

impl ActivityMapping {
    pub fn valid(&self) -> bool {
        self.executable.encode_utf16().count() <= 4096
            && self.executable.ends_with(".exe")
            && !self.executable.chars().any(char::is_control)
            && !self.name.trim().is_empty()
            && self.name.encode_utf16().count() <= 80
            && !self.name.chars().any(char::is_control)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActivityType {
    Game,
    Music,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DetectedActivity {
    pub kind: ActivityType,
    pub name: String,
    pub started_at: u64,
    key: String,
}

#[derive(Serialize)]
pub struct WindowOption {
    executable: String,
    title: String,
}

pub fn normalize_path(path: &str) -> String {
    path.replace('/', "\\").to_ascii_lowercase()
}

fn file_name(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or(path)
}

fn ignored_executable(path: &str) -> bool {
    matches!(
        file_name(path),
        "crashreporter.exe"
            | "crashpad_handler.exe"
            | "crashreportclient.exe"
            | "crashreportclienteditor.exe"
            | "report.exe"
            | "uninstall.exe"
            | "unins000.exe"
            | "setup.exe"
            | "launcher.exe"
            | "updater.exe"
            | "unitycrashhandler64.exe"
            | "unitycrashhandler32.exe"
            | "easyanticheat.exe"
            | "easyanticheat_eos.exe"
            | "beservice.exe"
            | "steam.exe"
            | "epicgameslauncher.exe"
            | "wegame.exe"
            | "tgp_daemon.exe"
            | "riotclientservices.exe"
            | "lycansync.exe"
            | "electron.exe"
    )
}

fn music_player(executable: &str) -> Option<&'static str> {
    match file_name(executable) {
        "cloudmusic.exe" => Some("网易云音乐"),
        "qqmusic.exe" => Some("QQ音乐"),
        "kugou.exe" => Some("酷狗音乐"),
        _ => None,
    }
}

pub fn needs_window(process: &ProcessSnapshot, mappings: &[ActivityMapping]) -> bool {
    music_player(&process.executable).is_some()
        || mappings
            .iter()
            .any(|mapping| mapping.executable == process.executable)
}

fn music_name(player: &str, title: &str) -> Option<String> {
    // 只解析已知播放器标记，不把歌曲自身的横线当作通用分隔符。
    let title = title.trim();
    let song = [
        format!(" - {player}"),
        format!(" – {player}"),
        format!(" — {player}"),
    ]
    .iter()
    .find_map(|suffix| title.strip_suffix(suffix.as_str()))
    .or_else(|| title.strip_prefix(&format!("{player} - ")))
    .or_else(|| {
        // 网易云主窗口也使用“歌曲 - 歌手”；从最后一个固定分隔符取歌曲，保留歌名中的横线。
        if player != "网易云音乐"
            || title.contains("SMTC")
            || title.contains("CEF")
            || title.contains("Widget")
        {
            return None;
        }
        let (song, artist) = title.rsplit_once(" - ")?;
        (!song.trim().is_empty() && !artist.trim().is_empty()).then_some(song)
    })?;
    let song = display_name(song);
    (!song.is_empty() && song != player).then_some(song)
}

fn music_window_name(
    player: &str,
    executable: &str,
    processes: &[ProcessSnapshot],
    windows: &[WindowSnapshot],
) -> Option<String> {
    let pids: HashSet<_> = processes
        .iter()
        .filter(|process| process.executable == executable)
        .map(|process| process.pid)
        .collect();
    // 先合并同一播放器的进程；可识别的歌名优先于辅助窗口的播放器名兜底。
    windows
        .iter()
        .filter(|window| pids.contains(&window.pid))
        .filter_map(|window| music_name(player, &window.title).map(|name| (window, name)))
        .min_by(|(left, left_name), (right, right_name)| {
            (!left.visible, left.pid, left_name).cmp(&(!right.visible, right.pid, right_name))
        })
        .map(|(_, name)| name)
}

pub fn display_name(name: &str) -> String {
    let mut result = String::new();
    let mut length = 0;
    for character in name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
    {
        if character.is_control() {
            continue;
        }
        if length + character.len_utf16() > 80 {
            break;
        }
        result.push(character);
        length += character.len_utf16();
    }
    result
}

pub fn window_options(
    processes: &[ProcessSnapshot],
    windows: &[WindowSnapshot],
) -> Vec<WindowOption> {
    let mut options = Vec::new();
    let mut seen = HashSet::new();
    for window in windows.iter().filter(|window| window.visible) {
        let Some(process) = processes.iter().find(|process| process.pid == window.pid) else {
            continue;
        };
        let title = display_name(&window.title);
        if ignored_executable(&process.executable)
            || title.is_empty()
            || !seen.insert(&process.executable)
        {
            continue;
        }
        options.push(WindowOption {
            executable: process.executable.clone(),
            title,
        });
    }
    options.sort_by(|left, right| left.title.cmp(&right.title));
    options.truncate(128);
    options
}

#[derive(Default)]
pub struct ActivityDetector {
    sessions: BTreeMap<String, RunningSession>,
}

struct RunningSession {
    started_at: u64,
    processes: HashSet<(u32, u64)>,
}

impl ActivityDetector {
    pub fn detect(
        &mut self,
        processes: &[ProcessSnapshot],
        windows: &[WindowSnapshot],
        games: &[GameInstall],
        mappings: &[ActivityMapping],
    ) -> Option<DetectedActivity> {
        let mut candidates: BTreeMap<String, (DetectedActivity, HashSet<(u32, u64)>)> =
            BTreeMap::new();
        for process in processes {
            if process.started_at == 0 || ignored_executable(&process.executable) {
                continue;
            }
            let player = music_player(&process.executable);
            let mapping = mappings
                .iter()
                .find(|mapping| mapping.executable == process.executable);
            let game = games
                .iter()
                .find(|game| process.executable.starts_with(&game.directory));
            // 国服和国际服的独立大厅都算英雄联盟；仅打开 WeGame/Riot 平台不算游戏。
            let league = matches!(
                file_name(&process.executable),
                "leagueclient.exe" | "league of legends.exe"
            );
            let has_window = windows.iter().any(|window| window.pid == process.pid);
            let (key, kind, name) = if let Some(player) = player {
                if !has_window {
                    continue;
                }
                let name = mapping
                    .map(|mapping| display_name(&mapping.name))
                    .unwrap_or_else(|| {
                        music_window_name(player, &process.executable, processes, windows)
                            .unwrap_or_else(|| player.to_owned())
                    });
                (
                    format!("music:{}", process.executable),
                    ActivityType::Music,
                    name,
                )
            } else if let Some(game) = game {
                let override_name = mappings
                    .iter()
                    .rev()
                    .find(|mapping| mapping.executable.starts_with(&game.directory));
                (
                    game.key.clone(),
                    ActivityType::Game,
                    display_name(
                        override_name
                            .map(|mapping| mapping.name.as_str())
                            .unwrap_or(&game.name),
                    ),
                )
            } else if league {
                let override_name = mappings.iter().rev().find(|mapping| {
                    matches!(
                        file_name(&mapping.executable),
                        "leagueclient.exe" | "league of legends.exe"
                    )
                });
                (
                    "known:league-of-legends".to_owned(),
                    ActivityType::Game,
                    override_name
                        .map(|mapping| display_name(&mapping.name))
                        .unwrap_or_else(|| "英雄联盟".to_owned()),
                )
            } else if let Some(mapping) = mapping {
                // 手动游戏随有效窗口关闭而清除；隐藏辅助窗口不代表用户仍在玩。
                if !windows.iter().any(|window| {
                    window.pid == process.pid && window.visible && !window.title.trim().is_empty()
                }) {
                    continue;
                }
                (
                    format!("custom:{}", process.executable),
                    ActivityType::Game,
                    display_name(&mapping.name),
                )
            } else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            let candidate = candidates.entry(key.clone()).or_insert_with(|| {
                (
                    DetectedActivity {
                        kind,
                        name,
                        started_at: process.started_at,
                        key,
                    },
                    HashSet::new(),
                )
            });
            candidate.0.started_at = candidate.0.started_at.min(process.started_at);
            candidate.1.insert((process.pid, process.started_at));
        }
        self.sessions.retain(|key, _| candidates.contains_key(key));
        for (key, (activity, processes)) in &mut candidates {
            // 同一游戏仍有原进程存活时保留本次启动时间，辅助进程重建不能抢占排序。
            if let Some(previous) = self.sessions.get(key)
                && !previous.processes.is_disjoint(processes)
            {
                activity.started_at = activity.started_at.min(previous.started_at);
            }
            self.sessions.insert(
                key.clone(),
                RunningSession {
                    started_at: activity.started_at,
                    processes: processes.clone(),
                },
            );
        }
        candidates
            .into_values()
            .map(|(activity, _)| activity)
            .max_by(|left, right| {
                (left.kind == ActivityType::Game)
                    .cmp(&(right.kind == ActivityType::Game))
                    .then_with(|| left.started_at.cmp(&right.started_at))
                    .then_with(|| left.key.cmp(&right.key))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn select_activity(
        processes: &[ProcessSnapshot],
        windows: &[WindowSnapshot],
        games: &[GameInstall],
        mappings: &[ActivityMapping],
    ) -> Option<DetectedActivity> {
        ActivityDetector::default().detect(processes, windows, games, mappings)
    }

    fn process(pid: u32, executable: &str, started_at: u64) -> ProcessSnapshot {
        ProcessSnapshot {
            pid,
            executable: normalize_path(executable),
            started_at,
        }
    }
    fn window(pid: u32, title: &str) -> WindowSnapshot {
        WindowSnapshot {
            pid,
            title: title.to_owned(),
            visible: true,
        }
    }
    fn games() -> Vec<GameInstall> {
        vec![
            GameInstall {
                key: "steam:a".into(),
                name: "游戏 A".into(),
                directory: "d:\\games\\a\\".into(),
            },
            GameInstall {
                key: "epic:b".into(),
                name: "游戏 B".into(),
                directory: "d:\\games\\b\\".into(),
            },
        ]
    }

    #[test]
    fn newest_game_wins_and_closing_it_restores_previous_game() {
        let mut processes = vec![
            process(1, "d:/games/a/game.exe", 100),
            process(2, "d:/games/b/game.exe", 200),
        ];
        let windows = vec![window(1, "A - 私密房间"), window(2, "B - 服务器地址")];
        assert_eq!(
            select_activity(&processes, &windows, &games(), &[])
                .unwrap()
                .name,
            "游戏 B"
        );
        processes.pop();
        assert_eq!(
            select_activity(&processes, &windows, &games(), &[])
                .unwrap()
                .name,
            "游戏 A"
        );
    }

    #[test]
    fn child_process_and_dynamic_title_do_not_reset_game_order() {
        let processes = vec![
            process(1, "d:/games/a/game.exe", 100),
            process(3, "d:/games/a/child.exe", 300),
            process(2, "d:/games/b/game.exe", 200),
        ];
        let selected =
            select_activity(&processes, &[window(1, "A - 新标题")], &games(), &[]).unwrap();
        assert_eq!(selected.name, "游戏 B");
        assert_eq!(selected.started_at, 200);
    }

    #[test]
    fn game_takes_priority_then_music_title_or_player_name_is_used() {
        let mut processes = vec![
            process(1, "d:/games/a/game.exe", 100),
            process(2, "c:/music/cloudmusic.exe", 300),
        ];
        let windows = vec![window(2, "Song - With Hyphen - 网易云音乐")];
        assert_eq!(
            select_activity(&processes, &windows, &games(), &[])
                .unwrap()
                .kind,
            ActivityType::Game
        );
        processes.remove(0);
        assert_eq!(
            select_activity(&processes, &windows, &games(), &[])
                .unwrap()
                .name,
            "Song - With Hyphen"
        );
        assert_eq!(
            select_activity(&processes, &[window(2, "设置")], &[], &[])
                .unwrap()
                .name,
            "网易云音乐"
        );
        assert!(select_activity(&[], &windows, &[], &[]).is_none());
    }

    #[test]
    fn each_player_is_allowlisted_and_pause_is_not_inferred_from_title() {
        for (executable, name) in [
            ("cloudmusic.exe", "网易云音乐"),
            ("qqmusic.exe", "QQ音乐"),
            ("kugou.exe", "酷狗音乐"),
        ] {
            let processes = [process(1, &format!("c:/music/{executable}"), 100)];
            assert_eq!(
                select_activity(&processes, &[window(1, name)], &[], &[])
                    .unwrap()
                    .name,
                name
            );
        }
        assert!(
            select_activity(
                &[process(1, "c:/browser/msedge.exe", 100)],
                &[window(1, "歌曲")],
                &[],
                &[]
            )
            .is_none()
        );
    }

    #[test]
    fn newest_player_exits_then_remaining_player_is_selected() {
        let mut processes = vec![
            process(1, "c:/music/cloudmusic.exe", 100),
            process(2, "c:/music/qqmusic.exe", 200),
        ];
        let windows = [window(1, "网易云音乐"), window(2, "QQ音乐")];
        assert_eq!(
            select_activity(&processes, &windows, &[], &[])
                .unwrap()
                .name,
            "QQ音乐"
        );
        processes.pop();
        assert_eq!(
            select_activity(&processes, &windows, &[], &[])
                .unwrap()
                .name,
            "网易云音乐"
        );
    }

    #[test]
    fn manual_name_survives_title_change_but_requires_a_running_window() {
        let mappings = [ActivityMapping {
            executable: "c:\\custom\\app.exe".into(),
            name: "自定义游戏".into(),
        }];
        let processes = [process(1, "c:/custom/app.exe", 100)];
        assert_eq!(
            select_activity(&processes, &[window(1, "不同标题")], &[], &mappings)
                .unwrap()
                .name,
            "自定义游戏"
        );
        assert!(select_activity(&processes, &[], &[], &mappings).is_none());
        assert!(select_activity(&[], &[window(1, "相同标题")], &[], &mappings).is_none());
    }

    #[test]
    fn closing_manual_game_window_clears_activity_but_minimizing_keeps_it() {
        let mappings = [ActivityMapping {
            executable: "c:\\custom\\app.exe".into(),
            name: "自定义游戏".into(),
        }];
        let processes = [process(1, "c:/custom/app.exe", 100)];
        let mut detector = ActivityDetector::default();
        // Windows 最小化窗口仍保留 visible 标记，不使用前台或窗口尺寸判断。
        assert!(
            detector
                .detect(&processes, &[window(1, "游戏")], &[], &mappings)
                .is_some()
        );
        let hidden = WindowSnapshot {
            visible: false,
            ..window(1, "辅助窗口")
        };
        assert!(
            detector
                .detect(&processes, &[hidden], &[], &mappings)
                .is_none()
        );
        assert!(
            detector
                .detect(&processes, &[window(1, "")], &[], &mappings)
                .is_none()
        );
    }

    #[test]
    fn latest_saved_name_wins_for_one_game_and_removal_restores_previous_name() {
        for (processes, games, mut mappings, default_name) in [
            (
                vec![process(1, "d:/games/a/match.exe", 100)],
                games(),
                vec![
                    ActivityMapping {
                        executable: "d:\\games\\a\\lobby.exe".into(),
                        name: "旧名称".into(),
                    },
                    ActivityMapping {
                        executable: "d:\\games\\a\\match.exe".into(),
                        name: "新名称".into(),
                    },
                ],
                "游戏 A",
            ),
            (
                vec![process(1, "d:/lol/Game/League of Legends.exe", 100)],
                vec![],
                vec![
                    ActivityMapping {
                        executable: "d:\\lol\\leagueclient.exe".into(),
                        name: "旧名称".into(),
                    },
                    ActivityMapping {
                        executable: "d:\\lol\\game\\league of legends.exe".into(),
                        name: "新名称".into(),
                    },
                ],
                "英雄联盟",
            ),
        ] {
            assert_eq!(
                select_activity(&processes, &[], &games, &mappings)
                    .unwrap()
                    .name,
                "新名称"
            );
            mappings.pop();
            assert_eq!(
                select_activity(&processes, &[], &games, &mappings)
                    .unwrap()
                    .name,
                "旧名称"
            );
            mappings.clear();
            assert_eq!(
                select_activity(&processes, &[], &games, &mappings)
                    .unwrap()
                    .name,
                default_name
            );
        }
    }

    #[test]
    fn music_name_is_merged_across_processes_without_iteration_order_changes() {
        let mut processes = vec![
            process(1, "c:/music/cloudmusic.exe", 100),
            process(2, "c:/music/cloudmusic.exe", 200),
        ];
        let mut windows = vec![
            window(1, "当前歌曲 - 歌手"),
            WindowSnapshot {
                visible: false,
                ..window(2, "")
            },
        ];
        for _ in 0..2 {
            assert_eq!(
                select_activity(&processes, &windows, &[], &[])
                    .unwrap()
                    .name,
                "当前歌曲"
            );
            processes.reverse();
            windows.reverse();
        }
        windows.push(WindowSnapshot {
            visible: false,
            ..window(2, "旧歌曲 - 歌手")
        });
        assert_eq!(
            select_activity(&processes, &windows, &[], &[])
                .unwrap()
                .name,
            "当前歌曲"
        );
        windows.retain(|window| !window.visible);
        assert_eq!(
            select_activity(&processes, &windows, &[], &[])
                .unwrap()
                .name,
            "旧歌曲"
        );
    }

    #[test]
    fn manual_music_name_does_not_turn_music_into_a_game() {
        let mappings = [ActivityMapping {
            executable: "c:\\music\\cloudmusic.exe".into(),
            name: "我的音乐".into(),
        }];
        let activity = select_activity(
            &[process(1, "c:/music/cloudmusic.exe", 100)],
            &[window(1, "歌曲")],
            &[],
            &mappings,
        )
        .unwrap();
        assert_eq!(activity.kind, ActivityType::Music);
        assert_eq!(activity.name, "我的音乐");
    }

    #[test]
    fn launchers_and_own_windows_are_excluded_without_excluding_crash_named_games() {
        let processes = [
            process(1, "d:/games/a/CrashBandicoot.exe", 100),
            process(2, "c:/LycanSync.exe", 200),
            process(3, "c:/WeGame.exe", 300),
        ];
        assert_eq!(
            window_options(
                &processes,
                &[window(1, "游戏"), window(2, "自己"), window(3, "平台")]
            )
            .len(),
            1
        );
        assert_eq!(
            select_activity(&processes, &[], &games(), &[])
                .unwrap()
                .name,
            "游戏 A"
        );
    }

    #[test]
    fn league_client_and_match_are_one_game_but_platform_is_not() {
        let processes = [
            process(1, "d:/lol/LeagueClient.exe", 100),
            process(2, "d:/lol/Game/League of Legends.exe", 200),
        ];
        assert_eq!(
            select_activity(&processes, &[], &[], &[])
                .unwrap()
                .started_at,
            100
        );
        assert!(select_activity(&[process(1, "c:/wegame.exe", 100)], &[], &[], &[]).is_none());
    }

    #[test]
    fn child_handoff_keeps_order_but_a_restarted_game_gets_new_start_time() {
        let mut detector = ActivityDetector::default();
        let first = [
            process(1, "d:/games/a/game.exe", 100),
            process(3, "d:/games/a/child.exe", 300),
            process(2, "d:/games/b/game.exe", 200),
        ];
        assert_eq!(
            detector.detect(&first, &[], &games(), &[]).unwrap().name,
            "游戏 B"
        );
        let handoff = [
            process(3, "d:/games/a/child.exe", 300),
            process(2, "d:/games/b/game.exe", 200),
        ];
        assert_eq!(
            detector.detect(&handoff, &[], &games(), &[]).unwrap().name,
            "游戏 B"
        );
        let restarted = [
            process(4, "d:/games/a/game.exe", 400),
            process(2, "d:/games/b/game.exe", 200),
        ];
        let selected = detector.detect(&restarted, &[], &games(), &[]).unwrap();
        assert_eq!(selected.name, "游戏 A");
        assert_eq!(selected.started_at, 400);
    }

    #[test]
    fn renamed_game_and_its_children_use_one_identity_and_fixed_name() {
        let mappings = [ActivityMapping {
            executable: "d:\\games\\a\\game.exe".into(),
            name: "更正后的名字".into(),
        }];
        let processes = [
            process(1, "d:/games/a/game.exe", 100),
            process(2, "d:/games/a/child.exe", 200),
        ];
        let activity = select_activity(
            &processes,
            &[window(1, "不断变化的窗口标题")],
            &games(),
            &mappings,
        )
        .unwrap();
        assert_eq!(activity.name, "更正后的名字");
        assert_eq!(activity.started_at, 100);
        assert_eq!(activity.key, "steam:a");
    }

    #[test]
    fn netease_plain_title_is_parsed_without_exposing_an_unknown_dialog_title() {
        assert_eq!(
            music_name("网易云音乐", "Song - With Hyphen - Artist").as_deref(),
            Some("Song - With Hyphen")
        );
        assert_eq!(music_name("网易云音乐", "网易云音乐"), None);
        assert_eq!(
            music_name("网易云音乐", "MediaPlayer SMTC window - unknown"),
            None
        );
        assert_eq!(music_name("QQ音乐", "任意页面 - 私密内容"), None);
    }

    #[test]
    fn passive_detection_does_not_request_browser_or_unselected_window_titles() {
        assert!(!needs_window(
            &process(1, "c:/browser/msedge.exe", 100),
            &[]
        ));
        assert!(needs_window(
            &process(1, "c:/music/cloudmusic.exe", 100),
            &[]
        ));
        let mappings = [ActivityMapping {
            executable: "c:\\custom.exe".into(),
            name: "游戏".into(),
        }];
        assert!(needs_window(&process(1, "c:/custom.exe", 100), &mappings));
        let name = display_name(&"🎮".repeat(50));
        assert_eq!(name.encode_utf16().count(), 80);
    }

    #[test]
    fn empty_auxiliary_window_does_not_hide_a_programs_named_window() {
        let processes = [process(1, "c:/game.exe", 100)];
        let options = window_options(
            &processes,
            &[
                window(1, ""),
                window(1, "窗口名称"),
                window(1, "另一个窗口"),
            ],
        );
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].title, "窗口名称");
    }
}
