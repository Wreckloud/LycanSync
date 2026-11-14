//! 活动检测独立于媒体采集，只输出整理后的动态；窗口清单仅在主动请求时返回。

mod catalog;
mod detection;
mod input_activity;
mod known_games;
mod windows;

use detection::{ActivityDetector, ActivityMapping, DetectedActivity, ProcessSnapshot};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const SCAN_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
enum Command {
    Configure {
        #[serde(rename = "requestId")]
        request_id: u64,
        mappings: Vec<ActivityMapping>,
    },
    Windows {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    CaptureGame {
        #[serde(rename = "requestId")]
        request_id: u64,
        executable: String,
    },
}

fn main() {
    known_games::bundled();
    let (sender, receiver) = mpsc::sync_channel(8);
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.len() > 512 * 1024 {
                continue;
            }
            if let Ok(command) = serde_json::from_str::<Command>(&line)
                && sender.send(command).is_err()
            {
                break;
            }
        }
    });
    let mut system = System::new();
    let mut games = catalog::discover_games();
    let mut catalog_refreshed = Instant::now();
    let mut next_scan = Instant::now();
    let mut mappings = Vec::new();
    let mut configuration_id = 0;
    let mut last_activity: Option<DetectedActivity> = None;
    let mut detector = ActivityDetector::default();
    let mut input_activity = input_activity::InputActivity::default();
    let mut next_input_sample = Instant::now();
    loop {
        let command = match receiver.recv_timeout(
            next_scan
                .min(next_input_sample)
                .saturating_duration_since(Instant::now()),
        ) {
            Ok(command) => Some(command),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let now = Instant::now();
        if now >= next_input_sample {
            if let Some(idle_seconds) = input_activity.sample(now) {
                write_message(json!({ "inputIdleSeconds": idle_seconds }));
            }
            next_input_sample = now + input_activity::SAMPLE_INTERVAL;
        }
        if command.is_none() && now < next_scan {
            continue;
        }
        if catalog_refreshed.elapsed() >= Duration::from_secs(300) {
            games = catalog::discover_games();
            catalog_refreshed = Instant::now();
        }
        if let Some(Command::CaptureGame {
            request_id,
            executable,
        }) = &command
        {
            let executable = detection::normalize_path(executable);
            if executable.encode_utf16().count() > 4096
                || !executable.ends_with(".exe")
                || executable.chars().any(char::is_control)
                || !std::path::Path::new(&executable).is_absolute()
            {
                write_message(json!({ "requestId": request_id, "error": "采集程序身份无效。" }));
            } else {
                write_message(json!({ "requestId": request_id,
                    "game": detection::is_capture_game(&executable, &games) }));
            }
            // 只查询已知游戏规则与安装清单，显示名称映射不决定采集方式。
            continue;
        }
        if let Some(Command::Configure {
            request_id,
            mappings: next,
        }) = &command
        {
            if next.len() > 32 || next.iter().any(|mapping| !mapping.valid()) {
                write_message(json!({ "requestId": request_id, "error": "动态名称设置无效。" }));
                continue;
            }
            mappings = next.clone();
            configuration_id = *request_id;
            last_activity = None;
        }
        let processes = process_snapshot(&mut system);
        let list_windows = matches!(command, Some(Command::Windows { .. }));
        // 只枚举候选游戏、播放器及用户指定程序的窗口；自动游戏也需窗口身份用于快速共享。
        let wanted_pids = processes
            .iter()
            .filter(|process| list_windows || detection::needs_window(process, &games, &mappings))
            .map(|process| process.pid)
            .collect();
        let windows = match windows::snapshot(&wanted_pids) {
            Ok(windows) => windows,
            Err(_) => {
                if let Some(command) = command {
                    let request_id = match command {
                        Command::Configure { request_id, .. }
                        | Command::Windows { request_id }
                        | Command::CaptureGame { request_id, .. } => request_id,
                    };
                    write_message(
                        json!({ "requestId": request_id, "error": "无法读取运行窗口，请重试。" }),
                    );
                }
                // 检测失败时清除公开候选，不把旧标题当成仍有效的新快照。
                write_activity(None, configuration_id);
                last_activity = None;
                next_scan = Instant::now() + SCAN_INTERVAL;
                continue;
            }
        };
        if let Some(command) = command {
            match command {
                Command::Configure { request_id, .. } => {
                    write_message(json!({ "requestId": request_id }));
                }
                Command::Windows { request_id } => {
                    write_message(
                        json!({ "requestId": request_id, "windows": detection::window_options(&processes, &windows) }),
                    );
                }
                Command::CaptureGame { .. } => {
                    unreachable!("capture query returned before scanning")
                }
            }
        }
        let activity = detector.detect(&processes, &windows, &games, &mappings);
        if activity != last_activity || configuration_id == 0 {
            write_activity(activity.as_ref(), configuration_id);
            last_activity = activity;
        }
        next_scan = Instant::now() + SCAN_INTERVAL;
    }
}

fn process_snapshot(system: &mut System) -> Vec<ProcessSnapshot> {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    // 仅为具有参数条件的候选程序读取命令行，不扫描或输出其他程序的参数。
    let argument_pids: Vec<_> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let executable = detection::normalize_path(&process.exe()?.to_string_lossy());
            known_games::bundled()
                .needs_arguments(&executable)
                .then_some(*pid)
        })
        .collect();
    if !argument_pids.is_empty() {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&argument_pids),
            false,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
        );
    }
    system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            Some(ProcessSnapshot {
                pid: pid.as_u32(),
                executable: detection::normalize_path(&process.exe()?.to_string_lossy()),
                started_at: process.start_time(),
                arguments: process
                    .cmd()
                    .iter()
                    .map(|value| value.to_string_lossy().into_owned())
                    .collect(),
            })
        })
        .collect()
}

fn write_activity(activity: Option<&DetectedActivity>, configuration_id: u64) {
    write_message(json!({
        "configurationId": configuration_id,
        "activityType": activity.map(|activity| activity.kind),
        "activityName": activity.map(|activity| activity.name.as_str()),
        "startedAtEpochSeconds": activity.map(|activity| activity.started_at),
        "windowIds": activity.map(|activity| &activity.window_ids),
    }));
}

fn write_message(message: serde_json::Value) {
    let mut stdout = io::stdout().lock();
    if writeln!(stdout, "{message}")
        .and_then(|_| stdout.flush())
        .is_err()
    {
        std::process::exit(0);
    }
}
