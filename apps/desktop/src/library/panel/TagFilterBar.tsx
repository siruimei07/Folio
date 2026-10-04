import { ChevronDown, RefreshCw } from 'lucide-react';
import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button as AriaButton, type Selection } from 'react-aria-components';
import { useTranslation } from 'react-i18next';

import { useLayout } from '../../app/layout';
import { Button } from '../../components/Button/Button';
import { Menu, MenuButton, MenuItem, MenuSection } from '../../components/Menu/Menu';
import { TagToggle } from '../../components/TagChip/TagChip';
import { TagDot } from '../../components/TagDot/TagDot';
import { useTags } from '../../data/tags';
import { LIMITS, type Tag } from '../../ipc';
import { SIZE } from '../../tokens/tokens';
import { EditTagsSection } from '../menus/EntryMenu';
import { setFilter, useLibraryView } from '../state';
import { visibleTagCount } from './chipRows';

const NO_TAGS: readonly string[] = [];
const NO_TAG_LIST: readonly Tag[] = [];

/** The stored filter without tags that were deleted since. */
function useKnownFilter(): readonly string[] {
  const tags = useTags().data;
  const filter = useLibraryView((state) => state.filter);
  return useMemo(
    () => (tags === undefined ? filter : filter.filter((id) => tags.some((tag) => tag.id === id))),
    [tags, filter],
  );
}

/**
 * The tag filter that applies to the tree and the list: none in a narrow window, where the bar is
 * hidden and filters go through search (app-shell §2); the stored one comes back when the window
 * widens.
 */
export function useActiveFilter(): readonly string[] {
  const filter = useKnownFilter();
  return useLayout() === 'narrow' ? NO_TAGS : filter;
}

/** An element's content width: its client width without the padding. */
function contentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}

/**
 * How many tags fit before the "+N" chip (33B): `probe` holds a hidden copy of every chip in one
 * line, then "+N" at its widest without and with "· k on", whose widths are laid out against the
 * bar's. The wider "+N" counts only when a tag it hides is on, so turning on a tag the bar shows
 * moves no other tag into the menu. Measured when the tags or the filter change, and whenever the
 * bar or the copy resizes (the window, a font arriving).
 */
function useVisibleTags(
  bar: RefObject<HTMLElement | null>,
  probe: RefObject<HTMLElement | null>,
  on: readonly boolean[],
): number {
  const total = on.length;
  const [visible, setVisible] = useState(total);
  const measure = useEffectEvent(() => {
    const element = bar.current;
    const copy = probe.current;
    if (element === null || copy === null) return;
    const [first = 0, ...tags] = Array.from(copy.children, (chip) => chip.getBoundingClientRect().width);
    const moreOn = tags.pop() ?? 0;
    const more = tags.pop() ?? 0;
    const measures = { available: contentWidth(element), gap: parseFloat(getComputedStyle(element).columnGap) || 0, first, tags };
    const plain = visibleTagCount({ ...measures, more });
    // React keeps the render when the count stays.
    setVisible(on.slice(plain).includes(true) ? visibleTagCount({ ...measures, more: moreOn }) : plain);
  });
  // The chips change with the tags and the filter, each a new `on`.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a layout measured before paint, as react.dev's useLayoutEffect shows
    measure();
  }, [on]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      measure();
    });
    for (const element of [bar.current, probe.current]) if (element !== null) observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [bar, probe]);
  return Math.min(visible, total);
}

/** A chip's look without its button, for measuring. */
function ChipCopy({ tag, selected, children }: { tag: Pick<Tag, 'color'> | null; selected: boolean; children: string }) {
  return (
    <span className="tag-chip" data-selected={selected || undefined}>
      {tag !== null && <TagDot color={tag.color} />}
      <span className="tag-chip__name">{children}</span>
    </span>
  );
}

/** What "+N" shows: how many tags it hides and how many of them are on ("+4 · 1 on"), and a chevron. */
function MoreFace({ count, on }: { count: number; on: number }) {
  const { t } = useTranslation('library');
  return (
    <>
      <span className="tag-chip__name">{on > 0 ? t('filter.moreOn', { count, on }) : t('filter.more', { count })}</span>
      <ChevronDown aria-hidden size={SIZE.iconTiny} />
    </>
  );
}

interface MoreTagsProps {
  hidden: readonly Tag[];
  filter: readonly string[];
  full: boolean;
}

/**
 * The "+N" chip and its menu (33B, library-actions §2.7): the tags that did not fit, checkable,
 * then "Edit tags…". Toggling keeps the menu open, like the Tags submenu; Esc closes it. With a
 * hidden tag on, the chip takes the selected look and says how many: "+4 · 1 on".
 */
function MoreTags({ hidden, filter, full }: MoreTagsProps) {
  const { t } = useTranslation('library');
  const selected = hidden.filter((tag) => filter.includes(tag.id)).map((tag) => tag.id);
  const on = selected.length;
  const count = hidden.length;

  const onSelectionChange = (keys: Selection) => {
    if (keys === 'all') return;
    const added = hidden.filter((tag) => keys.has(tag.id) && !filter.includes(tag.id)).map((tag) => tag.id);
    const removed = new Set(selected.filter((id) => !keys.has(id)));
    setFilter([...filter.filter((id) => !removed.has(id)), ...added]);
  };

  return (
    <MenuButton
      trigger={
        <AriaButton
          className="tag-chip tag-filter__more"
          data-selected={on > 0 || undefined}
          aria-label={on > 0 ? t('filter.moreLabelOn', { count, on }) : t('filter.moreLabel', { count })}
        >
          <MoreFace count={count} on={on} />
        </AriaButton>
      }
    >
      <Menu>
        <MenuSection
          aria-label={t('filter.label')}
          selectionMode="multiple"
          selectedKeys={selected}
          onSelectionChange={onSelectionChange}
        >
          {hidden.map((tag) => (
            <MenuItem key={tag.id} id={tag.id} icon={<TagDot color={tag.color} />} isDisabled={full && !filter.includes(tag.id)}>
              {tag.name}
            </MenuItem>
          ))}
        </MenuSection>
        <EditTagsSection />
      </Menu>
    </MenuButton>
  );
}

/**
 * The tag filter bar (app-shell handoff §5, 13A): "All", then the tags in order. Several tags
 * can be on, and a file must have all of them; "All" clears them. At most two rows: the tags that
 * would start a third go behind a "+N" chip with a menu (workspace-history §12.1, 33B).
 */
export function TagFilterBar() {
  const { t } = useTranslation('library');
  const query = useTags();
  const filter = useKnownFilter();
  const tags = query.data ?? NO_TAG_LIST;
  const bar = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const on = useMemo(() => tags.map((tag) => filter.includes(tag.id)), [tags, filter]);
  const shown = useVisibleTags(bar, probe, on);
  const hidden = tags.slice(shown);

  const full = filter.length >= LIMITS.filterTags;
  return (
    <div ref={bar} role="group" aria-label={t('filter.label')} className="tag-filter">
      <TagToggle
        tag={null}
        isSelected={filter.length === 0}
        onChange={() => {
          setFilter([]);
        }}
      >
        {t('filter.all')}
      </TagToggle>
      {tags.slice(0, shown).map((tag) => {
        const on = filter.includes(tag.id);
        return (
          <TagToggle
            key={tag.id}
            tag={tag}
            isSelected={on}
            isDisabled={!on && full}
            onChange={(selected) => {
              setFilter(selected ? [...filter, tag.id] : filter.filter((id) => id !== tag.id));
            }}
          />
        );
      })}
      {hidden.length > 0 && <MoreTags hidden={hidden} filter={filter} full={full} />}
      {full && (
        <span className="tag-filter__note" role="status">
          {t('filter.full', { count: LIMITS.filterTags })}
        </span>
      )}
      {query.status === 'error' && (
        <span className="tag-filter__failed">
          {t('states.loadTags')}
          <Button
            variant="link"
            size="compact"
            icon={RefreshCw}
            onPress={() => {
              void query.refetch();
            }}
          >
            {t('states.tryAgain')}
          </Button>
        </span>
      )}
      <div ref={probe} className="tag-filter__probe" aria-hidden>
        <ChipCopy tag={null} selected={filter.length === 0}>
          {t('filter.all')}
        </ChipCopy>
        {tags.map((tag) => (
          <ChipCopy key={tag.id} tag={tag} selected={filter.includes(tag.id)}>
            {tag.name}
          </ChipCopy>
        ))}
        {/* "+N" at its widest: every tag behind it, without and with every selected one among them. */}
        <span className="tag-chip tag-filter__more">
          <MoreFace count={tags.length} on={0} />
        </span>
        <span className="tag-chip tag-filter__more" data-selected>
          <MoreFace count={tags.length} on={Math.max(1, filter.length)} />
        </span>
      </div>
    </div>
  );
}
