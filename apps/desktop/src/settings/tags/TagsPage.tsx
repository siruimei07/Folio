import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button/Button';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { TagDot } from '../../components/TagDot/TagDot';
import { useLibrary } from '../../data/library';
import { useReorderTags, useTags } from '../../data/tags';
import type { Tag } from '../../ipc';
import { ipcErrorOf, LoadFailure, showFailure, useRetryFailed } from '../feedback';
import { Card, Page } from '../parts/Card';
import { ReadOnlyBanner } from '../parts/ReadOnlyBanner';
import { ReorderList, type ReorderRow } from '../parts/ReorderList';
import { RowMenu, type RowMenuItem } from '../parts/RowMenu';
import { DeleteTagDialog } from './DeleteTagDialog';
import { TagDialog } from './TagDialog';

/** Which tag dialog is open: a new tag, editing one, or deleting one. */
type Editing = { kind: 'new' } | { kind: 'edit'; tag: Tag } | { kind: 'delete'; tag: Tag } | null;

/**
 * Library settings → Tags (app-shell handoff §9): every tag in the user's order with its colour
 * and how many files and folders carry it, a menu to edit, move or delete it, and "New tag".
 */
export function TagsPage() {
  const { t } = useTranslation('settings');
  const library = useLibrary();
  const readOnly = library?.readOnly === true;
  const tags = useTags();
  const reorder = useReorderTags();
  const retry = useRetryFailed();
  const [editing, setEditing] = useState<Editing>(null);

  const saveOrder = async (ids: string[]): Promise<boolean> => {
    try {
      await reorder.mutateAsync({ tags: ids });
      return true;
    } catch (failure: unknown) {
      showFailure(t('tags.reorderFailed'), ipcErrorOf(failure), 'settings.reorderTags');
      return false;
    }
  };

  const close = () => {
    setEditing(null);
  };

  // A tag's menu (§9): Edit…, Move up, Move down, Delete….
  const menu = (tag: Tag, row: ReorderRow): RowMenuItem[] => {
    const open = (next: Editing) => (readOnly ? undefined : () => {
      setEditing(next);
    });
    return [
      { id: 'edit', label: t('tags.edit'), icon: Pencil, onAction: open({ kind: 'edit', tag }) },
      { id: 'up', label: t('reorder.moveUp'), icon: ArrowUp, onAction: row.moveUp },
      { id: 'down', label: t('reorder.moveDown'), icon: ArrowDown, onAction: row.moveDown },
      { id: 'delete', label: t('tags.delete'), icon: Trash2, destructive: true, onAction: open({ kind: 'delete', tag }) },
    ];
  };

  return (
    <Page>
      <ReadOnlyBanner />
      <Card
        title={t('tags.title')}
        description={readOnly ? t('tags.descriptionReadOnly') : t('tags.description')}
        action={
          <Button
            icon={Plus}
            isDisabled={readOnly}
            onPress={() => {
              setEditing({ kind: 'new' });
            }}
          >
            {t('tags.new')}
          </Button>
        }
      >
        {tags.error !== null ? (
          <LoadFailure title={t('tags.loadFailed')} error={tags.error.error} retry={retry} />
        ) : tags.data === undefined ? (
          <Skeleton rows={5} />
        ) : tags.data.length === 0 ? (
          <p className="settings-card__empty">{t('tags.empty')}</p>
        ) : (
          <ReorderList
            label={t('tags.title')}
            items={tags.data}
            keyOf={(tag) => tag.id}
            nameOf={(tag) => tag.name}
            onReorder={saveOrder}
            isDisabled={readOnly}
          >
            {(tag, row) => (
              <>
                <span className="settings-list__dot">
                  <TagDot color={tag.color} />
                </span>
                <span className="settings-list__name" title={tag.name}>
                  {tag.name}
                </span>
                <span className="settings-list__meta">{t('tags.usage', { count: tag.usage })}</span>
                <RowMenu label={t('tags.more', { tag: tag.name })} items={menu(tag, row)} />
              </>
            )}
          </ReorderList>
        )}
      </Card>
      {editing?.kind === 'new' && <TagDialog tag={null} tags={tags.data ?? []} onClose={close} />}
      {editing?.kind === 'edit' && <TagDialog tag={editing.tag} tags={tags.data ?? []} onClose={close} />}
      {editing?.kind === 'delete' && <DeleteTagDialog tag={editing.tag} onClose={close} />}
    </Page>
  );
}
