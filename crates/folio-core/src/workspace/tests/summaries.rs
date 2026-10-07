//! Selection summaries (versioning.md §6.6, ipc-m2.md §6.4).

use super::metadata::{World, definitions, rules_after, rules_before, rules_scene};
use super::*;
use crate::meta::CourseCode;

/// A group in one line: its place, its included files and folders by change (added, modified,
/// deleted, moved), its tags and settings, and its counts.
fn describe_group(group: &SummaryGroup) -> String {
    let place = match &group.place {
        Place::Library => "library".to_owned(),
        Place::Semester { path, folder } => format!("semester {path}{}", folder_of(*folder)),
        Place::Course { path, folder, code } => format!(
            "course {path}{} code {}",
            folder_of(*folder),
            code.as_ref().map_or("-", CourseCode::as_str)
        ),
    };
    let counts = |counts: &ChangeCounts| {
        format!(
            "{}/{}/{}/{}",
            counts.added, counts.modified, counts.deleted, counts.moved
        )
    };
    format!(
        "{place}: files {} folders {} tags {}{} items {} required {} available {} selected {}",
        counts(&group.files),
        counts(&group.folders),
        group.tags,
        if group.settings { " settings" } else { "" },
        group.items,
        group.required,
        group.available,
        group.selected,
    )
}

fn folder_of(folder: Option<EntryId>) -> String {
    match folder {
        Some(entry) => format!(" (folder {})", entry.0),
        None => " (gone)".to_owned(),
    }
}

/// The summary of `selection`, checked against the invariants of ipc-m2.md §6.4: in every group
/// `files` and `folders` add up to `selected`, and `required <= selected <= available <= items`;
/// the groups' `items` add up to the workspace's and their `selected` to the summary's.
fn summary(workspace: &Workspace, selection: Selection) -> SelectionSummary {
    let fingerprint = workspace.fingerprint().to_string();
    let chosen = workspace.resolve(&selection, &fingerprint).unwrap();
    let summary = workspace.summarize(&chosen);
    let sum =
        |counts: &ChangeCounts| counts.added + counts.modified + counts.deleted + counts.moved;
    for group in &summary.groups {
        assert_eq!(
            sum(&group.files) + sum(&group.folders),
            group.selected,
            "{group:?}"
        );
        assert!(group.required <= group.selected, "{group:?}");
        assert!(group.selected <= group.available, "{group:?}");
        assert!(group.available <= group.items, "{group:?}");
    }
    let items: u32 = summary.groups.iter().map(|group| group.items).sum();
    assert_eq!(items, workspace.totals().items);
    let selected: u32 = summary.groups.iter().map(|group| group.selected).sum();
    assert_eq!(selected, summary.items);
    assert_eq!(summary.metadata, workspace.totals().metadata);
    summary
}

fn groups(summary: &SelectionSummary) -> Vec<String> {
    summary.groups.iter().map(describe_group).collect()
}

/// The fake shell's small workspace with its metadata changes: a tag change of an entry without
/// an item, a course's settings, tag definitions and ignore rules.
#[test]
fn the_fake_shells_small_summary() {
    use small::{CSC, ECO, LINEAR, MAT, PHY, at};
    let midterm = at(MAT, "Exams/Midterm/Midterm 2025.pdf");
    let mut world = World::new(
        small::scene()
            .kept(19, &midterm, "midterm", &midterm, "midterm")
            .kept_folder(20, CSC, CSC),
    )
    .head_tags(&midterm, ["important"])
    .disk_tags(19, ["important", "to-review"])
    .head_course(CSC, "CSC 148")
    .disk_course(CSC, "CSC148")
    .head_definitions(definitions(&["important"]))
    .head_ignore("# My rules\n*.log\n");
    world.disk.definitions = OnDisk::Read(definitions(&["important", "to-review"]));
    world.disk.ignore = OnDisk::Read(Some("# My rules\n*.log\n*.tmp\nbuild/\n".to_owned()));
    let workspace = world.workspace();
    let keys: Vec<&str> = workspace
        .metadata()
        .iter()
        .map(MetadataChange::key)
        .collect();
    assert_eq!(
        keys,
        [
            format!("t:{midterm}"),
            format!("c:{CSC}"),
            "T:".into(),
            "I:".into()
        ]
    );
    assert_eq!(workspace.totals().metadata, 4);

    let all = summary(&workspace, Selection::AllExcept(Vec::new()));
    assert_eq!((all.items, all.metadata), (10, 4));
    assert_eq!(
        groups(&all),
        [
            format!(
                "course {CSC} (folder 20) code CSC148: files 3/1/0/0 folders 0/0/0/0 tags 0 \
                 settings items 4 required 0 available 4 selected 4"
            ),
            format!(
                "course {ECO} (gone) code -: files 0/1/0/0 folders 0/0/0/0 tags 0 items 2 \
                 required 0 available 1 selected 1"
            ),
            format!(
                "course {MAT} (gone) code -: files 0/1/1/1 folders 0/0/0/0 tags 1 items 3 \
                 required 0 available 3 selected 3"
            ),
            format!(
                "course {LINEAR} (gone) code -: files 0/0/0/0 folders 0/0/0/1 tags 0 items 1 \
                 required 0 available 1 selected 1"
            ),
            "course Personal/Photos (gone) code -: files 0/0/0/0 folders 0/0/0/0 tags 0 items 1 \
             required 0 available 0 selected 0"
                .to_owned(),
            format!(
                "course {PHY} (gone) code -: files 0/0/0/1 folders 0/0/0/0 tags 0 items 1 \
                 required 0 available 1 selected 1"
            ),
        ]
    );
    assert!(all.tag_definitions && all.ignore_rules && !all.library);

    // Nothing chosen: the metadata changes and the places stay, nothing is selected.
    let none = summary(&workspace, Selection::Only(Vec::new()));
    assert_eq!((none.items, none.metadata), (0, 4));
    assert_eq!(none.groups.len(), 6);
    assert!(none.groups.iter().all(|group| group.selected == 0
        && group.files == ChangeCounts::default()
        && group.folders == ChangeCounts::default()));
    assert_eq!(none.groups[0].available, 4);
}

#[test]
fn places_are_courses_semesters_and_the_library_root() {
    let world = World::new(
        Scene::default()
            .added(1, "todo.md", "t")
            .kept_folder(2, "2026", "2026")
            .added(3, "2026/syllabus.pdf", "s")
            .kept_folder(4, "2026/MAT", "2026/MAT")
            .kept(5, "2026/MAT/a.md", "a", "2026/MAT/a.md", "b")
            .gone_folder("2026/PHY")
            .gone("2026/PHY/old.md", "o")
            .added_folder(6, "2026/NEW")
            .added_folder(7, "2027"),
    )
    .head_course("2026/MAT", "MAT")
    .head_course("2026/PHY", "PHY131")
    .disk_course("2026/MAT", "MAT232");
    let workspace = world.workspace();
    let chosen = summary(&workspace, Selection::AllExcept(Vec::new()));
    // A deleted course keeps its committed name and code; a course's code is the disk's.
    assert_eq!(
        groups(&chosen),
        [
            "library: files 1/0/0/0 folders 0/0/0/0 tags 0 items 1 required 0 available 1 \
             selected 1",
            "semester 2026 (folder 2): files 1/0/0/0 folders 0/0/0/0 tags 0 items 1 required 0 \
             available 1 selected 1",
            "course 2026/MAT (folder 4) code MAT232: files 0/1/0/0 folders 0/0/0/0 tags 0 \
             settings items 1 required 0 available 1 selected 1",
            "course 2026/NEW (folder 6) code -: files 0/0/0/0 folders 1/0/0/0 tags 0 items 1 \
             required 0 available 1 selected 1",
            "course 2026/PHY (gone) code PHY131: files 0/0/0/0 folders 0/0/1/0 tags 0 settings \
             items 1 required 0 available 1 selected 1",
            "semester 2027 (folder 7): files 0/0/0/0 folders 1/0/0/0 tags 0 items 1 required 0 \
             available 1 selected 1",
        ]
    );
    let names: Vec<Option<&str>> = chosen
        .groups
        .iter()
        .map(|group| group.place.name())
        .collect();
    assert_eq!(
        names,
        [
            None,
            Some("2026"),
            Some("MAT"),
            Some("NEW"),
            Some("PHY"),
            Some("2027")
        ]
    );

    // Without `HEAD`'s metadata the places have no folder and no code.
    let items_only = Workspace::new(world.scene.comparison(), &VersioningRules::default());
    let chosen = summary(&items_only, Selection::AllExcept(Vec::new()));
    assert_eq!(chosen.metadata, 0);
    assert_eq!(chosen.groups.len(), 6);
    assert!(chosen.groups.iter().all(|group| match &group.place {
        Place::Library => true,
        Place::Semester { folder, .. } => folder.is_none(),
        Place::Course { folder, code, .. } => folder.is_none() && code.is_none(),
    }));
}

#[test]
fn tag_changes_count_once_per_item_and_row() {
    let workspace = World::new(
        Scene::default()
            .kept(1, "2026/MAT/a.md", "a", "2026/MAT/a.md", "a2")
            .kept(2, "2026/MAT/b.md", "b", "2026/MAT/b.md", "b")
            .kept(3, "c.md", "c", "c.md", "c")
            .kept(4, "2026/MAT/x.md", "x", "2026/MAT/y.md", "x")
            .kept(5, "2026/MAT/y.md", "y", "2026/MAT/x.md", "y"),
    )
    .disk_tags(1, ["notes"])
    .disk_tags(2, ["notes"])
    .disk_tags(3, ["notes"])
    .disk_tags(4, ["notes"])
    .disk_tags(5, ["exam"])
    .workspace();
    // The swap is one item with both entries' tag changes.
    let swap = &workspace.items()[1];
    assert_eq!(swap.parts().len(), 1);
    assert_eq!(swap.tag_changes().len(), 2);
    let chosen = summary(&workspace, Selection::Only(Vec::new()));
    // A row's tag change counts always; an item's, left out, when its entry stays with its new
    // tags: modified at its path, moved at its old path.
    assert_eq!(
        groups(&chosen),
        [
            "library: files 0/0/0/0 folders 0/0/0/0 tags 1 items 0 required 0 available 0 \
             selected 0",
            "course 2026/MAT (gone) code -: files 0/0/0/0 folders 0/0/0/0 tags 3 items 2 \
             required 0 available 2 selected 0",
        ]
    );
    assert_eq!((chosen.items, chosen.metadata), (0, 2));
}

/// A file replaced by a folder of 20,000 tagged files is one item with as many parts and tag
/// changes; left out, its summary looks at each once. Looking up every tag change's entry among
/// every part took 2.9 s at 40,000 in a release build.
#[test]
fn a_left_out_item_with_thousands_of_tagged_parts_is_summarized_in_time() {
    const FILES: i64 = 20_000;
    let mut scene = Scene::default()
        .gone("2026/MAT/hw", "a file")
        .added_folder(1, "2026/MAT/hw");
    for id in 2..FILES + 2 {
        scene = scene.added(id, &format!("2026/MAT/hw/{id:05}.md"), "x");
    }
    let mut world = World::new(scene);
    for id in 2..FILES + 2 {
        world = world.disk_tags(id, ["notes"]);
    }
    let workspace = world.workspace();
    assert_eq!(workspace.items().len(), 1);
    assert_eq!(workspace.items()[0].tag_changes().len(), FILES as usize);
    let fingerprint = workspace.fingerprint().to_string();
    let chosen = workspace
        .resolve(&Selection::Only(Vec::new()), &fingerprint)
        .unwrap();
    let started = std::time::Instant::now();
    let left_out = workspace.summarize(&chosen);
    let took = started.elapsed();
    assert_eq!(left_out.groups[0].tags, 0);
    assert!(
        took < std::time::Duration::from_secs(1),
        "summarized in {took:?}"
    );
}

#[test]
fn an_added_items_tag_change_counts_only_when_it_is_included() {
    let scene = Scene::default().added(1, "2026/MAT/new.md", "n").kept(
        2,
        "2026/MAT/old.md",
        "o",
        "2026/MAT/moved.md",
        "o",
    );
    let workspace = World::new(scene)
        .disk_tags(1, ["notes"])
        .disk_tags(2, ["notes"])
        .workspace();
    assert!(workspace.items().iter().all(Item::tags_changed));
    // Left out, the added file keeps its tags for the commit that adds it (versioning.md §6.4),
    // while the moved one keeps its new tags at its old path.
    let left_out = summary(&workspace, Selection::Only(Vec::new()));
    assert_eq!(
        groups(&left_out),
        [
            "course 2026/MAT (gone) code -: files 0/0/0/0 folders 0/0/0/0 tags 1 items 2 required 0 \
          available 2 selected 0"
        ]
    );
    let everything = summary(&workspace, Selection::AllExcept(Vec::new()));
    assert_eq!(
        groups(&everything),
        [
            "course 2026/MAT (gone) code -: files 1/0/0/1 folders 0/0/0/0 tags 2 items 2 required 0 \
          available 2 selected 2"
        ]
    );
}

#[test]
fn required_items_are_available_and_selected_whatever_their_readiness() {
    // `big.txt` is not on this disk; its other size makes it a modification all the same.
    // `big.txt` (required) and `huge.txt` (not) are not on this disk; their other sizes make
    // them modifications all the same.
    let scene = rules_scene()
        .unhashed(1, Some(Blocked::NotLocal))
        .sized(1, 600)
        .unhashed(6, Some(Blocked::NotLocal))
        .sized(6, 3000);
    let workspace = World::new(scene)
        .rules(rules_before(), rules_after())
        .workspace();
    let only = summary(&workspace, Selection::Only(Vec::new()));
    assert_eq!(
        groups(&only),
        [
            "library: files 0/2/1/1 folders 0/0/0/0 tags 0 items 7 required 4 available 6 \
             selected 4",
            "semester D (gone): files 0/0/0/0 folders 0/0/1/0 tags 0 items 1 required 1 \
             available 1 selected 1",
            "semester G (folder 7): files 0/1/0/0 folders 0/0/0/0 tags 0 items 2 required 1 \
             available 2 selected 1",
        ]
    );
    assert_eq!((only.items, only.metadata), (6, 1));
    assert!(only.library && !only.tag_definitions && !only.ignore_rules);

    // `allExcept` takes every includable item and every required one, blocked or not; the
    // blocked `huge.txt` is neither available nor selected.
    let all = summary(&workspace, Selection::AllExcept(Vec::new()));
    assert_eq!(all.items, 9);
    assert_eq!(
        groups(&all)[0],
        "library: files 0/3/1/2 folders 0/0/0/0 tags 0 items 7 required 4 available 6 selected 6"
    );
}
