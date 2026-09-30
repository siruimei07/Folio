import './TagChip.css';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tag, TagGroup, TagList, ToggleButton } from 'react-aria-components';

import type { Tag as TagData } from '../../ipc';
import { SIZE } from '../../tokens/tokens';
import { TagDot } from '../TagDot/TagDot';

export interface TagToggleProps {
  /** The tag, or null for the "All" chip of a filter bar. */
  tag: Pick<TagData, 'name' | 'color'> | null;
  /** The chip's text; a tag's name by default. */
  children?: ReactNode;
  isSelected: boolean;
  onChange: (selected: boolean) => void;
  isDisabled?: boolean;
}

/**
 * A tag chip that toggles, for the tag filter bar and the import dialog's tags (13A): idle on the
 * panel with a border, selected in the primary text colour. `aria-pressed` carries the state.
 */
export function TagToggle({ tag, children, isSelected, onChange, isDisabled }: TagToggleProps) {
  return (
    <ToggleButton className="tag-chip" isSelected={isSelected} onChange={onChange} isDisabled={isDisabled}>
      {tag && <TagDot color={tag.color} />}
      <span className="tag-chip__name">{children ?? tag?.name}</span>
    </ToggleButton>
  );
}

export interface TagChipListProps {
  /** Names the list, like "Tags". */
  label: string;
  tags: readonly Pick<TagData, 'id' | 'name' | 'color'>[];
  /** Offers a remove button on each chip ("Remove tag Notes"); none without it. */
  onRemove?: (id: string) => void;
  /** After the chips, such as the dashed "+ Tag" chip. */
  children?: ReactNode;
}

/** A file's tags as chips with remove buttons, in the preview header (app-shell handoff §5). */
export function TagChipList({ label, tags, onRemove, children }: TagChipListProps) {
  const { t } = useTranslation('common');
  return (
    <div className="tag-chip-list">
      <TagGroup
        aria-label={label}
        onRemove={onRemove && ((keys) => {
          for (const key of keys) onRemove(String(key));
        })}
      >
        <TagList className="tag-chip-list__tags" items={tags}>
          {(tag) => (
            <Tag id={tag.id} className="tag-chip" textValue={tag.name}>
              {({ allowsRemoving }) => (
                <>
                  <TagDot color={tag.color} />
                  <span className="tag-chip__name">{tag.name}</span>
                  {allowsRemoving && (
                    // React Aria names it with this label and the tag's: "Remove tag Notes".
                    <Button slot="remove" className="tag-chip__remove" aria-label={t('tags.remove')}>
                      <X aria-hidden size={SIZE.iconSmall} />
                    </Button>
                  )}
                </>
              )}
            </Tag>
          )}
        </TagList>
      </TagGroup>
      {children}
    </div>
  );
}
