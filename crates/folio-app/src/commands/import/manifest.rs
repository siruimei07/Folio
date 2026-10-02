//! Implemented import commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &["pick_import_files", "check_import", "import_files"];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::import::pick_import_files,
            crate::commands::import::check_import,
            crate::commands::import::import_files,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
