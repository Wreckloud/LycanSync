//! 普通视频采集会话的状态机；远控授权由 RemoteInputManager 独立持有并依附于该会话。

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    #[default]
    Idle,
    Starting,
    Running,
    Stopping,
}

#[derive(Debug, Eq, PartialEq)]
pub enum StateError {
    InvalidTransition {
        current: SessionState,
        requested: SessionState,
    },
    SessionMismatch,
}

#[derive(Default)]
pub struct SessionMachine {
    state: SessionState,
    session_id: Option<String>,
}

impl SessionMachine {
    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn begin(&mut self, session_id: String) -> Result<(), StateError> {
        self.transition(SessionState::Starting)?;
        self.session_id = Some(session_id);
        Ok(())
    }

    pub fn mark_running(&mut self) -> Result<(), StateError> {
        self.transition(SessionState::Running)
    }

    pub fn begin_stop(&mut self, session_id: &str) -> Result<(), StateError> {
        if self.session_id() != Some(session_id) {
            return Err(StateError::SessionMismatch);
        }
        self.transition(SessionState::Stopping)
    }

    pub fn finish_stop(&mut self) -> Result<(), StateError> {
        self.transition(SessionState::Idle)?;
        self.session_id = None;
        Ok(())
    }

    pub fn fail_start(&mut self) -> Result<(), StateError> {
        if self.state != SessionState::Starting {
            return Err(StateError::InvalidTransition {
                current: self.state,
                requested: SessionState::Idle,
            });
        }
        self.state = SessionState::Idle;
        self.session_id = None;
        Ok(())
    }

    fn transition(&mut self, requested: SessionState) -> Result<(), StateError> {
        let valid = matches!(
            (self.state, requested),
            (SessionState::Idle, SessionState::Starting)
                | (SessionState::Starting, SessionState::Running)
                | (SessionState::Running, SessionState::Stopping)
                | (SessionState::Stopping, SessionState::Idle)
        );
        if !valid {
            return Err(StateError::InvalidTransition {
                current: self.state,
                requested,
            });
        }
        self.state = requested;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{SessionMachine, SessionState, StateError};

    #[test]
    fn completes_normal_lifecycle() {
        let mut machine = SessionMachine::default();

        machine.begin("capture-1".to_owned()).unwrap();
        assert_eq!(machine.state(), SessionState::Starting);
        machine.mark_running().unwrap();
        assert_eq!(machine.state(), SessionState::Running);
        machine.begin_stop("capture-1").unwrap();
        assert_eq!(machine.state(), SessionState::Stopping);
        machine.finish_stop().unwrap();
        assert_eq!(machine.state(), SessionState::Idle);
        assert_eq!(machine.session_id(), None);
    }

    #[test]
    fn rejects_parallel_session_and_mismatched_stop() {
        let mut machine = SessionMachine::default();
        machine.begin("capture-1".to_owned()).unwrap();

        assert!(matches!(
            machine.begin("capture-2".to_owned()),
            Err(StateError::InvalidTransition { .. })
        ));
        machine.mark_running().unwrap();
        assert_eq!(
            machine.begin_stop("capture-2"),
            Err(StateError::SessionMismatch)
        );
    }

    #[test]
    fn returns_to_idle_after_start_failure() {
        let mut machine = SessionMachine::default();
        machine.begin("capture-1".to_owned()).unwrap();

        machine.fail_start().unwrap();

        assert_eq!(machine.state(), SessionState::Idle);
        assert_eq!(machine.session_id(), None);
    }
}
