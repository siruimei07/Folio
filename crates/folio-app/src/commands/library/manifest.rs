//! Implemented library commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &[
    "library_status",
    "pick_library_folder",
    "create_library",
    "open_library",
];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::library::library_status,
            crate::commands::library::pick_library_folder,
            crate::commands::library::create_library,
            crate::commands::library::open_library,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
