//! Implemented jobs commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &[
    "list_jobs",
    "cancel_job",
    "rebuild_catalog",
    "list_problems",
];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::jobs::list_jobs,
            crate::commands::jobs::cancel_job,
            crate::commands::jobs::rebuild_catalog,
            crate::commands::jobs::list_problems,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
