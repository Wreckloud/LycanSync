use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const EVENT_TIMEOUT: Duration = Duration::from_secs(3);
const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);

struct HelperProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<String>,
    output_reader: Option<JoinHandle<()>>,
}

impl HelperProcess {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_lycansync-media"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("media-helper should start");
        let stdin = child.stdin.take().expect("child stdin should be piped");
        let stdout = child.stdout.take().expect("child stdout should be piped");
        let (event_sender, events) = mpsc::channel();
        let output_reader = Some(thread::spawn(move || read_events(stdout, event_sender)));

        Self {
            child,
            stdin: Some(stdin),
            events,
            output_reader,
        }
    }

    fn send(&mut self, command: &str) {
        let stdin = self.stdin.as_mut().expect("child stdin should be open");
        stdin
            .write_all(command.as_bytes())
            .expect("write command to media-helper");
        stdin.flush().expect("flush command to media-helper");
    }

    fn next_event(&self) -> Value {
        let line = self
            .events
            .recv_timeout(EVENT_TIMEOUT)
            .expect("media-helper should return an event before the timeout");
        serde_json::from_str(&line).expect("media-helper event should be JSON")
    }

    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.join_output_reader();
                    return Some(status);
                }
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                Ok(None) | Err(_) => {
                    self.terminate_and_reap();
                    return None;
                }
            }
        }
    }

    fn terminate_and_reap(&mut self) {
        self.close_stdin();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.join_output_reader();
    }

    fn join_output_reader(&mut self) {
        if let Some(reader) = self.output_reader.take() {
            reader.join().expect("stdout reader should exit with child");
        }
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        self.terminate_and_reap();
    }
}

fn read_events(stdout: ChildStdout, event_sender: mpsc::Sender<String>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else {
            break;
        };
        if event_sender.send(line).is_err() {
            break;
        }
    }
}

#[test]
fn hello_video_start_requires_a_current_source_and_shutdown_use_protocol_v1() {
    let mut helper = HelperProcess::spawn();
    helper.send("{\"protocolVersion\":1,\"requestId\":\"hello-1\",\"command\":\"hello\"}\n");
    let hello = helper.next_event();
    assert_eq!(hello["event"], "hello");
    assert_eq!(hello["protocolVersion"], 1);

    helper.send(
        "{\"protocolVersion\":1,\"requestId\":\"video-1\",\"command\":\"startVideo\",\"sessionId\":\"s1\",\"sourceId\":\"monitor:1:0\",\"targetWidth\":1920,\"targetHeight\":1080,\"maxFps\":60}\n",
    );
    let invalid_source = helper.next_event();
    assert_eq!(invalid_source["event"], "error");
    #[cfg(feature = "shared-texture-output")]
    assert_eq!(invalid_source["code"], "invalidRequest");
    #[cfg(not(feature = "shared-texture-output"))]
    assert_eq!(invalid_source["code"], "videoOutputUnavailable");

    helper.send("{\"protocolVersion\":1,\"requestId\":\"shutdown-1\",\"command\":\"shutdown\"}\n");
    let shutdown = helper.next_event();
    assert_eq!(shutdown["event"], "acknowledged");
    assert_eq!(shutdown["command"], "shutdown");
    let status = helper
        .wait_for_exit(PROCESS_TIMEOUT)
        .expect("shutdown should exit before timeout");
    assert!(status.success());
}

#[test]
fn capabilities_advertise_platform_audio_support_without_opening_streams() {
    let mut helper = HelperProcess::spawn();
    // Audio discovery capability is metadata; this test never enumerates or opens an audio stream.
    helper.send(
        "{\"protocolVersion\":1,\"requestId\":\"capabilities-1\",\"command\":\"capabilities\"}\n",
    );
    let capabilities = helper.next_event();
    assert_eq!(capabilities["event"], "capabilities");
    assert_eq!(capabilities["protocolVersion"], 1);
    assert!(capabilities["audioSourceDiscovery"]["available"].is_boolean());
    assert!(capabilities["microphoneProbe"]["available"].is_boolean());
    #[cfg(target_os = "windows")]
    {
        assert_eq!(capabilities["microphoneCapture"]["available"], true);
        assert_eq!(
            capabilities["microphoneCapture"]["reason"],
            "windowsWasapiSharedModeSonora"
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        assert_eq!(capabilities["microphoneCapture"]["available"], false);
        assert_eq!(
            capabilities["microphoneCapture"]["reason"],
            "platformUnsupported"
        );
    }
    assert_eq!(capabilities["systemAudioCapture"]["available"], false);
    assert_eq!(capabilities["processAudioCapture"]["available"], false);

    helper.send("{\"protocolVersion\":1,\"requestId\":\"shutdown-1\",\"command\":\"shutdown\"}\n");
    assert_eq!(helper.next_event()["command"], "shutdown");
    assert!(helper.wait_for_exit(PROCESS_TIMEOUT).unwrap().success());
}

#[test]
fn stale_microphone_probe_source_fails_without_enumerating_or_opening_a_device() {
    let mut helper = HelperProcess::spawn();
    helper.send(
        "{\"protocolVersion\":1,\"requestId\":\"mic-start\",\"command\":\"startMicrophoneProbe\",\"sessionId\":\"mic-1\",\"sourceId\":\"audioInput:99:0\"}\n",
    );
    let result = helper.next_event();
    assert_eq!(result["event"], "error");
    assert_eq!(result["code"], "audioDeviceUnavailable");

    helper.send("{\"protocolVersion\":1,\"requestId\":\"shutdown\",\"command\":\"shutdown\"}\n");
    assert_eq!(helper.next_event()["command"], "shutdown");
    assert!(helper.wait_for_exit(PROCESS_TIMEOUT).unwrap().success());
}

#[test]
fn malformed_and_oversized_lines_return_errors_without_stopping_helper() {
    let mut helper = HelperProcess::spawn();
    helper.send("not-json\n");
    let malformed = helper.next_event();
    assert_eq!(malformed["code"], "malformedJson");

    helper.send(&format!("{}\n", "x".repeat(64 * 1024 + 1)));
    let oversized = helper.next_event();
    assert_eq!(oversized["code"], "lineTooLong");

    helper.send("{\"protocolVersion\":1,\"requestId\":\"shutdown-1\",\"command\":\"shutdown\"}\n");
    assert_eq!(helper.next_event()["command"], "shutdown");
    assert!(helper.wait_for_exit(PROCESS_TIMEOUT).unwrap().success());
}

#[test]
fn closing_stdin_exits_helper_cleanly() {
    let mut helper = HelperProcess::spawn();
    helper.send("{\"protocolVersion\":1,\"requestId\":\"hello-1\",\"command\":\"hello\"}\n");
    assert_eq!(helper.next_event()["event"], "hello");
    helper.close_stdin();

    let status = helper
        .wait_for_exit(PROCESS_TIMEOUT)
        .expect("EOF should exit before timeout");
    assert!(status.success());
}

#[test]
fn timeout_terminates_and_reaps_helper_process() {
    let mut helper = HelperProcess::spawn();

    assert!(helper.wait_for_exit(Duration::from_millis(200)).is_none());
    assert!(helper.child.try_wait().unwrap().is_some());
    assert!(helper.output_reader.is_none());
}
