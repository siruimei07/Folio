//! Implemented browse commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &[
    "list_children",
    "list_files",
    "get_entry",
    "search",
    "resolve_paths",
];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::browse::list_children,
            crate::commands::browse::list_files,
            crate::commands::browse::get_entry,
            crate::commands::browse::search,
            crate::commands::browse::resolve_paths,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
