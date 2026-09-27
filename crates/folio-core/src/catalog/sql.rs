//! Conversions between core types and SQLite values. Reading validates again: a value that
//! fails is a conversion error, never silently repaired.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};

use crate::hash::ContentHash;
use crate::meta::{Abbr, Color, DisplayName, EntryKind, FileClass, TagId};
use crate::paths::{CoursePath, RelPath, SemesterPath};

fn parse_text<T, E>(
    value: ValueRef<'_>,
    parse: impl FnOnce(&str) -> Result<T, E>,
) -> FromSqlResult<T>
where
    E: std::error::Error + Send + Sync + 'static,
{
    parse(value.as_str()?).map_err(FromSqlError::other)
}

/// Text columns holding one of the core's validated strings.
macro_rules! text_sql {
    ($($type:ty),*) => {$(
        impl FromSql for $type {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                parse_text(value, <$type>::parse)
            }
        }

        impl ToSql for $type {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }
    )*};
}

text_sql!(RelPath, ContentHash, TagId, Color, DisplayName, Abbr);

/// Paths whose depth is part of their type.
macro_rules! depth_sql {
    ($($type:ty),*) => {$(
        impl FromSql for $type {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                let path = RelPath::column_result(value)?;
                <$type>::new(path).map_err(FromSqlError::other)
            }
        }

        impl ToSql for $type {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.path().as_str().into())
            }
        }
    )*};
}

depth_sql!(SemesterPath, CoursePath);

/// Text columns holding one of a fixed set of words.
macro_rules! word_sql {
    ($type:ty { $($word:literal => $variant:path),* $(,)? }) => {
        impl FromSql for $type {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                match value.as_str()? {
                    $($word => Ok($variant),)*
                    other => Err(FromSqlError::Other(
                        format!("unknown {} {other:?}", stringify!($type)).into(),
                    )),
                }
            }
        }

        impl ToSql for $type {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(match self {
                    $($variant => $word,)*
                }
                .into())
            }
        }
    };
}

word_sql!(EntryKind {
    "file" => EntryKind::File,
    "folder" => EntryKind::Folder,
});

word_sql!(FileClass {
    "text" => FileClass::Text,
    "word" => FileClass::Word,
    "other" => FileClass::Other,
});
