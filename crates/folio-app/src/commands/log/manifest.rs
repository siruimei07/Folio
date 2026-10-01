//! Implemented log commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &["log_ui_error"];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::log::log_ui_error,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
