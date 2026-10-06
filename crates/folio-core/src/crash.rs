//! Crash points: where a write that keeps durable state could stop because the process died or the
//! power failed (versioning.md §7.5: "crash injection runs at every step").
//!
//! Code that writes durable state calls [`point`] right before each effect a later step depends on:
//! a write, a flush, a rename, a removal. Outside tests a point does nothing. In tests,
//! `each_point` runs an operation once per point it reaches, crashing it at its first point, then
//! at its second, and so on until a run completes, and lets the test check after each crash what a
//! process that starts afterwards finds. A new write step is covered by every such test without a
//! new one.
//!
//! A crash is a panic with a `Crash` payload, caught by the harness. Code that writes durable
//! state must not clean up in `Drop`, or a simulated crash would leave less behind than a real one.
//! The countdown is thread-local: an operation under test runs on the test's thread.
//!
//! An effect can also fail without a crash: an effect that calls [`fault`] after its point fails
//! with an injected error while a test runs it under `fail_at` with its step, for the failures a
//! test cannot make the system cause: a file that can be renamed but not deleted (the local
//! store's removals), a full disk under each write of a pack file (`FileSink`: `pack.flush` for its
//! buffer, `pack.write` past it, `pack.truncate`, `pack.sync`, faults also where no point precedes
//! them) and under the atomic writer's write and flush (`atomic.write`, and `atomic.sync`, which no
//! point precedes), and a failing look at what is at a path of the local store, which every read
//! and write of the store starts with and a file held open never fails (`store.metadata`, which no
//! point precedes). The fault is part of the effect's result, so code that dropped the effect's
//! error would drop the fault's too.
//!
//! What a power loss would undo is not simulated: the crashes model the order of effects. So the
//! calls that make an effect durable [`note`] it, in tests only: a flush of a file to the disk
//! (`sync`, by `files::sync_all`) and a rename by `MoveFileExW` (`rename`, `rename.replace`, and
//! `rename.durable` or `rename.durable.replace` when written through to the disk). The writes a
//! flush must cover are noted too (`write`, and `cut` for a pack file cut back), so that a test
//! sees the flush come after them. A test runs an operation under `noting` to check that the
//! effects it depends on are durable.
//!
//! Step names say what the point comes before:
//!
//! | Step | Before |
//! |---|---|
//! | `atomic.write`, `atomic.rename` | writing a staged file's bytes, renaming it over its target (`files::write_atomically`, its durable variant) |
//! | `pack.write`, `pack.truncate`, `pack.sync` | appending to a pack in `staging/`, cutting a streamed blob away, flushing the pack |
//! | `pack.publish`, `pack.replace`, `pack.discard` | renaming a staged pack into `packs/`, over a damaged pack, removing a staged copy of a pack that is there |
//! | `pack.abandon` | removing a pack that is not published |
//! | `pack.remove`, `pack.delete` | moving a pack out of `packs/`, deleting it |
//! | `staging.clean` | removing a pack file left in `staging/` |

/// Marks the point right before an effect of a write, named `step` (see the table above). Nothing
/// happens outside tests.
#[cfg_attr(
    not(test),
    allow(unused_variables, reason = "a crash point does nothing outside tests")
)]
#[inline]
pub(crate) fn point(step: &'static str) {
    #[cfg(test)]
    harness::point(step);
}

/// Whether the effect after the point `step` fails with an injected error: only in tests, while an
/// operation runs under `fail_at` with this step. `Ok(())` outside tests.
#[cfg(not(test))]
#[inline]
pub(crate) fn fault(_step: &'static str) -> std::io::Result<()> {
    Ok(())
}

/// See the other `fault`: in tests, an injected error while `fail_at` arms `step`.
#[cfg(test)]
pub(crate) fn fault(step: &'static str) -> std::io::Result<()> {
    harness::fault(step)
}

/// Notes that the effect `effect` just happened: one that makes others durable, or a write a flush
/// must cover (see the module's docs). Nothing happens outside tests.
#[cfg_attr(
    not(test),
    allow(unused_variables, reason = "a note does nothing outside tests")
)]
#[inline]
pub(crate) fn note(effect: &'static str) {
    #[cfg(test)]
    harness::note(effect);
}

#[cfg(test)]
pub(crate) use harness::{Crash, crash_at, each_point, fail_at, noting};

#[cfg(test)]
mod harness {
    use std::cell::{Cell, RefCell};
    use std::io;
    use std::panic::{self, AssertUnwindSafe};
    use std::sync::Once;

    /// The most runs [`each_point`] makes: an operation with more points than this never settles.
    const MAX_RUNS: usize = 10_000;

    /// The payload of a simulated crash: the step it happened before.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct Crash {
        pub(crate) step: &'static str,
    }

    thread_local! {
        /// The points left until the crash, counting the crashing one, while an operation runs
        /// under [`crash_at`].
        static COUNTDOWN: Cell<Option<usize>> = const { Cell::new(None) };
        /// The step whose effects fail while an operation runs under [`fail_at`].
        static FAULT: Cell<Option<&'static str>> = const { Cell::new(None) };
        /// The effects noted while an operation runs under [`noting`].
        static NOTED: RefCell<Option<Vec<&'static str>>> = const { RefCell::new(None) };
    }

    pub(super) fn note(effect: &'static str) {
        NOTED.with_borrow_mut(|noted| {
            if let Some(noted) = noted {
                noted.push(effect);
            }
        });
    }

    /// Runs `operation` and returns its result with the effects it noted, in order.
    pub(crate) fn noting<T>(operation: impl FnOnce() -> T) -> (T, Vec<&'static str>) {
        let armed = NOTED.replace(Some(Vec::new()));
        assert_eq!(armed, None, "one operation noted at a time");
        // Stopped however the operation ends.
        struct Stop;
        impl Drop for Stop {
            fn drop(&mut self) {
                NOTED.set(None);
            }
        }
        let _stop = Stop;
        let result = operation();
        (result, NOTED.take().unwrap_or_default())
    }

    pub(super) fn fault(step: &'static str) -> io::Result<()> {
        if FAULT.get() == Some(step) {
            Err(io::Error::other(format!("a fault injected at {step}")))
        } else {
            Ok(())
        }
    }

    /// Runs `operation` with every effect after the point `step` failing (see [`super::fault`]),
    /// and returns its result.
    pub(crate) fn fail_at<T>(step: &'static str, operation: impl FnOnce() -> T) -> T {
        let armed = FAULT.replace(Some(step));
        assert_eq!(armed, None, "one fault armed at a time");
        // Disarmed again however the operation ends.
        struct Disarm;
        impl Drop for Disarm {
            fn drop(&mut self) {
                FAULT.set(None);
            }
        }
        let _disarm = Disarm;
        operation()
    }

    pub(super) fn point(step: &'static str) {
        let crash = COUNTDOWN.with(|countdown| match countdown.get() {
            Some(1) => {
                countdown.set(None);
                true
            }
            Some(left) => {
                countdown.set(Some(left - 1));
                false
            }
            None => false,
        });
        if crash {
            panic::panic_any(Crash { step });
        }
    }

    /// Runs `operation` with its `n`-th crash point (counting from 1) armed: `Err(step)` when it
    /// crashed there, its result when it completed before reaching that point. Any other panic
    /// goes on unwinding.
    pub(crate) fn crash_at<T>(n: usize, operation: impl FnOnce() -> T) -> Result<T, &'static str> {
        assert!(n > 0, "crash points count from 1");
        quiet_crashes();
        let armed = COUNTDOWN.replace(Some(n));
        assert_eq!(armed, None, "one crash armed at a time");
        let result = panic::catch_unwind(AssertUnwindSafe(operation));
        COUNTDOWN.set(None);
        match result {
            Ok(value) => Ok(value),
            Err(payload) => match payload.downcast::<Crash>() {
                Ok(crash) => Err(crash.step),
                Err(payload) => panic::resume_unwind(payload),
            },
        }
    }

    /// Runs `case` with the `n`-th crash point armed for n = 1, 2, … until a run completes, and
    /// returns the step of each crash in order: the points of the operation as it reaches them.
    ///
    /// `case` builds its state, runs the operation through [`Arm::run`] exactly once, and checks
    /// what the crash left (or what the completed operation did). Points reached outside
    /// `Arm::run`, in setting up or checking, never crash.
    pub(crate) fn each_point(mut case: impl FnMut(&mut Arm)) -> Vec<&'static str> {
        let mut steps = Vec::new();
        for n in 1..=MAX_RUNS {
            let mut arm = Arm { n, ran: None };
            case(&mut arm);
            match arm
                .ran
                .expect("the case runs its operation through Arm::run")
            {
                Some(step) => steps.push(step),
                None => return steps,
            }
        }
        panic!("the operation crashed in each of {MAX_RUNS} runs");
    }

    /// The crash [`each_point`] arms for one run of a case.
    #[derive(Debug)]
    pub(crate) struct Arm {
        n: usize,
        /// Set by [`Arm::run`]: the step it crashed at, or `None` when it completed.
        ran: Option<Option<&'static str>>,
    }

    impl Arm {
        /// The point that crashes, counting from 1.
        pub(crate) fn n(&self) -> usize {
            self.n
        }

        /// Runs `operation` with the crash armed: `Err(step)` when it crashed there, its result
        /// when it completed.
        pub(crate) fn run<T>(&mut self, operation: impl FnOnce() -> T) -> Result<T, &'static str> {
            assert!(self.ran.is_none(), "a case runs its operation once");
            let result = crash_at(self.n, operation);
            self.ran = Some(result.as_ref().err().copied());
            result
        }
    }

    /// Keeps the panic hook from printing simulated crashes; other panics print as before.
    fn quiet_crashes() {
        static HOOK: Once = Once::new();
        HOOK.call_once(|| {
            let previous = panic::take_hook();
            panic::set_hook(Box::new(move |info| {
                if info.payload().downcast_ref::<Crash>().is_none() {
                    previous(info);
                }
            }));
        });
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// An operation of three steps that records the effects it made.
    fn three_steps(done: &RefCell<Vec<&'static str>>) -> usize {
        for step in ["one", "two", "three"] {
            point(step);
            done.borrow_mut().push(step);
        }
        done.borrow().len()
    }

    #[test]
    fn points_do_nothing_unless_armed() {
        let done = RefCell::new(Vec::new());
        assert_eq!(three_steps(&done), 3);
        assert_eq!(
            crash_at(4, || three_steps(&RefCell::new(Vec::new()))),
            Ok(3)
        );
        // Disarmed again after a run that completed.
        point("after");
    }

    #[test]
    fn crashes_at_the_nth_point_with_the_effects_before_it() {
        let done = RefCell::new(Vec::new());
        assert_eq!(crash_at(2, || three_steps(&done)), Err("two"));
        assert_eq!(*done.borrow(), ["one"]);
        // Disarmed after the crash.
        point("after");
    }

    #[test]
    fn each_point_crashes_every_step_until_the_operation_completes() {
        let mut seen = Vec::new();
        let steps = each_point(|arm| {
            let done = RefCell::new(Vec::new());
            // Points outside the run never crash.
            point("setup");
            let result = arm.run(|| three_steps(&done));
            point("check");
            match result {
                Ok(count) => assert_eq!((arm.n(), count), (4, 3)),
                Err(step) => assert_eq!(done.borrow().len(), arm.n() - 1, "{step}"),
            }
            seen.push(arm.n());
        });
        assert_eq!(steps, ["one", "two", "three"]);
        assert_eq!(seen, [1, 2, 3, 4]);
    }

    #[test]
    fn an_operation_without_points_completes_at_once() {
        let steps = each_point(|arm| assert_eq!(arm.run(|| 7), Ok(7)));
        assert!(steps.is_empty());
    }

    #[test]
    fn other_panics_go_on() {
        let panicked =
            std::panic::catch_unwind(|| crash_at(1, || -> u8 { panic!("a real failure") }));
        let payload = panicked.unwrap_err();
        assert_eq!(payload.downcast_ref::<&str>(), Some(&"a real failure"));
        // The countdown was disarmed on the way out.
        assert_eq!(crash_at(1, || 1), Ok(1));
    }

    #[test]
    fn faults_fail_only_the_armed_step_while_armed() {
        assert!(fault("two").is_ok());
        let failed = fail_at("two", || {
            ["one", "two", "three", "two"]
                .map(|step| fault(step).map_err(|error| error.to_string()))
        });
        let injected = Err("a fault injected at two".to_owned());
        assert_eq!(failed, [Ok(()), injected.clone(), Ok(()), injected]);
        // Disarmed after the run, also after one that panicked.
        assert!(fault("two").is_ok());
        let panicked =
            std::panic::catch_unwind(|| fail_at("two", || -> u8 { panic!("a real failure") }));
        assert!(panicked.is_err());
        assert!(fault("two").is_ok());
        let nested = std::panic::catch_unwind(|| fail_at("one", || fail_at("two", || ())));
        assert!(nested.is_err(), "one fault armed at a time");
        assert!(fault("one").is_ok());
    }

    #[test]
    fn notes_are_kept_only_while_an_operation_is_noted() {
        note("before");
        let (result, noted) = noting(|| {
            note("sync");
            note("rename.durable");
            7
        });
        assert_eq!((result, noted), (7, vec!["sync", "rename.durable"]));
        note("after");
        assert_eq!(noting(|| ()).1, Vec::<&str>::new());
        // Stopped after a run that panicked, and one at a time.
        let panicked = std::panic::catch_unwind(|| noting(|| -> u8 { panic!("a real failure") }));
        assert!(panicked.is_err());
        let nested = std::panic::catch_unwind(|| noting(|| noting(|| ())));
        assert!(nested.is_err(), "one operation noted at a time");
        assert_eq!(noting(|| note("sync")).1, ["sync"]);
    }

    #[test]
    fn arming_twice_is_a_mistake_not_a_crash() {
        let nested = std::panic::catch_unwind(|| crash_at(1, || crash_at(1, || 0)));
        let payload = nested.unwrap_err();
        assert!(payload.downcast_ref::<Crash>().is_none());
        assert_eq!(crash_at(1, || 1), Ok(1));
    }
}
