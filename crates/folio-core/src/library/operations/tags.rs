use std::collections::btree_map::Entry as Slot;
use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::catalog::Catalog;
use crate::meta::{Color, DisplayName, TagDefinition, TagDefinitions, TagId, tag_location};
use crate::paths::same_name;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    pub id: TagId,
    pub definition: TagDefinition,
    pub usage: u32,
}

fn tags(tx: &Connection) -> Result<Vec<Tag>, CatalogError> {
    let usage = catalog::tag_usage(tx)?;
    let mut result: Vec<_> = catalog::tag_definitions(tx)?
        .tags
        .into_iter()
        .map(|(id, definition)| Tag {
            usage: usage.get(&id).copied().unwrap_or(0),
            id,
            definition,
        })
        .collect();
    result.sort_by(|a, b| {
        a.definition
            .order
            .cmp(&b.definition.order)
            .then(a.definition.name.as_str().cmp(b.definition.name.as_str()))
            .then(a.id.cmp(&b.id))
    });
    Ok(result)
}

fn definitions(tree: &MetaTree) -> Result<TagDefinitions, OperationError> {
    match tree.tag_definitions() {
        None => Ok(TagDefinitions::default()),
        Some(Ok(definitions)) => Ok(definitions.clone()),
        Some(Err(error)) => Err(OperationError::UnreadableMetadata(error.to_string())),
    }
}

fn unique_name(
    definitions: &TagDefinitions,
    name: &DisplayName,
    except: Option<&TagId>,
) -> Result<(), OperationError> {
    if definitions.tags.iter().any(|(id, definition)| {
        Some(id) != except && same_name(definition.name.as_str(), name.as_str())
    }) {
        Err(OperationError::AlreadyExists)
    } else {
        Ok(())
    }
}

impl Library {
    pub fn list_tags(&self, catalog: &Catalog) -> Result<Vec<Tag>, OperationError> {
        Ok(catalog.read(|tx| tags(tx))?)
    }

    pub fn create_tag(
        &self,
        catalog: &Catalog,
        text: &str,
        color: &str,
    ) -> Result<Outcome<Tag>, OperationError> {
        let name = DisplayName::parse(&normalize_text(text))?;
        let color = Color::parse(color)?;
        let mut written = false;
        let result = catalog.write_with(|tx| {
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            let mut definitions = definitions(&tree)?;
            unique_name(&definitions, &name, None)?;
            let order = definitions
                .tags
                .values()
                .map(|definition| definition.order)
                .max()
                .map(|order| {
                    order
                        .checked_add(1)
                        .ok_or(OperationError::InvalidArgument("tag order exhausted"))
                })
                .transpose()?
                .unwrap_or(0);
            let id = loop {
                let id = TagId::generate()?;
                if !definitions.tags.contains_key(&id) {
                    break id;
                }
            };
            let definition = TagDefinition { name, color, order };
            definitions.tags.insert(id.clone(), definition.clone());
            self.layout.write_tags(&definitions)?;
            written = true;
            Ok(Outcome {
                value: Tag {
                    id,
                    definition,
                    usage: 0,
                },
                committed: self.mirror_operation(tx)?,
            })
        });
        self.after_metadata_write(written, result)
    }

    pub fn update_tag(
        &self,
        catalog: &Catalog,
        id: &TagId,
        text: &str,
        color: &str,
    ) -> Result<Outcome<Tag>, OperationError> {
        let name = DisplayName::parse(&normalize_text(text))?;
        let color = Color::parse(color)?;
        let mut written = false;
        let result = catalog.write_with(|tx| {
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            let mut definitions = definitions(&tree)?;
            let old = definitions.tags.get(id).ok_or(OperationError::NotFound)?;
            let definition = TagDefinition {
                name,
                color,
                order: old.order,
            };
            unique_name(&definitions, &definition.name, Some(id))?;
            if definitions.tags.get(id) != Some(&definition) {
                definitions.tags.insert(id.clone(), definition.clone());
                self.layout.write_tags(&definitions)?;
                written = true;
            }
            let committed = self.mirror_operation(tx)?;
            let value = tags(tx)?
                .into_iter()
                .find(|tag| tag.id == *id)
                .ok_or(OperationError::NotFound)?;
            Ok(Outcome { value, committed })
        });
        self.after_metadata_write(written, result)
    }

    pub fn reorder_tags(
        &self,
        catalog: &Catalog,
        ids: &[TagId],
    ) -> Result<Outcome<Vec<Tag>>, OperationError> {
        if ids.len() > MAX_BATCH {
            return Err(OperationError::InvalidArgument("tag order limit exceeded"));
        }
        let mut written = false;
        let result = catalog.write_with(|tx| {
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            let mut definitions = definitions(&tree)?;
            let supplied: BTreeSet<_> = ids.iter().cloned().collect();
            if ids.len() != supplied.len() || supplied != definitions.tags.keys().cloned().collect()
            {
                return Err(OperationError::InvalidArgument(
                    "expected every tag exactly once",
                ));
            }
            let before = definitions.clone();
            for (order, id) in ids.iter().enumerate() {
                definitions
                    .tags
                    .get_mut(id)
                    .expect("validated permutation")
                    .order = order as u32;
            }
            if definitions != before {
                self.layout.write_tags(&definitions)?;
                written = true;
            }
            let committed = self.mirror_operation(tx)?;
            Ok(Outcome {
                value: tags(tx)?,
                committed,
            })
        });
        self.after_metadata_write(written, result)
    }

    pub fn delete_tag(
        &self,
        catalog: &Catalog,
        id: &TagId,
    ) -> Result<Outcome<u32>, OperationError> {
        let mut written = false;
        let result = catalog.write_with(|tx| {
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            let mut definitions = definitions(&tree)?;
            definitions
                .tags
                .remove(id)
                .ok_or(OperationError::NotFound)?;
            // Every authored assignment counts, even orphaned/recycled paths absent from SQLite.
            // Refuse before writing when one file is unreadable: its assignments are unknown.
            if let Some(error) = tree.broken().values().next() {
                return Err(OperationError::UnreadableMetadata(error.to_string()));
            }
            let mut assignments = 0u32;
            for (file, value) in tree.loaded() {
                let mut value = value.clone();
                let affected: Vec<_> = value
                    .tags
                    .iter()
                    .filter(|(_, ids)| ids.contains(id))
                    .map(|(path, _)| path.clone())
                    .collect();
                if affected.is_empty() {
                    continue;
                }
                assignments = assignments.checked_add(affected.len() as u32).ok_or(
                    OperationError::InvalidArgument("assignment count exhausted"),
                )?;
                for path in affected {
                    let mut ids = value.tags.get(&path).cloned().unwrap_or_default();
                    ids.remove(id);
                    value.tags.set(path, ids);
                }
                self.write_content(file, &value)?;
                written = true;
            }
            // Definition last: a failed assignment write keeps the tag available for retry.
            self.layout.write_tags(&definitions)?;
            written = true;
            Ok(Outcome {
                value: assignments,
                committed: self.mirror_operation(tx)?,
            })
        });
        self.after_metadata_write(written, result)
    }

    pub fn set_entry_tags(
        &self,
        catalog: &Catalog,
        entries: &[EntryRef],
        add: &BTreeSet<TagId>,
        remove: &BTreeSet<TagId>,
    ) -> Result<Outcome<BatchResult>, OperationError> {
        batch_limit(entries)?;
        if !add.is_disjoint(remove) {
            return Err(OperationError::InvalidArgument("add and remove overlap"));
        }
        let mut written = false;
        let result = catalog.write_with(|tx| {
            // One read of the metadata for the whole batch, one write per file that changes and
            // one mirror at the end.
            let tree = self.read_meta(tx)?;
            // Validate the payload even for an empty batch. With read-only metadata each entry
            // reports ReadOnly instead, and newer definitions stay opaque.
            if !tree.is_read_only() {
                let definitions = definitions(&tree)?;
                if add.iter().any(|id| !definitions.tags.contains_key(id)) {
                    return Err(OperationError::InvalidArgument("undefined tag in add"));
                }
            }
            let mut value = BatchResult::default();
            let mut files = BTreeMap::new();
            for reference in entries {
                match self.stage_tags(tx, &tree, reference, add, remove, &mut files) {
                    Ok(()) => value.done += 1,
                    Err(error) => value.failures.push((reference.clone(), error)),
                }
            }
            for (file, staged) in files {
                if staged.changed.is_empty() {
                    continue;
                }
                match self.write_content(&file, &staged.content) {
                    Ok(()) => written = true,
                    // The entries that changed this file fail with it; the others stand.
                    Err(error) => {
                        value.done -= staged.changed.len() as u32;
                        let copies = staged.changed[1..]
                            .iter()
                            .map(|reference| (reference.clone(), failure_copy(&error)))
                            .collect::<Vec<_>>();
                        value.failures.push((staged.changed[0].clone(), error));
                        value.failures.extend(copies);
                    }
                }
            }
            Ok(Outcome {
                value,
                committed: self.mirror_operation(tx)?,
            })
        });
        self.after_metadata_write(written, result)
    }

    /// Checks one entry of a [`Library::set_entry_tags`] batch and records its new tags in the
    /// content of the file that holds them.
    fn stage_tags(
        &self,
        tx: &Connection,
        tree: &MetaTree,
        reference: &EntryRef,
        add: &BTreeSet<TagId>,
        remove: &BTreeSet<TagId>,
        files: &mut BTreeMap<TagFile, Staged>,
    ) -> Result<(), OperationError> {
        let entry = resolve(tx, reference)?;
        self.entry_disk(&entry)?;
        let Some((holder, key)) = tag_location(&entry.record.path, entry.record.kind) else {
            return Err(OperationError::InvalidArgument(
                "semester/course folders carry no tags",
            ));
        };
        writable(tree)?;
        let staged = match files.entry(owner(tree, &holder)) {
            Slot::Occupied(slot) => slot.into_mut(),
            Slot::Vacant(slot) => {
                let (_, content) = content(tree, slot.key())?;
                slot.insert(Staged {
                    content,
                    changed: Vec::new(),
                })
            }
        };
        let before = staged
            .content
            .tags
            .iter()
            .find(|(path, _)| path.key() == key.key())
            .map(|(_, ids)| ids.clone())
            .unwrap_or_default();
        let mut ids = before.clone();
        ids.extend(add.iter().cloned());
        ids.retain(|id| !remove.contains(id));
        if ids != before {
            staged.content.tags.set(key, ids);
            staged.changed.push(reference.clone());
        }
        Ok(())
    }
}

/// A metadata file's content while a batch changes it, and the entries that changed it.
struct Staged {
    content: Content,
    changed: Vec<EntryRef>,
}

/// The failure of a file that several entries changed, for each entry after the first: io
/// errors cannot be cloned, so this keeps the OS error, or the kind, and the text.
fn failure_copy(error: &OperationError) -> OperationError {
    match error {
        OperationError::Meta(MetaError::Io { path, source })
        | OperationError::Io { path, source } => OperationError::Io {
            path: path.clone(),
            source: source.raw_os_error().map_or_else(
                || std::io::Error::new(source.kind(), source.to_string()),
                std::io::Error::from_raw_os_error,
            ),
        },
        other => OperationError::UnreadableMetadata(other.to_string()),
    }
}
