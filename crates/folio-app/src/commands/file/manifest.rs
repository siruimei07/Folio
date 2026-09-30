//! Implemented file commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &["open_entry", "reveal_entry"];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::file::open_entry,
            crate::commands::file::reveal_entry,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
