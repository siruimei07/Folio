//! Semester and course settings, mirrored from `.folio/meta/` for sorting and filtering
//! (docs/specs/library-core.md §5.2).

use rusqlite::{Connection, Row, params};

use super::{BELOW, CatalogError};
use crate::meta::{CourseCode, CourseSettings, GroupSettings};
use crate::paths::{CoursePath, SemesterPath};

pub fn put_semester(
    conn: &Connection,
    semester: &SemesterPath,
    settings: &GroupSettings,
) -> Result<(), CatalogError> {
    conn.execute(
        "INSERT INTO semesters (path, sort_order, archived) VALUES (?1, ?2, ?3)
         ON CONFLICT (path) DO UPDATE
         SET sort_order = excluded.sort_order, archived = excluded.archived",
        params![semester, settings.order, settings.archived],
    )?;
    Ok(())
}

/// Removes the settings of a semester; its courses keep theirs.
pub fn remove_semester(conn: &Connection, semester: &SemesterPath) -> Result<(), CatalogError> {
    conn.execute("DELETE FROM semesters WHERE path = ?1", [semester])?;
    Ok(())
}

/// Every semester, in the user's order.
pub fn semesters(conn: &Connection) -> Result<Vec<(SemesterPath, GroupSettings)>, CatalogError> {
    let semesters = conn
        .prepare_cached(
            "SELECT path, sort_order, archived FROM semesters ORDER BY sort_order, path",
        )?
        .query_map([], |row| {
            let settings = GroupSettings {
                order: row.get(1)?,
                archived: row.get(2)?,
            };
            Ok((row.get(0)?, settings))
        })?
        .collect::<Result<_, _>>()?;
    Ok(semesters)
}

pub fn put_course(
    conn: &Connection,
    course: &CoursePath,
    settings: &CourseSettings,
) -> Result<(), CatalogError> {
    conn.execute(
        "INSERT INTO courses (path, abbr, code, color, sort_order, archived)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (path) DO UPDATE
         SET abbr = excluded.abbr, code = excluded.code, color = excluded.color,
             sort_order = excluded.sort_order,
             archived = excluded.archived",
        params![
            course,
            settings.abbr,
            settings.code.as_ref().map(CourseCode::as_str),
            settings.color,
            settings.order,
            settings.archived
        ],
    )?;
    Ok(())
}

pub fn remove_course(conn: &Connection, course: &CoursePath) -> Result<(), CatalogError> {
    conn.execute("DELETE FROM courses WHERE path = ?1", [course])?;
    Ok(())
}

/// The courses of `semester`, in the user's order.
pub fn courses(
    conn: &Connection,
    semester: &SemesterPath,
) -> Result<Vec<(CoursePath, CourseSettings)>, CatalogError> {
    let courses = conn
        .prepare_cached(&format!(
            "SELECT path, abbr, code, color, sort_order, archived FROM courses
             WHERE {BELOW} ORDER BY sort_order, path"
        ))?
        .query_map([semester], course_row)?
        .collect::<Result<_, _>>()?;
    Ok(courses)
}

/// Every course with settings, by path.
pub fn all_courses(conn: &Connection) -> Result<Vec<(CoursePath, CourseSettings)>, CatalogError> {
    let courses = conn
        .prepare_cached(
            "SELECT path, abbr, code, color, sort_order, archived FROM courses ORDER BY path",
        )?
        .query_map([], course_row)?
        .collect::<Result<_, _>>()?;
    Ok(courses)
}

/// The files inside `course`, at any depth.
pub fn course_files(conn: &Connection, course: &CoursePath) -> Result<u32, CatalogError> {
    let files = conn
        .prepare_cached(&format!(
            "SELECT count(*) FROM entries WHERE kind = 'file' AND {BELOW}"
        ))?
        .query_row([course], |row| row.get(0))?;
    Ok(files)
}

fn course_row(row: &Row<'_>) -> rusqlite::Result<(CoursePath, CourseSettings)> {
    let settings = CourseSettings {
        abbr: row.get(1)?,
        code: row
            .get::<_, Option<String>>(2)?
            .map(|code| CourseCode::parse(&code))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
        color: row.get(3)?,
        order: row.get(4)?,
        archived: row.get(5)?,
    };
    Ok((row.get(0)?, settings))
}
