//! Bounded anti-entropy for a small native-to-renderer level signal.
//!
//! The caller samples a current value on a fixed poll loop. A new value is
//! published immediately, then confirmed a bounded number of times at a fixed
//! poll cadence. Only a successful publication consumes a confirmation, so a
//! transient emitter failure is retried on the next poll instead of silently
//! converting the level back into a one-shot edge.

#[derive(Debug)]
pub(super) struct LevelConfirmation<T> {
    observed: Option<T>,
    sends_remaining: u8,
    polls_until_send: u8,
    sends_per_level: u8,
    polls_between_sends: u8,
}

impl<T: Copy + Eq> LevelConfirmation<T> {
    pub(super) fn new(sends_per_level: u8, polls_between_sends: u8) -> Self {
        assert!(sends_per_level > 0, "a level needs at least one publication");
        assert!(
            polls_between_sends > 0,
            "confirmation cadence must include at least one poll"
        );
        Self {
            observed: None,
            sends_remaining: 0,
            polls_until_send: 0,
            sends_per_level,
            polls_between_sends,
        }
    }

    pub(super) fn should_publish(&mut self, current: T) -> bool {
        if self.observed != Some(current) {
            self.observed = Some(current);
            self.sends_remaining = self.sends_per_level;
            self.polls_until_send = 0;
        }

        if self.sends_remaining == 0 {
            return false;
        }
        if self.polls_until_send > 0 {
            self.polls_until_send -= 1;
            return false;
        }
        true
    }

    pub(super) fn mark_published(&mut self) {
        debug_assert!(self.sends_remaining > 0);
        debug_assert_eq!(self.polls_until_send, 0);
        self.sends_remaining -= 1;
        if self.sends_remaining > 0 {
            self.polls_until_send = self.polls_between_sends - 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LevelConfirmation;

    #[test]
    fn confirms_each_observed_level_then_goes_quiet() {
        let mut confirmation = LevelConfirmation::new(3, 2);
        let mut published = 0;

        for _ in 0..20 {
            if confirmation.should_publish(false) {
                published += 1;
                confirmation.mark_published();
            }
        }

        assert_eq!(published, 3);
        assert!(!confirmation.should_publish(false));
    }

    #[test]
    fn failed_publication_is_due_again_on_the_next_poll() {
        let mut confirmation = LevelConfirmation::new(2, 3);

        assert!(confirmation.should_publish(false));
        assert!(confirmation.should_publish(false));
        confirmation.mark_published();

        assert!(!confirmation.should_publish(false));
        assert!(!confirmation.should_publish(false));
        assert!(confirmation.should_publish(false));
    }

    #[test]
    fn a_new_level_preempts_the_previous_confirmation_delay() {
        let mut confirmation = LevelConfirmation::new(2, 5);

        assert!(confirmation.should_publish(false));
        confirmation.mark_published();
        assert!(!confirmation.should_publish(false));

        assert!(confirmation.should_publish(true));
    }
}
