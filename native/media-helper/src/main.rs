use std::io::{self, BufReader};

#[cfg(target_os = "windows")]
mod thumbnail;

fn main() {
    #[cfg(target_os = "windows")]
    if std::env::args().nth(1).as_deref() == Some("--window-thumbnail") {
        if let Err(error) = thumbnail::run() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let stdin = io::stdin();
    let stdout = io::stdout();
    // 麦克风线程也要写入协议事件，不能在主循环中长期持有 stdout 的锁。
    if let Err(error) = lycansync_media::run(BufReader::new(stdin.lock()), stdout) {
        // stdout 保持 JSON Lines 协议纯净，进程级故障通过 stderr 诊断。
        eprintln!("media helper stopped: {error}");
        std::process::exit(1);
    }
}
