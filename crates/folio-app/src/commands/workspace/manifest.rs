//! Implemented workspace commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &[
    "get_workspace",
    "list_workspace_items",
    "list_metadata_changes",
    "summarize_selection",
];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::workspace::get_workspace,
            crate::commands::workspace::list_workspace_items,
            crate::commands::workspace::list_metadata_changes,
            crate::commands::workspace::summarize_selection,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
