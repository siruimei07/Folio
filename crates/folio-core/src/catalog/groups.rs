//! Semester and course settings, mirrored from `.folio/meta/` for sorting and filtering
//! (docs/specs/library-core.md §5.2).

use rusqlite::{Connection, params};

use super::{BELOW, CatalogError};
use crate::meta::{CourseSettings, GroupSettings};
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

/// Removes a semester and the settings of its courses.
pub fn remove_semester(conn: &Connection, semester: &SemesterPath) -> Result<(), CatalogError> {
    conn.execute("DELETE FROM semesters WHERE path = ?1", [semester])?;
    conn.execute(&format!("DELETE FROM courses WHERE {BELOW}"), [semester])?;
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
        "INSERT INTO courses (path, abbr, color, sort_order, archived) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (path) DO UPDATE
         SET abbr = excluded.abbr, color = excluded.color, sort_order = excluded.sort_order,
             archived = excluded.archived",
        params![
            course,
            settings.abbr,
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
            "SELECT path, abbr, color, sort_order, archived FROM courses
             WHERE {BELOW} ORDER BY sort_order, path"
        ))?
        .query_map([semester], |row| {
            let settings = CourseSettings {
                abbr: row.get(1)?,
                color: row.get(2)?,
                order: row.get(3)?,
                archived: row.get(4)?,
            };
            Ok((row.get(0)?, settings))
        })?
        .collect::<Result<_, _>>()?;
    Ok(courses)
}
