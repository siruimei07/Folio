//! Implemented shell commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &["app_info", "set_maximize_button_bounds"];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::shell::app_info,
            crate::commands::shell::set_maximize_button_bounds,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
