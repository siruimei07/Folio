//! Bound items (versioning.md §6.3), selections (ipc-m2.md §5.1) and the selection's tree
//! (versioning.md §7.2): the spec's examples.

use super::*;
use crate::library::operations::MAX_BATCH;
use crate::paths::PathError;

/// Where each path of an applied tree comes from, in one line each: `path <- head:<HEAD path>`,
/// `path <- disk:<entry>` or `path <- created`.
fn tree(applied: &Applied) -> Vec<String> {
    applied
        .nodes()
        .iter()
        .map(|(path, source)| match source {
            Source::Head(row) if row.path == *path => format!("{path}"),
            Source::Head(row) => format!("{path} <- head:{}", row.path),
            Source::Disk(entry) => format!("{path} <- disk:{}", entry.entry.0),
            Source::Created => format!("{path} <- created"),
        })
        .collect()
}

/// The items whose main change's key starts with one of `starts`, chosen.
fn choose(workspace: &Workspace, starts: &[&str]) -> Chosen {
    Chosen::from_picked(
        workspace
            .items()
            .iter()
            .map(|item| starts.iter().any(|start| item.key().starts_with(start)))
            .collect(),
    )
}

fn everything(workspace: &Workspace) -> Chosen {
    Chosen::from_picked(vec![true; workspace.items().len()])
}

fn nothing(workspace: &Workspace) -> Chosen {
    Chosen::from_picked(vec![false; workspace.items().len()])
}

fn apply(scene: &Scene, workspace: &Workspace, chosen: &Chosen) -> Vec<String> {
    tree(&workspace.apply(head_rows(scene), chosen).unwrap())
}

/// The scene's disk, as an applied tree would list it when it equals the disk.
fn disk_paths(scene: &Scene) -> Vec<String> {
    let mut paths: Vec<String> = scene
        .disk
        .iter()
        .map(|entry| entry.path.to_string())
        .collect();
    paths.sort_unstable();
    paths
}

fn paths_of(applied: &Applied) -> Vec<String> {
    applied.nodes().keys().map(ToString::to_string).collect()
}

/// The workspace with every part made an item of its own: what binding prevents, to show that
/// the tree refuses it.
fn unbound(workspace: &Workspace) -> Workspace {
    let mut items = Vec::new();
    let mut moved = HashMap::new();
    for (index, item) in workspace.items.iter().enumerate() {
        for (part, change) in item.changes().enumerate() {
            moved.insert((index, part), items.len());
            items.push(Item {
                change: change.clone(),
                parts: Vec::new(),
                required: false,
                tags: Vec::new(),
            });
        }
    }
    let fates = workspace
        .fates
        .iter()
        .map(|(path, fate)| {
            let fate = fate.map(|at| ChangeAt {
                item: moved[&(at.item, at.part)],
                part: 0,
            });
            (path.clone(), fate)
        })
        .collect();
    let mut unbound = Workspace {
        items,
        fates,
        folders: workspace.folders.clone(),
        ..Workspace::default()
    };
    unbound.tally();
    unbound
}

// ---- rule 1: a place one change writes and another frees

#[test]
fn a_file_replaced_by_a_moved_file_is_one_row() {
    let scene = Scene::default()
        .kept(
            1,
            "PHY/notes/Kinematics.md",
            "v1",
            "PHY/Kinematics.md",
            "v2",
        )
        .gone("PHY/Kinematics.md", "old");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        [
            "move file PHY/Kinematics.md from PHY/notes/Kinematics.md edited \
             + delete file PHY/Kinematics.md"
        ]
    );
    let row = &workspace.items()[0];
    assert!(row.key().starts_with("fv"));
    assert_eq!(row.parts().len(), 1);
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        ["PHY", "PHY/Kinematics.md <- disk:1", "PHY/notes"]
    );
    assert_eq!(
        apply(&scene, &workspace, &nothing(&workspace)),
        [
            "PHY",
            "PHY/Kinematics.md",
            "PHY/notes",
            "PHY/notes/Kinematics.md"
        ]
    );
    // Split, the move alone would put two files at one path.
    let split = unbound(&workspace);
    let error = split
        .apply(head_rows(&scene), &choose(&split, &["fv"]))
        .unwrap_err();
    assert_eq!(error.path, "PHY/Kinematics.md");
    assert_eq!(error.problem, ApplyProblem::Taken);
}

#[test]
fn a_swap_of_two_names_is_one_row() {
    let scene = Scene::default()
        .kept(1, "a.md", "A", "b.md", "A")
        .kept(2, "b.md", "B", "a.md", "B")
        .kept(3, "c.md", "C", "d.md", "C");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        [
            "move file a.md from b.md + move file b.md from a.md",
            "move file d.md from c.md",
        ]
    );
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["fv"])),
        ["a.md <- disk:2", "b.md <- disk:1", "d.md <- disk:3"]
    );
    let swap_only = Chosen::from_picked(vec![true, false]);
    assert_eq!(
        tree(&workspace.apply(head_rows(&scene), &swap_only).unwrap()),
        ["a.md <- disk:2", "b.md <- disk:1", "c.md"]
    );
}

#[test]
fn a_file_replaced_by_a_folder_and_back_is_one_row() {
    // A file replaced by a folder: every addition into the new folder, and the deletion.
    let scene = Scene::default()
        .gone("x", "file")
        .added_folder(1, "x")
        .added(2, "x/a.md", "a")
        .added_folder(3, "x/sub")
        .added(4, "x/sub/b.md", "b")
        .added(5, "other.md", "o");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        [
            "add file other.md",
            "add file x/a.md + delete file x + add file x/sub/b.md",
        ]
    );
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["fa:x/"])),
        [
            "x <- created",
            "x/a.md <- disk:2",
            "x/sub <- created",
            "x/sub/b.md <- disk:4"
        ]
    );
    let split = unbound(&workspace);
    let error = split
        .apply(head_rows(&scene), &choose(&split, &["fa:x/a.md"]))
        .unwrap_err();
    assert_eq!(error.problem, ApplyProblem::BelowFile);

    // An empty folder in its place.
    let workspace = Scene::default()
        .gone("x", "file")
        .added_folder(1, "x")
        .workspace();
    assert_eq!(described(&workspace), ["add folder x + delete file x"]);

    // A folder replaced by a file: the folder's deletion and the addition.
    let scene = Scene::default()
        .gone_folder("y")
        .gone("y/a.md", "a")
        .added(1, "y", "file");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        ["add file y + delete folder y files 1"]
    );
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        ["y <- disk:1"]
    );
}

#[test]
fn an_added_old_name_beside_a_rename_inside_a_moved_folder_is_bound_to_it() {
    let scene = Scene::default()
        .kept_folder(1, "F", "G")
        .kept(2, "F/a.md", "a", "G/b.md", "a")
        .added(3, "G/a.md", "new")
        .kept(4, "F/c.md", "c", "G/c.md", "c, edited");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        [
            "move folder G from F",
            "add file G/a.md + move file G/b.md from F/a.md",
            "modify file G/c.md",
        ]
    );
    // The folder move alone: the held-back rename stays at its committed name in the moved
    // folder, and the held-back edit moves with it.
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["dv"])),
        [
            "G <- disk:1",
            "G/a.md <- head:F/a.md",
            "G/c.md <- head:F/c.md"
        ]
    );
    // The rename and the addition alone: in the folder's committed place (lane decision 7).
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["fa:"])),
        ["F", "F/a.md <- disk:3", "F/b.md <- disk:2", "F/c.md"]
    );
    // The edit alone, too.
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["fm:"])),
        ["F", "F/a.md", "F/c.md <- disk:4"]
    );
    assert_eq!(
        paths_of(
            &workspace
                .apply(head_rows(&scene), &everything(&workspace))
                .unwrap()
        ),
        disk_paths(&scene)
    );
    // Split, the addition alone would meet the file the held-back rename keeps.
    let split = unbound(&workspace);
    let error = split
        .apply(head_rows(&scene), &choose(&split, &["dv", "fa:"]))
        .unwrap_err();
    assert_eq!(error.path, "G/a.md");
    assert_eq!(error.problem, ApplyProblem::Taken);
}

#[test]
fn a_case_only_rename_without_file_ids_is_one_row() {
    let workspace = Scene::default()
        .gone("Notes.md", "n")
        .added(1, "notes.md", "n")
        .workspace();
    assert_eq!(
        described(&workspace),
        ["add file notes.md + delete file Notes.md"]
    );
    // With file ids it is a move.
    let workspace = Scene::default()
        .kept(1, "Notes.md", "n", "notes.md", "n")
        .workspace();
    assert_eq!(described(&workspace), ["move file notes.md from Notes.md"]);
    // A folder, and names compared as NTFS does (simple uppercase mapping, not only ASCII).
    let workspace = Scene::default()
        .gone_folder("Week1")
        .gone("Week1/a.md", "a")
        .added_folder(1, "week1")
        .added(2, "week1/a.md", "a")
        .gone("Ärger.md", "ä")
        .added(3, "ärger.md", "ä")
        .workspace();
    assert_eq!(
        described(&workspace),
        [
            "add file week1/a.md + delete folder Week1 files 1",
            "add file ärger.md + delete file Ärger.md",
        ]
    );
}

#[test]
fn a_folder_moved_onto_a_deleted_folders_place_is_bound_to_the_deletion() {
    let scene = Scene::default()
        .gone_folder("D")
        .kept(1, "D/x.md", "x", "D/x.md", "x")
        .gone("D/y.md", "y")
        .kept_folder(2, "H", "D")
        .kept(3, "H/z.md", "z", "D/z.md", "z");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        ["move folder D from H files 1 + delete folder D files 1"]
    );
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        ["D <- disk:2", "D/x.md", "D/z.md <- head:H/z.md"]
    );
}

#[test]
fn an_addition_where_a_file_stayed_below_a_folder_that_moved_is_bound_to_the_move() {
    // F moved to G; a new F holds F/home.md, which moved back: in place. A new G/home.md would
    // meet it in F's committed place if the move were held back.
    let scene = Scene::default()
        .kept_folder(1, "F", "G")
        .added_folder(2, "F")
        .kept(3, "F/home.md", "h", "F/home.md", "h")
        .added(4, "G/home.md", "new");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        ["move folder G from F + add file G/home.md"]
    );
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        [
            "F <- created",
            "F/home.md",
            "G <- disk:1",
            "G/home.md <- disk:4"
        ]
    );
    // Without the addition, the move alone leaves the file where it is.
    let scene = Scene::default()
        .kept_folder(1, "F", "G")
        .added_folder(2, "F")
        .kept(3, "F/home.md", "h", "F/home.md", "h");
    let workspace = scene.workspace();
    assert_eq!(described(&workspace), ["move folder G from F"]);
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        ["F <- created", "F/home.md", "G <- disk:1"]
    );
}

#[test]
fn a_file_that_stayed_below_a_folder_that_moved_keeps_its_edit_apart_from_the_move() {
    // As above, with F/home.md edited: the move and the edit are two items. The move alone keeps
    // HEAD's content in the new F; the edit alone writes it in the folder's committed place.
    let scene = Scene::default()
        .kept_folder(1, "F", "G")
        .added_folder(2, "F")
        .kept(3, "F/home.md", "h", "F/home.md", "h, edited");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        ["modify file F/home.md", "move folder G from F"]
    );
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["dv"])),
        ["F <- created", "F/home.md", "G <- disk:1"]
    );
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["fm"])),
        ["F", "F/home.md <- disk:3"]
    );
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        ["F <- created", "F/home.md <- disk:3", "G <- disk:1"]
    );
}

#[test]
fn a_folder_in_place_below_a_deleted_folder_moves_with_the_deletion() {
    // b/a moved into a new b/a (as b/a/a); HEAD's b/a/a was deleted, and its child b/a/a/a is
    // in place, now directly in HEAD's b/a. It stays in its frame until the deletion of its
    // folder is chosen (found by the property test).
    let scene = Scene::default()
        .kept_folder(3, "b/a", "b/a/a")
        .added_folder(9, "b/a")
        .gone_folder("b/a/a")
        .kept_folder(8, "b/a/a/a", "b/a/a/a")
        .kept(6, "b/a/b", "x", "b/a/a/b", "x");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        ["delete folder b/a/a", "move folder b/a/a from b/a files 1"]
    );
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["dv"])),
        [
            "b",
            "b/a <- created",
            "b/a/a <- disk:3",
            "b/a/a/a <- head:b/a/a",
            "b/a/a/a/a <- head:b/a/a/a",
            "b/a/a/b <- head:b/a/b",
        ]
    );
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["dd"])),
        ["b", "b/a", "b/a/a <- head:b/a/a/a", "b/a/b"]
    );
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        [
            "b",
            "b/a <- created",
            "b/a/a <- disk:3",
            "b/a/a/a",
            "b/a/a/b <- head:b/a/b"
        ]
    );
}

// ---- rule 2: a folder deletion and what left it

#[test]
fn a_file_moved_out_of_a_deleted_folder_is_bound_to_its_deletion() {
    // remote-format.md §12: hw2.pdf moved out of 作业 before 作业 went.
    const LINEAR: &str = "2026 秋/线性代数";
    let scene = Scene::default()
        .gone_folder(&format!("{LINEAR}/作业"))
        .gone(&format!("{LINEAR}/作业/hw1.pdf"), "hw1")
        .kept(
            1,
            &format!("{LINEAR}/作业/hw2.pdf"),
            "hw2",
            &format!("{LINEAR}/hw2.pdf"),
            "hw2",
        )
        .kept(
            2,
            &format!("{LINEAR}/notes.md"),
            "n",
            &format!("{LINEAR}/notes.md"),
            "n2",
        );
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        [
            format!(
                "move file {LINEAR}/hw2.pdf from {LINEAR}/作业/hw2.pdf \
                 + delete folder {LINEAR}/作业 files 1"
            ),
            format!("modify file {LINEAR}/notes.md"),
        ]
    );
    assert_eq!(
        apply(&scene, &workspace, &choose(&workspace, &["fv"])),
        [
            "2026 秋".to_owned(),
            LINEAR.to_owned(),
            format!("{LINEAR}/hw2.pdf <- disk:1"),
            format!("{LINEAR}/notes.md"),
        ]
    );
}

// ---- rule 3: folders that would hold each other

#[test]
fn a_folder_moved_into_its_own_child_is_bound_to_the_childs_move() {
    // Y moved into its child Z, which moved to the root first.
    let scene = Scene::default()
        .kept_folder(1, "Y", "Z/Y")
        .kept_folder(2, "Y/Z", "Z")
        .kept(3, "Y/a.md", "a", "Z/Y/a.md", "a");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        ["move folder Z from Y/Z + move folder Z/Y from Y files 1"]
    );
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        ["Z <- disk:2", "Z/Y <- disk:1", "Z/Y/a.md <- head:Y/a.md"]
    );
    // Split, the move into the child alone would make the folders hold each other.
    let split = unbound(&workspace);
    let only_outer = Chosen::from_picked(
        split
            .items()
            .iter()
            .map(|item| item.change().path().as_str() == "Z/Y")
            .collect(),
    );
    let error = split.apply(head_rows(&scene), &only_outer).unwrap_err();
    assert_eq!(error.problem, ApplyProblem::Unplaced);
}

#[test]
fn folders_swapped_into_each_others_children_are_bound_in_pairs() {
    // A moved into B's child b, which moved to the root as b2; B into A's child a, as a2.
    let scene = Scene::default()
        .kept_folder(1, "A", "b2/A")
        .kept_folder(2, "A/a", "a2")
        .kept_folder(3, "B", "a2/B")
        .kept_folder(4, "B/b", "b2");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        [
            "move folder a2 from A/a + move folder a2/B from B",
            "move folder b2 from B/b + move folder b2/A from A",
        ]
    );
    assert_eq!(
        apply(&scene, &workspace, &everything(&workspace)),
        [
            "a2 <- disk:2",
            "a2/B <- disk:3",
            "b2 <- disk:4",
            "b2/A <- disk:1"
        ]
    );
    // Either pair alone builds a tree.
    let first = Chosen::from_picked(vec![true, false]);
    assert_eq!(
        tree(&workspace.apply(head_rows(&scene), &first).unwrap()),
        ["A", "a2 <- disk:2", "a2/B <- disk:3", "a2/B/b <- head:B/b"]
    );
    // A move and the other pair's deciding move hold each other: refused when split.
    let split = unbound(&workspace);
    let outer_moves = Chosen::from_picked(
        split
            .items()
            .iter()
            .map(|item| matches!(item.change().path().as_str(), "a2/B" | "b2/A"))
            .collect(),
    );
    let error = split.apply(head_rows(&scene), &outer_moves).unwrap_err();
    assert_eq!(error.problem, ApplyProblem::Unplaced);
}

#[test]
fn a_folder_moved_into_a_renamed_folder_is_not_bound() {
    // No cycle can form: the move alone goes into the folder's committed place.
    let scene = Scene::default()
        .kept_folder(1, "Notes", "Notes 2026")
        .kept_folder(2, "Week1", "Notes 2026/Week1");
    let workspace = scene.workspace();
    assert_eq!(
        described(&workspace),
        [
            "move folder Notes 2026 from Notes",
            "move folder Notes 2026/Week1 from Week1",
        ]
    );
    let week = Chosen::from_picked(vec![false, true]);
    assert_eq!(
        tree(&workspace.apply(head_rows(&scene), &week).unwrap()),
        ["Notes", "Notes/Week1 <- disk:2"]
    );
}

/// `name`, `name/name`, and so on: a chain of `depth` nested folders.
fn chain(name: &str, depth: usize) -> Vec<String> {
    let mut paths = Vec::with_capacity(depth);
    let mut at = name.to_owned();
    for _ in 0..depth {
        paths.push(at.clone());
        at.push('/');
        at.push_str(name);
    }
    paths
}

/// Rule 3 over thousands of folder moves whose ways up pass the same folders: every folder of a
/// deep chain renamed (a move at each level), and folders moved into the deepest of a deep chain
/// of new folders. Each folder on the way is met once for all the moves, so the work follows the
/// bytes of the folders' paths; walked again for each move it followed the moves times the depth
/// times the path's length (6.9 s for the renamed chain at a depth of 4,000 in a release build,
/// 3.6 s for 1,000 moves below 4,000 new folders), and the library's close waited for it. The
/// steps of the ways up are counted (`bind::WALKED`), not timed: a few for each move and each
/// folder, where walking again would take the depth's square over two (4.5 million) and the
/// moves times the depth (3 million).
#[test]
fn rule_3_meets_each_folder_once_however_many_moves_pass_it() {
    use crate::workspace::bind::WALKED;
    const DEPTH: usize = 3_000;
    let mut renamed = Comparison::default();
    for (n, (from, to)) in chain("d", DEPTH).iter().zip(chain("e", DEPTH)).enumerate() {
        let mut entry = disk_folder(n as i64 + 1, &to);
        entry.empty = n + 1 == DEPTH;
        renamed.paired.push((head_folder(from), entry));
    }
    WALKED.set(0);
    let workspace = Workspace::new(renamed, &VersioningRules::default());
    assert_eq!(workspace.items().len(), DEPTH);
    assert!(workspace.items().iter().all(|item| item.parts().is_empty()));
    // Each move's destination is a step, and its folder in `HEAD` is met once, a step after the
    // folder above it: three steps a move (8,996 as built).
    let walked = WALKED.get();
    assert!(
        (DEPTH..=4 * DEPTH).contains(&walked),
        "the renamed chain took {walked} steps"
    );

    const MOVES: usize = 1_000;
    let mut into_new = Comparison::default();
    let new = chain("n", DEPTH);
    for (n, at) in new.iter().enumerate() {
        into_new.added.push(disk_folder(n as i64 + 1, at));
    }
    let bottom = new.last().unwrap();
    for n in 0..MOVES {
        let mut entry = disk_folder((DEPTH + n + 1) as i64, &format!("{bottom}/h{n}"));
        entry.empty = true;
        into_new.paired.push((head_folder(&format!("h{n}")), entry));
    }
    WALKED.set(0);
    let workspace = Workspace::new(into_new, &VersioningRules::default());
    assert_eq!(workspace.items().len(), MOVES);
    // The first move walks the new folders up to the root, the others stop at the deepest.
    let walked = WALKED.get();
    assert!(
        (DEPTH..=DEPTH + MOVES).contains(&walked),
        "the moves into the new chain took {walked} steps"
    );
}

// ---- main change, parts and readiness

#[test]
fn a_rows_main_change_is_its_first_writer_and_its_readiness_the_worst() {
    let workspace = Scene::default()
        .gone("b.md", "old b")
        .kept(1, "a.md", "a", "b.md", "a")
        .added(2, "a.md", "new a")
        .unhashed(2, Some(Blocked::NotLocal))
        .workspace();
    // Parts by path, then key.
    assert_eq!(workspace.items().len(), 1);
    let row = &workspace.items()[0];
    assert_eq!(
        describe_item(row),
        "add file a.md notLocal + delete file b.md + move file b.md from a.md"
    );
    assert_eq!(row.readiness(), Readiness::NotLocal);
    assert!(!row.is_includable());
    assert_eq!(
        workspace.totals(),
        Totals {
            items: 1,
            metadata: 0,
            includable: 0,
            hashing: 0,
            not_local: 1,
            unreadable: 0,
        }
    );
    // The first writer, though a deletion sorts before it; rules 1 and 2 together. (Every group
    // of two or more holds a writer: a place binds only when something writes it.)
    let workspace = Scene::default()
        .gone_folder("D")
        .kept(1, "D/z.md", "z", "z.md", "z")
        .gone("z.md", "old")
        .workspace();
    assert_eq!(
        described(&workspace),
        ["move file z.md from D/z.md + delete folder D + delete file z.md"]
    );

    // The fingerprint counts every part with the row's includability.
    let bound = Scene::default()
        .gone("x", "file")
        .added_folder(2, "x")
        .added(1, "x/a.md", "a")
        .unhashed(1, Some(Blocked::NotLocal))
        .workspace();
    assert_eq!(bound.items().len(), 1);
    let mut expected = Fingerprint::default();
    expected.add_change("fa:x/a.md", false);
    expected.add_change("fd:x", false);
    assert_eq!(bound.fingerprint(), expected);
}

// ---- selections (ipc-m2.md §5.1)

/// Four items: ready, not local, hashing, unreadable.
fn four() -> Workspace {
    Scene::default()
        .added(1, "a.md", "a")
        .added(2, "b.md", "b")
        .unhashed(2, Some(Blocked::NotLocal))
        .added(3, "c.md", "c")
        .unhashed(3, None)
        .added(4, "d.md", "d")
        .unhashed(4, Some(Blocked::Unreadable))
        .workspace()
}

fn keys(list: &[&str]) -> Vec<String> {
    list.iter().map(|&key| key.to_owned()).collect()
}

fn picked(workspace: &Workspace, chosen: &Chosen) -> Vec<String> {
    workspace
        .chosen_items(chosen)
        .map(|item| item.key().to_owned())
        .collect()
}

#[test]
fn a_selection_is_checked_for_limits_then_the_fingerprint_then_its_keys() {
    let workspace = four();
    let current = workspace.fingerprint().to_string();
    let stale = "f".repeat(32);

    let too_many = Selection::AllExcept(vec!["fa:a.md".to_owned(); MAX_BATCH + 1]);
    assert!(matches!(
        workspace.resolve(&too_many, &stale),
        Err(SelectionError::InvalidArgument(_))
    ));
    let at_limit = Selection::AllExcept(vec!["fa:a.md".to_owned(); MAX_BATCH]);
    assert!(workspace.resolve(&at_limit, &current).is_ok());

    // Characters, not bytes: 32,800 two-byte characters fit, one more does not.
    let longest = "é".repeat(MAX_KEY_CHARS);
    let too_long = format!("{longest}é");
    assert!(matches!(
        workspace.resolve(&Selection::Only(vec![too_long]), &stale),
        Err(SelectionError::InvalidArgument(_))
    ));
    assert_eq!(
        workspace.resolve(&Selection::Only(vec![longest.clone()]), &stale),
        Err(SelectionError::WorkspaceChanged)
    );

    // A fingerprint that is not the current one, whatever its text, before the keys.
    for text in [stale.as_str(), "", "not hex", &current.to_uppercase()] {
        if text == current {
            continue;
        }
        assert_eq!(
            workspace.resolve(&Selection::Only(keys(&["made up"])), text),
            Err(SelectionError::WorkspaceChanged)
        );
    }
    assert!(matches!(
        workspace.resolve(&Selection::Only(vec![longest]), &current),
        Err(SelectionError::InvalidArgument(_))
    ));
    assert!(matches!(
        workspace.resolve(
            &Selection::AllExcept(keys(&["fa:a.md", "fa:nope"])),
            &current
        ),
        Err(SelectionError::InvalidArgument(_))
    ));
}

#[test]
fn a_parts_key_names_no_item() {
    let workspace = Scene::default()
        .kept(
            1,
            "PHY/notes/Kinematics.md",
            "v1",
            "PHY/Kinematics.md",
            "v2",
        )
        .gone("PHY/Kinematics.md", "old")
        .workspace();
    let current = workspace.fingerprint().to_string();
    let part = workspace.items()[0].parts()[0].key().to_owned();
    assert!(matches!(
        workspace.resolve(&Selection::Only(vec![part]), &current),
        Err(SelectionError::InvalidArgument(_))
    ));
    let main = workspace.items()[0].key().to_owned();
    let chosen = workspace
        .resolve(&Selection::Only(vec![main]), &current)
        .unwrap();
    assert_eq!(chosen.indices().collect::<Vec<_>>(), [0]);
}

#[test]
fn all_except_takes_the_includable_items_not_listed_and_only_the_listed_ones() {
    let workspace = four();
    let current = workspace.fingerprint().to_string();
    let resolve = |selection: Selection| {
        picked(
            &workspace,
            &workspace.resolve(&selection, &current).unwrap(),
        )
    };
    assert_eq!(
        resolve(Selection::AllExcept(vec![])),
        ["fa:a.md", "fa:c.md"]
    );
    assert_eq!(
        resolve(Selection::AllExcept(keys(&["fa:a.md"]))),
        ["fa:c.md"]
    );
    // Listing a blocked item in allExcept changes nothing; duplicates count once.
    assert_eq!(
        resolve(Selection::AllExcept(keys(&[
            "fa:b.md", "fa:c.md", "fa:c.md"
        ]))),
        ["fa:a.md"]
    );
    assert_eq!(resolve(Selection::Only(vec![])), [] as [&str; 0]);
    // Only takes blocked items too: the commit then fails with their error.
    assert_eq!(
        resolve(Selection::Only(keys(&["fa:d.md", "fa:b.md", "fa:b.md"]))),
        ["fa:b.md", "fa:d.md"]
    );
}

#[test]
fn required_items_are_always_included() {
    let mut workspace = four();
    // Step 3 sets `required` (rule 3); here by hand, on the item that is not local.
    workspace.items[1].required = true;
    let current = workspace.fingerprint().to_string();
    let resolve = |selection: Selection| {
        picked(
            &workspace,
            &workspace.resolve(&selection, &current).unwrap(),
        )
    };
    assert!(workspace.items()[1].is_required());
    assert_eq!(
        resolve(Selection::AllExcept(vec![])),
        ["fa:a.md", "fa:b.md", "fa:c.md"]
    );
    assert_eq!(
        resolve(Selection::AllExcept(keys(&["fa:b.md", "fa:a.md"]))),
        ["fa:b.md", "fa:c.md"]
    );
    assert_eq!(resolve(Selection::Only(vec![])), ["fa:b.md"]);
}

#[test]
fn an_empty_workspace_resolves_with_its_fingerprint_of_zeros() {
    let workspace = Workspace::empty();
    let zeros = "0".repeat(32);
    let chosen = workspace
        .resolve(&Selection::AllExcept(vec![]), &zeros)
        .unwrap();
    assert_eq!(chosen.indices().count(), 0);
    assert_eq!(
        workspace.resolve(&Selection::AllExcept(vec![]), &"1".repeat(32)),
        Err(SelectionError::WorkspaceChanged)
    );
    assert!(matches!(
        workspace.resolve(&Selection::Only(keys(&["fa:a.md"])), &zeros),
        Err(SelectionError::InvalidArgument(_))
    ));
    assert_eq!(
        workspace.apply(Vec::new(), &chosen).unwrap(),
        Applied::default()
    );
}

// ---- the selection's tree (versioning.md §7.2)

#[test]
fn nothing_chosen_is_head_and_everything_is_the_disk() {
    let scene = Scene::default()
        .kept_folder(1, "F", "G")
        .kept(2, "F/a.md", "a", "G/a.md", "a 2")
        .kept_folder(3, "F/S", "G/T")
        .kept(4, "F/S/z.md", "z", "G/T/z.md", "z")
        .gone_folder("D")
        .gone("D/d.md", "d")
        .kept(5, "D/e.md", "e", "e.md", "e")
        .added_folder(6, "N")
        .added_folder(7, "N/O")
        .added(8, "N/O/n.md", "n")
        .added_folder(9, "Empty")
        .row(head_file(".folio/library.json", "{}"), None)
        .row(head_folder(".folio"), None);
    let workspace = scene.workspace();
    let head = workspace
        .apply(head_rows(&scene), &nothing(&workspace))
        .unwrap();
    let mut expected: Vec<RelPath> = head_rows(&scene).into_iter().map(|row| row.path).collect();
    expected.sort_unstable();
    assert_eq!(head.nodes().keys().cloned().collect::<Vec<_>>(), expected);
    assert!(
        head.nodes()
            .iter()
            .all(|(path, source)| matches!(source, Source::Head(row) if row.path == *path))
    );

    let disk = workspace
        .apply(head_rows(&scene), &everything(&workspace))
        .unwrap();
    assert_eq!(
        tree(&disk),
        [
            ".folio",
            ".folio/library.json",
            "Empty <- disk:9",
            "G <- disk:1",
            "G/T <- disk:3",
            "G/T/z.md <- head:F/S/z.md",
            "G/a.md <- disk:2",
            "N <- created",
            "N/O <- created",
            "N/O/n.md <- disk:8",
            "e.md <- disk:5",
        ]
    );
}

#[test]
fn a_held_back_folder_move_keeps_what_is_chosen_inside_it_at_its_committed_place() {
    let scene = Scene::default()
        .kept_folder(1, "F", "G")
        .kept(2, "F/a.md", "a", "G/a.md", "a 2")
        .added(3, "G/new.md", "n")
        .added_folder(4, "G/N")
        .added(5, "G/N/deep.md", "d")
        .kept(6, "F/b.md", "b", "G/c.md", "b");
    let workspace = scene.workspace();
    let not_the_move = Chosen::from_picked(
        workspace
            .items()
            .iter()
            .map(|item| !item.key().starts_with("dv"))
            .collect(),
    );
    assert_eq!(
        tree(&workspace.apply(head_rows(&scene), &not_the_move).unwrap()),
        [
            "F",
            "F/N <- created",
            "F/N/deep.md <- disk:5",
            "F/a.md <- disk:2",
            "F/c.md <- disk:6",
            "F/new.md <- disk:3",
        ]
    );
}

#[test]
fn a_path_a_frame_makes_too_long_is_refused() {
    // A file with a long name renamed short inside a folder renamed longer: the rename held
    // back keeps the long name in the longer folder. HEAD's path has 32,767 units.
    let name = "a".repeat(255);
    let deep = format!("{}/{}", vec![name.as_str(); 126].join("/"), "c".repeat(253));
    assert_eq!(
        format!("{deep}/F/{name}").encode_utf16().count(),
        MAX_PATH_UNITS
    );
    let long_folder = "b".repeat(10);
    let scene = Scene::default()
        .kept_folder(1, &format!("{deep}/F"), &format!("{deep}/{long_folder}"))
        .kept(
            2,
            &format!("{deep}/F/{name}"),
            "x",
            &format!("{deep}/{long_folder}/s"),
            "x",
        );
    let workspace = scene.workspace();
    assert_eq!(workspace.items().len(), 2);
    let error = workspace
        .apply(head_rows(&scene), &choose(&workspace, &["dv"]))
        .unwrap_err();
    assert_eq!(error.problem, ApplyProblem::Path(PathError::TooLong));
    assert!(error.path.ends_with(&format!("{long_folder}/{name}")));
    // Everything, or nothing, fits.
    assert!(
        workspace
            .apply(head_rows(&scene), &everything(&workspace))
            .is_ok()
    );
}
