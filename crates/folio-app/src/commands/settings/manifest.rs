//! Implemented settings commands only; planned commands must not enter this list or the ACL.

pub const COMMANDS: &[&str] = &[
    "get_app_settings",
    "update_app_settings",
    "get_ignore_rules",
    "set_ignore_rules",
];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::settings::get_app_settings,
            crate::commands::settings::update_app_settings,
            crate::commands::settings::get_ignore_rules,
            crate::commands::settings::set_ignore_rules,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
