use std::io::{self, BufReader};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    // 麦克风线程也要写入协议事件，不能在主循环中长期持有 stdout 的锁。
    if let Err(error) = lycansync_media::run(BufReader::new(stdin.lock()), stdout) {
        // stdout 保持 JSON Lines 协议纯净，进程级故障通过 stderr 诊断。
        eprintln!("media helper stopped: {error}");
        std::process::exit(1);
    }
}
