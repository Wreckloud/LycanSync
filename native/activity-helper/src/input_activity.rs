//! 只保留最近有效操作时间，不输出光标坐标、按键或设备身份。

use std::time::{Duration, Instant};

pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
const REPORT_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct InputActivity {
    cursor: Option<(i32, i32)>,
    cursor_moved_at: Option<Instant>,
    last_active: Option<Instant>,
    last_report: Option<Instant>,
    next_controller_checks: [Option<Instant>; 4],
}

impl InputActivity {
    pub fn sample(&mut self, now: Instant) -> Option<Option<f64>> {
        let cursor = read_cursor();
        let mut controller_active = false;
        for (index, next_check) in self.next_controller_checks.iter_mut().enumerate() {
            if next_check.is_some_and(|next| now < next) {
                continue;
            }
            match read_controller(index as u32) {
                Some(active) => {
                    controller_active |= active;
                    *next_check = None;
                }
                // 未连接的插槽每三秒检查一次，避免反复查询空设备。
                None => *next_check = Some(now + Duration::from_secs(3)),
            }
        }
        self.observe(now, cursor, controller_active);
        if self
            .last_report
            .is_some_and(|last| now.duration_since(last) < REPORT_INTERVAL)
        {
            return None;
        }
        self.last_report = Some(now);
        Some(
            self.last_active
                .map(|last| now.duration_since(last).as_secs_f64()),
        )
    }

    fn observe(&mut self, now: Instant, cursor: Option<(i32, i32)>, controller_active: bool) {
        let moved = match (self.cursor, cursor) {
            (Some((x, y)), Some((next_x, next_y))) => {
                (i64::from(x) - i64::from(next_x)).abs() >= 4
                    || (i64::from(y) - i64::from(next_y)).abs() >= 4
            }
            _ => false,
        };
        self.cursor = cursor;
        let continuous_movement = moved
            && self
                .cursor_moved_at
                .is_some_and(|last| now.duration_since(last) <= Duration::from_secs(1));
        if moved {
            self.cursor_moved_at = Some(now);
        } else if cursor.is_none() {
            self.cursor_moved_at = None;
        }
        if continuous_movement || controller_active {
            self.last_active = Some(now);
        }
    }
}

#[cfg(target_os = "windows")]
fn read_cursor() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    // 仅同步读取当前位置；锁屏或切换桌面时可能不可读，不据此产生活动。
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x, point.y))
}

#[cfg(target_os = "windows")]
fn read_controller(index: u32) -> Option<bool> {
    use windows::Win32::UI::Input::XboxController::{XINPUT_STATE, XInputGetState};
    let mut state = XINPUT_STATE::default();
    // 索引仅为 0..4，输出指针在同步调用期间有效；不设置震动或注入输入。
    if unsafe { XInputGetState(index, &mut state) } != 0 {
        return None;
    }
    let pad = state.Gamepad;
    Some(controller_active(
        pad.wButtons.0,
        pad.bLeftTrigger,
        pad.bRightTrigger,
        (pad.sThumbLX, pad.sThumbLY),
        (pad.sThumbRX, pad.sThumbRY),
    ))
}

fn controller_active(
    buttons: u16,
    left_trigger: u8,
    right_trigger: u8,
    left: (i16, i16),
    right: (i16, i16),
) -> bool {
    // 微软推荐的圆形摇杆死区与扳机阈值；按住不变也是持续操作。
    let outside = |(x, y): (i16, i16), deadzone: i64| {
        i64::from(x).pow(2) + i64::from(y).pow(2) > deadzone.pow(2)
    };
    buttons & 0xf3ff != 0
        || left_trigger > 30
        || right_trigger > 30
        || outside(left, 7849)
        || outside(right, 8689)
}

#[cfg(not(target_os = "windows"))]
fn read_cursor() -> Option<(i32, i32)> {
    None
}

#[cfg(not(target_os = "windows"))]
fn read_controller(_: u32) -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connected_or_drifting_controller_is_not_activity() {
        assert!(!controller_active(0, 30, 30, (3000, -3000), (5000, 5000)));
        assert!(!controller_active(0x0c00, 0, 0, (0, 0), (0, 0)));
        assert!(controller_active(0x1000, 0, 0, (0, 0), (0, 0)));
        assert!(controller_active(0, 31, 0, (0, 0), (0, 0)));
        assert!(controller_active(0, 0, 31, (0, 0), (0, 0)));
        assert!(controller_active(0, 0, 0, (6000, 6000), (0, 0)));
        assert!(controller_active(0, 0, 0, (0, 0), (i16::MIN, i16::MIN)));
    }

    #[test]
    fn cursor_requires_repeated_movement_and_does_not_remain_active() {
        let mut activity = InputActivity::default();
        let now = Instant::now();
        activity.observe(now, Some((0, 0)), false);
        activity.observe(now + SAMPLE_INTERVAL, Some((1, 1)), false);
        activity.observe(now + SAMPLE_INTERVAL * 2, Some((20, 20)), false);
        assert!(activity.last_active.is_none());
        activity.observe(now + SAMPLE_INTERVAL * 3, Some((30, 30)), false);
        assert_eq!(activity.last_active, Some(now + SAMPLE_INTERVAL * 3));
        activity.observe(now + Duration::from_secs(300), Some((50, 50)), false);
        assert_eq!(activity.last_active, Some(now + SAMPLE_INTERVAL * 3));
        activity.observe(now + Duration::from_secs(301), None, false);
        activity.observe(now + Duration::from_secs(302), Some((80, 80)), false);
        assert_eq!(activity.last_active, Some(now + SAMPLE_INTERVAL * 3));
    }

    #[test]
    fn held_controller_counts_but_release_and_disconnect_do_not() {
        let mut activity = InputActivity::default();
        let now = Instant::now();
        for seconds in 0..600 {
            activity.observe(now + Duration::from_secs(seconds), None, true);
        }
        let last = activity.last_active;
        assert_eq!(last, Some(now + Duration::from_secs(599)));
        activity.observe(now + Duration::from_secs(900), None, false);
        assert_eq!(activity.last_active, last);
    }
}
