//! Implemented workspace commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &[];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
