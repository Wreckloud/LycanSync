//! 远控授权和按住输入状态；撤销只释放输入，不拥有或停止普通屏幕采集会话。

use crate::protocol::{ErrorCode, RemoteInputEvent, RemoteMouseButton};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct RemoteInputManager {
    grant: Option<Grant>,
}

struct Grant {
    session_id: String,
    source_id: String,
    control_session_id: String,
    controller_identity: String,
    monitor: usize,
    // 鼠标移动可丢弃，可靠键鼠事件不能被其序号推进，因此分别校验顺序。
    last_move_sequence: u64,
    last_reliable_sequence: u64,
    accepting_inputs: bool,
    rate_window_started: Instant,
    rate_count: u16,
    held: Vec<RemoteInputEvent>,
}

// 清理抬起动作不依赖屏幕坐标，显示器失效时仍能释放按住的鼠标键。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Injection {
    Event(RemoteInputEvent),
    ReleaseMouseButton(RemoteMouseButton),
}

impl RemoteInputManager {
    pub(super) fn grant(
        &mut self,
        session_id: &str,
        source_id: &str,
        control_session_id: &str,
        controller_identity: &str,
        monitor: usize,
    ) -> Result<(), ErrorCode> {
        if self.grant.is_some()
            || !valid_identifier(session_id)
            || !valid_identifier(source_id)
            || !valid_identifier(control_session_id)
            || controller_identity.is_empty()
            || controller_identity.len() > 128
        {
            return Err(ErrorCode::RemoteControlInvalidSession);
        }
        self.grant = Some(Grant {
            session_id: session_id.to_owned(),
            source_id: source_id.to_owned(),
            control_session_id: control_session_id.to_owned(),
            controller_identity: controller_identity.to_owned(),
            monitor,
            last_move_sequence: 0,
            last_reliable_sequence: 0,
            accepting_inputs: true,
            rate_window_started: Instant::now(),
            rate_count: 0,
            held: Vec::new(),
        });
        Ok(())
    }

    pub(super) fn source_id(&self) -> Option<&str> {
        self.grant.as_ref().map(|grant| grant.source_id.as_str())
    }

    pub(super) fn apply<F>(
        &mut self,
        session_id: &str,
        control_session_id: &str,
        controller_identity: &str,
        sequence: u64,
        input: RemoteInputEvent,
        mut inject: F,
    ) -> Result<bool, ErrorCode>
    where
        F: FnMut(usize, Injection) -> Result<(), ErrorCode>,
    {
        let mut grant = self
            .grant
            .take()
            .ok_or(ErrorCode::RemoteControlInvalidSession)?;
        if grant.session_id != session_id
            || grant.control_session_id != control_session_id
            || grant.controller_identity != controller_identity
            || !grant.accepting_inputs
            || !valid_input(input)
        {
            self.grant = Some(grant);
            return Err(ErrorCode::RemoteControlInvalidSession);
        }
        let is_move = matches!(input, RemoteInputEvent::Move { .. });
        if is_move {
            if sequence <= grant.last_move_sequence || sequence <= grant.last_reliable_sequence {
                self.grant = Some(grant);
                return Err(ErrorCode::RemoteControlInvalidSession);
            }
            grant.last_move_sequence = sequence;
        } else {
            if sequence <= grant.last_reliable_sequence {
                self.grant = Some(grant);
                return Err(ErrorCode::RemoteControlInvalidSession);
            }
            grant.last_reliable_sequence = sequence;
        }
        let now = Instant::now();
        if now.duration_since(grant.rate_window_started) >= Duration::from_secs(1) {
            grant.rate_window_started = now;
            grant.rate_count = 0;
        }
        if grant.rate_count >= 120 {
            if is_move {
                self.grant = Some(grant);
                return Ok(false);
            }
            grant.accepting_inputs = false;
            let mut still_held = Vec::new();
            for held in std::mem::take(&mut grant.held).into_iter().rev() {
                if inject(grant.monitor, release_action(held)).is_err() {
                    still_held.push(held);
                }
            }
            if !still_held.is_empty() {
                grant.held = still_held;
                self.grant = Some(grant);
            }
            return Err(ErrorCode::RemoteControlInputFailed);
        }
        grant.rate_count += 1;
        if inject(grant.monitor, Injection::Event(input)).is_err() {
            grant.accepting_inputs = false;
            let mut still_held = Vec::new();
            for held in std::mem::take(&mut grant.held).into_iter().rev() {
                if inject(grant.monitor, release_action(held)).is_err() {
                    still_held.push(held);
                }
            }
            if !still_held.is_empty() {
                grant.held = still_held;
                self.grant = Some(grant);
            }
            return Err(ErrorCode::RemoteControlInputFailed);
        }
        update_held(&mut grant.held, input);
        self.grant = Some(grant);
        Ok(true)
    }

    pub(super) fn revoke<F>(
        &mut self,
        session_id: &str,
        control_session_id: Option<&str>,
        mut inject: F,
    ) -> Result<bool, ErrorCode>
    where
        F: FnMut(usize, Injection) -> Result<(), ErrorCode>,
    {
        let Some(current) = self.grant.as_ref() else {
            return Ok(false);
        };
        if current.session_id != session_id
            || control_session_id.is_some_and(|id| id != current.control_session_id)
        {
            return Err(ErrorCode::RemoteControlInvalidSession);
        }
        let Some(mut grant) = self.grant.take() else {
            return Ok(false);
        };
        grant.accepting_inputs = false;
        let mut still_held = Vec::new();
        for input in std::mem::take(&mut grant.held).into_iter().rev() {
            if inject(grant.monitor, release_action(input)).is_err() {
                still_held.push(input);
            }
        }
        if !still_held.is_empty() {
            // 仅保留未成功抬起的输入，授权已停止接收新事件，后续撤销可重试清理。
            grant.held = still_held;
            self.grant = Some(grant);
            Err(ErrorCode::RemoteControlInputFailed)
        } else {
            Ok(true)
        }
    }
}

impl Drop for RemoteInputManager {
    fn drop(&mut self) {
        if let Some(mut grant) = self.grant.take() {
            for input in std::mem::take(&mut grant.held).into_iter().rev() {
                if let Err(error) = inject(grant.monitor, release_action(input)) {
                    eprintln!("remote input cleanup failed: {error:?}");
                }
            }
        }
    }
}

fn update_held(held: &mut Vec<RemoteInputEvent>, input: RemoteInputEvent) {
    match input {
        RemoteInputEvent::ButtonDown { .. } | RemoteInputEvent::KeyDown { .. } => {
            if !held.iter().any(|item| same_press(*item, input)) {
                held.push(input);
            }
        }
        RemoteInputEvent::ButtonUp { button, .. } => held.retain(|item| {
            !matches!(item,
            RemoteInputEvent::ButtonDown { button: current, .. } if *current == button)
        }),
        RemoteInputEvent::KeyUp { key } => held.retain(|item| {
            !matches!(item,
            RemoteInputEvent::KeyDown { key: current } if *current == key)
        }),
        _ => {}
    }
}

fn same_press(left: RemoteInputEvent, right: RemoteInputEvent) -> bool {
    matches!((left, right),
        (RemoteInputEvent::ButtonDown { button: a, .. }, RemoteInputEvent::ButtonDown { button: b, .. }) if a == b)
        || matches!((left, right),
            (RemoteInputEvent::KeyDown { key: a }, RemoteInputEvent::KeyDown { key: b }) if a == b)
}

fn release_action(input: RemoteInputEvent) -> Injection {
    match input {
        RemoteInputEvent::ButtonDown { button, .. } => Injection::ReleaseMouseButton(button),
        RemoteInputEvent::KeyDown { key } => Injection::Event(RemoteInputEvent::KeyUp { key }),
        other => Injection::Event(other),
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":_-".contains(&byte))
}

fn valid_input(input: RemoteInputEvent) -> bool {
    match input {
        RemoteInputEvent::Wheel { delta } => delta.unsigned_abs() <= 1200,
        _ => true,
    }
}

#[derive(Clone, Copy)]
struct ScreenBounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

fn normalized_to_virtual(
    x: u16,
    y: u16,
    monitor: ScreenBounds,
    virtual_screen: ScreenBounds,
) -> Option<(i32, i32)> {
    let monitor_width = monitor.right.checked_sub(monitor.left)?.checked_sub(1)?;
    let monitor_height = monitor.bottom.checked_sub(monitor.top)?.checked_sub(1)?;
    let virtual_width = virtual_screen
        .right
        .checked_sub(virtual_screen.left)?
        .checked_sub(1)?;
    let virtual_height = virtual_screen
        .bottom
        .checked_sub(virtual_screen.top)?
        .checked_sub(1)?;
    if monitor_width < 1 || monitor_height < 1 || virtual_width < 1 || virtual_height < 1 {
        return None;
    }
    let screen_x = monitor.left + (i64::from(monitor_width) * i64::from(x) / 65535) as i32;
    let screen_y = monitor.top + (i64::from(monitor_height) * i64::from(y) / 65535) as i32;
    Some((
        ((screen_x - virtual_screen.left) as f64 * 65535.0 / f64::from(virtual_width)).round()
            as i32,
        ((screen_y - virtual_screen.top) as f64 * 65535.0 / f64::from(virtual_height)).round()
            as i32,
    ))
}

#[cfg(target_os = "windows")]
pub(super) fn inject(monitor: usize, input: Injection) -> Result<(), ErrorCode> {
    windows::inject(monitor, input)
}

#[cfg(not(target_os = "windows"))]
pub(super) fn inject(_monitor: usize, _input: Injection) -> Result<(), ErrorCode> {
    Err(ErrorCode::PlatformUnsupported)
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use crate::protocol::{RemoteKey, RemoteMouseButton};
    use crate::sources::windows::monitor_and_virtual_bounds;
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
        MOUSEINPUT, SendInput, VIRTUAL_KEY,
    };

    pub(super) fn inject(monitor: usize, input: Injection) -> Result<(), ErrorCode> {
        let mut events = Vec::with_capacity(2);
        match input {
            Injection::ReleaseMouseButton(button) => {
                let flags = match button {
                    RemoteMouseButton::Left => MOUSEEVENTF_LEFTUP,
                    RemoteMouseButton::Right => MOUSEEVENTF_RIGHTUP,
                };
                events.push(mouse(0, 0, 0, flags));
            }
            Injection::Event(input) => match input {
                RemoteInputEvent::Move { x, y } => {
                    let (bounds, virtual_screen) = monitor_and_virtual_bounds(monitor)
                        .ok_or(ErrorCode::RemoteControlTargetUnavailable)?;
                    let (dx, dy) = normalized_to_virtual(
                        x,
                        y,
                        ScreenBounds {
                            left: bounds.left,
                            top: bounds.top,
                            right: bounds.right,
                            bottom: bounds.bottom,
                        },
                        ScreenBounds {
                            left: virtual_screen.left,
                            top: virtual_screen.top,
                            right: virtual_screen.right,
                            bottom: virtual_screen.bottom,
                        },
                    )
                    .ok_or(ErrorCode::RemoteControlTargetUnavailable)?;
                    events.push(mouse(
                        dx,
                        dy,
                        0,
                        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    ));
                }
                RemoteInputEvent::ButtonDown { button, x, y }
                | RemoteInputEvent::ButtonUp { button, x, y } => {
                    let (bounds, virtual_screen) = monitor_and_virtual_bounds(monitor)
                        .ok_or(ErrorCode::RemoteControlTargetUnavailable)?;
                    let (dx, dy) = normalized_to_virtual(
                        x,
                        y,
                        ScreenBounds {
                            left: bounds.left,
                            top: bounds.top,
                            right: bounds.right,
                            bottom: bounds.bottom,
                        },
                        ScreenBounds {
                            left: virtual_screen.left,
                            top: virtual_screen.top,
                            right: virtual_screen.right,
                            bottom: virtual_screen.bottom,
                        },
                    )
                    .ok_or(ErrorCode::RemoteControlTargetUnavailable)?;
                    events.push(mouse(
                        dx,
                        dy,
                        0,
                        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    ));
                    let down = matches!(input, RemoteInputEvent::ButtonDown { .. });
                    let flags = match (button, down) {
                        (RemoteMouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
                        (RemoteMouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
                        (RemoteMouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
                        (RemoteMouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
                    };
                    events.push(mouse(0, 0, 0, flags));
                }
                RemoteInputEvent::Wheel { delta } => {
                    events.push(mouse(0, 0, delta as u32, MOUSEEVENTF_WHEEL))
                }
                RemoteInputEvent::KeyDown { key } | RemoteInputEvent::KeyUp { key } => {
                    let vk = virtual_key(key).ok_or(ErrorCode::RemoteControlInputFailed)?;
                    let flags = if matches!(input, RemoteInputEvent::KeyUp { .. }) {
                        KEYEVENTF_KEYUP
                    } else {
                        Default::default()
                    };
                    events.push(INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: vk,
                                dwFlags: flags,
                                ..Default::default()
                            },
                        },
                    });
                }
            },
        }
        let sent = unsafe { SendInput(&events, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != events.len() {
            return Err(ErrorCode::RemoteControlInputFailed);
        }
        Ok(())
    }

    fn mouse(
        dx: i32,
        dy: i32,
        mouse_data: u32,
        flags: ::windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    ) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: mouse_data,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        }
    }

    fn virtual_key(key: RemoteKey) -> Option<VIRTUAL_KEY> {
        use ::windows::Win32::UI::Input::KeyboardAndMouse::*;
        Some(match key {
            RemoteKey::Enter => VK_RETURN,
            RemoteKey::Escape => VK_ESCAPE,
            RemoteKey::Space => VK_SPACE,
            RemoteKey::Tab => VK_TAB,
            RemoteKey::Backspace => VK_BACK,
            RemoteKey::Delete => VK_DELETE,
            RemoteKey::Home => VK_HOME,
            RemoteKey::End => VK_END,
            RemoteKey::PageUp => VK_PRIOR,
            RemoteKey::PageDown => VK_NEXT,
            RemoteKey::Left => VK_LEFT,
            RemoteKey::Right => VK_RIGHT,
            RemoteKey::Up => VK_UP,
            RemoteKey::Down => VK_DOWN,
            RemoteKey::Shift => VK_SHIFT,
            RemoteKey::Control => VK_CONTROL,
            RemoteKey::Alt => VK_MENU,
            RemoteKey::Digit0 => VK_0,
            RemoteKey::Digit1 => VK_1,
            RemoteKey::Digit2 => VK_2,
            RemoteKey::Digit3 => VK_3,
            RemoteKey::Digit4 => VK_4,
            RemoteKey::Digit5 => VK_5,
            RemoteKey::Digit6 => VK_6,
            RemoteKey::Digit7 => VK_7,
            RemoteKey::Digit8 => VK_8,
            RemoteKey::Digit9 => VK_9,
            RemoteKey::LetterA => VK_A,
            RemoteKey::LetterB => VK_B,
            RemoteKey::LetterC => VK_C,
            RemoteKey::LetterD => VK_D,
            RemoteKey::LetterE => VK_E,
            RemoteKey::LetterF => VK_F,
            RemoteKey::LetterG => VK_G,
            RemoteKey::LetterH => VK_H,
            RemoteKey::LetterI => VK_I,
            RemoteKey::LetterJ => VK_J,
            RemoteKey::LetterK => VK_K,
            RemoteKey::LetterL => VK_L,
            RemoteKey::LetterM => VK_M,
            RemoteKey::LetterN => VK_N,
            RemoteKey::LetterO => VK_O,
            RemoteKey::LetterP => VK_P,
            RemoteKey::LetterQ => VK_Q,
            RemoteKey::LetterR => VK_R,
            RemoteKey::LetterS => VK_S,
            RemoteKey::LetterT => VK_T,
            RemoteKey::LetterU => VK_U,
            RemoteKey::LetterV => VK_V,
            RemoteKey::LetterW => VK_W,
            RemoteKey::LetterX => VK_X,
            RemoteKey::LetterY => VK_Y,
            RemoteKey::LetterZ => VK_Z,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{RemoteKey, RemoteMouseButton};

    #[test]
    fn maps_monitor_local_coordinates_into_negative_offset_virtual_desktop() {
        let point = normalized_to_virtual(
            65535,
            32768,
            ScreenBounds {
                left: -1920,
                top: 0,
                right: 0,
                bottom: 1080,
            },
            ScreenBounds {
                left: -1920,
                top: 0,
                right: 1920,
                bottom: 1080,
            },
        )
        .unwrap();
        assert_eq!(point, (32759, 32737));
    }

    #[test]
    fn only_the_granted_identity_and_new_sequences_are_accepted() {
        let mut manager = RemoteInputManager::default();
        manager
            .grant("share", "monitor:1:0", "control", "alice", 1)
            .unwrap();
        let mut sent = Vec::new();
        let mut apply = |manager: &mut RemoteInputManager, identity: &str, sequence| {
            manager.apply(
                "share",
                "control",
                identity,
                sequence,
                RemoteInputEvent::Move { x: 1, y: 2 },
                |_, event| {
                    sent.push(event);
                    Ok(())
                },
            )
        };
        assert_eq!(
            apply(&mut manager, "", 1),
            Err(ErrorCode::RemoteControlInvalidSession)
        );
        assert_eq!(
            apply(&mut manager, "bob", 1),
            Err(ErrorCode::RemoteControlInvalidSession)
        );
        assert!(apply(&mut manager, "alice", 1).unwrap());
        assert_eq!(
            apply(&mut manager, "alice", 1),
            Err(ErrorCode::RemoteControlInvalidSession)
        );
    }

    #[test]
    fn newer_lossy_move_does_not_block_older_reliable_key_release() {
        let mut manager = RemoteInputManager::default();
        manager
            .grant("share", "monitor:1:0", "control", "alice", 1)
            .unwrap();
        manager
            .apply(
                "share",
                "control",
                "alice",
                1,
                RemoteInputEvent::KeyDown {
                    key: RemoteKey::Escape,
                },
                |_, _| Ok(()),
            )
            .unwrap();
        manager
            .apply(
                "share",
                "control",
                "alice",
                3,
                RemoteInputEvent::Move { x: 300, y: 500 },
                |_, _| Ok(()),
            )
            .unwrap();
        assert!(
            manager
                .apply(
                    "share",
                    "control",
                    "alice",
                    2,
                    RemoteInputEvent::KeyUp {
                        key: RemoteKey::Escape
                    },
                    |_, _| Ok(())
                )
                .unwrap()
        );
        assert_eq!(
            manager.apply(
                "share",
                "control",
                "alice",
                2,
                RemoteInputEvent::Move { x: 1, y: 1 },
                |_, _| Ok(())
            ),
            Err(ErrorCode::RemoteControlInvalidSession)
        );
    }

    #[test]
    fn discrete_overload_ends_control_and_releases_held_keys() {
        let mut manager = RemoteInputManager::default();
        manager
            .grant("share", "monitor:1:0", "control", "alice", 1)
            .unwrap();
        manager
            .apply(
                "share",
                "control",
                "alice",
                1,
                RemoteInputEvent::KeyDown {
                    key: RemoteKey::Escape,
                },
                |_, _| Ok(()),
            )
            .unwrap();
        for sequence in 2..=120 {
            manager
                .apply(
                    "share",
                    "control",
                    "alice",
                    sequence,
                    RemoteInputEvent::Move {
                        x: sequence as u16,
                        y: 10,
                    },
                    |_, _| Ok(()),
                )
                .unwrap();
        }
        let mut released = Vec::new();
        assert_eq!(
            manager.apply(
                "share",
                "control",
                "alice",
                121,
                RemoteInputEvent::KeyUp {
                    key: RemoteKey::Escape
                },
                |_, event| {
                    released.push(event);
                    Ok(())
                }
            ),
            Err(ErrorCode::RemoteControlInputFailed)
        );
        assert_eq!(
            released,
            vec![Injection::Event(RemoteInputEvent::KeyUp {
                key: RemoteKey::Escape
            })]
        );
        assert_eq!(manager.source_id(), None);
    }

    #[test]
    fn revoke_releases_held_buttons_and_keys_and_is_idempotent() {
        let mut manager = RemoteInputManager::default();
        manager
            .grant("share", "monitor:1:0", "control", "alice", 1)
            .unwrap();
        let mut seq = 0;
        for input in [
            RemoteInputEvent::ButtonDown {
                button: RemoteMouseButton::Left,
                x: 12000,
                y: 34000,
            },
            RemoteInputEvent::KeyDown {
                key: RemoteKey::Escape,
            },
        ] {
            seq += 1;
            manager
                .apply("share", "control", "alice", seq, input, |_, _| Ok(()))
                .unwrap();
        }
        let mut released = Vec::new();
        assert_eq!(
            manager.revoke("share", Some("control"), |_, input| {
                released.push(input);
                Ok(())
            }),
            Ok(true)
        );
        assert_eq!(
            released,
            vec![
                Injection::Event(RemoteInputEvent::KeyUp {
                    key: RemoteKey::Escape
                }),
                Injection::ReleaseMouseButton(RemoteMouseButton::Left),
            ]
        );
        assert_eq!(manager.revoke("share", None, |_, _| Ok(())), Ok(false));
    }

    #[test]
    fn failed_release_keeps_the_session_retryable() {
        let mut manager = RemoteInputManager::default();
        manager
            .grant("share", "monitor:1:0", "control", "alice", 1)
            .unwrap();
        manager
            .apply(
                "share",
                "control",
                "alice",
                1,
                RemoteInputEvent::KeyDown {
                    key: RemoteKey::Escape,
                },
                |_, _| Ok(()),
            )
            .unwrap();
        assert_eq!(
            manager.revoke("share", None, |_, _| Err(
                ErrorCode::RemoteControlInputFailed
            )),
            Err(ErrorCode::RemoteControlInputFailed)
        );
        assert_eq!(manager.source_id(), Some("monitor:1:0"));
        assert_eq!(
            manager.revoke("share", None, |_, event| {
                assert_eq!(
                    event,
                    Injection::Event(RemoteInputEvent::KeyUp {
                        key: RemoteKey::Escape
                    })
                );
                Ok(())
            }),
            Ok(true)
        );
    }

    #[test]
    fn failed_revoke_immediately_blocks_more_input_until_cleanup_retry() {
        let mut manager = RemoteInputManager::default();
        manager
            .grant("share", "monitor:1:0", "control", "alice", 1)
            .unwrap();
        manager
            .apply(
                "share",
                "control",
                "alice",
                1,
                RemoteInputEvent::KeyDown {
                    key: RemoteKey::Escape,
                },
                |_, _| Ok(()),
            )
            .unwrap();
        assert_eq!(
            manager.revoke("share", None, |_, _| Err(
                ErrorCode::RemoteControlInputFailed
            )),
            Err(ErrorCode::RemoteControlInputFailed)
        );
        assert_eq!(
            manager.apply(
                "share",
                "control",
                "alice",
                2,
                RemoteInputEvent::KeyUp {
                    key: RemoteKey::Escape
                },
                |_, _| Ok(())
            ),
            Err(ErrorCode::RemoteControlInvalidSession)
        );
        assert_eq!(manager.revoke("share", None, |_, _| Ok(())), Ok(true));
    }

    #[test]
    fn revoke_attempts_every_release_and_mouse_cleanup_has_no_coordinates() {
        let mut manager = RemoteInputManager::default();
        manager
            .grant("share", "monitor:1:0", "control", "alice", usize::MAX)
            .unwrap();
        manager
            .apply(
                "share",
                "control",
                "alice",
                1,
                RemoteInputEvent::ButtonDown {
                    button: RemoteMouseButton::Left,
                    x: 12000,
                    y: 34000,
                },
                |_, _| Ok(()),
            )
            .unwrap();
        manager
            .apply(
                "share",
                "control",
                "alice",
                2,
                RemoteInputEvent::KeyDown {
                    key: RemoteKey::Escape,
                },
                |_, _| Ok(()),
            )
            .unwrap();

        let mut attempted = Vec::new();
        assert_eq!(
            manager.revoke("share", None, |monitor, action| {
                assert_eq!(monitor, usize::MAX);
                attempted.push(action);
                if matches!(action, Injection::Event(RemoteInputEvent::KeyUp { .. })) {
                    Err(ErrorCode::RemoteControlInputFailed)
                } else {
                    Ok(())
                }
            }),
            Err(ErrorCode::RemoteControlInputFailed)
        );
        assert_eq!(
            attempted,
            vec![
                Injection::Event(RemoteInputEvent::KeyUp {
                    key: RemoteKey::Escape
                }),
                Injection::ReleaseMouseButton(RemoteMouseButton::Left),
            ]
        );
        assert_eq!(manager.source_id(), Some("monitor:1:0"));
        assert_eq!(manager.revoke("share", None, |_, _| Ok(())), Ok(true));
    }

    #[test]
    fn input_failure_closes_the_grant_and_releases_previously_held_keys() {
        let mut manager = RemoteInputManager::default();
        manager
            .grant("share", "monitor:1:0", "control", "alice", 1)
            .unwrap();
        manager
            .apply(
                "share",
                "control",
                "alice",
                1,
                RemoteInputEvent::KeyDown {
                    key: RemoteKey::Escape,
                },
                |_, _| Ok(()),
            )
            .unwrap();
        let mut events = Vec::new();
        assert_eq!(
            manager.apply(
                "share",
                "control",
                "alice",
                2,
                RemoteInputEvent::Move { x: 10, y: 10 },
                |_, event| {
                    events.push(event);
                    if matches!(event, Injection::Event(RemoteInputEvent::Move { .. })) {
                        Err(ErrorCode::RemoteControlInputFailed)
                    } else {
                        Ok(())
                    }
                }
            ),
            Err(ErrorCode::RemoteControlInputFailed)
        );
        assert_eq!(
            events,
            vec![
                Injection::Event(RemoteInputEvent::Move { x: 10, y: 10 }),
                Injection::Event(RemoteInputEvent::KeyUp {
                    key: RemoteKey::Escape
                })
            ]
        );
        assert_eq!(manager.source_id(), None);
        assert_eq!(
            manager.apply(
                "share",
                "control",
                "alice",
                3,
                RemoteInputEvent::Move { x: 11, y: 11 },
                |_, _| Ok(())
            ),
            Err(ErrorCode::RemoteControlInvalidSession)
        );
    }
}
