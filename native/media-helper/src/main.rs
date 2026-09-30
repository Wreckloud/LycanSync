use std::io::{self, BufReader};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    // 捕获线程也要写入帧事件，不能在主循环中长期持有 stdout 的锁。
    if let Err(error) = lycansync_media::run(BufReader::new(stdin.lock()), stdout) {
        eprintln!("media helper stopped: {error}");
        std::process::exit(1);
    }
}
