//! Implemented operations commands only; the manifest and ACL use the same command group.

pub const COMMANDS: &[&str] = &[
    "list_semesters",
    "create_semester",
    "update_semester",
    "reorder_semesters",
    "list_courses",
    "create_course",
    "update_course",
    "reorder_courses",
    "list_tags",
    "create_tag",
    "update_tag",
    "reorder_tags",
    "delete_tag",
    "set_entry_tags",
    "create_folder",
    "rename_entry",
    "move_entries",
    "delete_entries",
];

macro_rules! append_commands {
    ($next:ident, [$($commands:tt)*]; $($remaining:ident),*) => {
        $next!([
            $($commands)*
            crate::commands::operations::list_semesters,
            crate::commands::operations::create_semester,
            crate::commands::operations::update_semester,
            crate::commands::operations::reorder_semesters,
            crate::commands::operations::list_courses,
            crate::commands::operations::create_course,
            crate::commands::operations::update_course,
            crate::commands::operations::reorder_courses,
            crate::commands::operations::list_tags,
            crate::commands::operations::create_tag,
            crate::commands::operations::update_tag,
            crate::commands::operations::reorder_tags,
            crate::commands::operations::delete_tag,
            crate::commands::operations::set_entry_tags,
            crate::commands::operations::create_folder,
            crate::commands::operations::rename_entry,
            crate::commands::operations::move_entries,
            crate::commands::operations::delete_entries,
        ]; $($remaining),*)
    };
}

pub(crate) use append_commands;
