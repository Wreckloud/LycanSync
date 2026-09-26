use std::io::{self, BufReader};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    if let Err(error) = lycansync_media::run(BufReader::new(stdin.lock()), stdout.lock()) {
        eprintln!("media helper stopped: {error}");
        std::process::exit(1);
    }
}
