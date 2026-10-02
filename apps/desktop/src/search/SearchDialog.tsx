import './SearchDialog.css';

import { CircleX, Folder, RefreshCw, Search, TextCursorInput } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Autocomplete,
  Collection,
  Header,
  Input,
  type Key,
  ListBox,
  ListBoxItem,
  ListBoxLoadMoreItem,
  ListBoxSection,
  Text,
  TextField,
} from 'react-aria-components';

import { announce } from '../app/announcer';
import { reveal } from '../app/navigation';
import type { DialogComponentProps } from '../app/registry';
import { Button } from '../components/Button/Button';
import { Modal } from '../components/Dialog/Dialog';
import { FileTypeIcon } from '../components/FileTypeIcon/FileTypeIcon';
import { KeyCap } from '../components/KeyCap/KeyCap';
import { MiddleTruncate } from '../components/MiddleTruncate/MiddleTruncate';
import { Skeleton } from '../components/Skeleton/Skeleton';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { useCourses } from '../data/groups';
import { type SearchResults, useSearch } from '../data/search';
import type { Course, SearchHit } from '../ipc';
import { LIMITS } from '../ipc';
import { parentOf } from '../lib/paths';
import { placeOf } from '../lib/places';
import { charCount } from '../lib/text';
import { SIZE } from '../tokens/tokens';
import { groupHits } from './hits';
import { Highlighted } from './Highlighted';
import { useSettledText } from './settledText';

/** The groups in the order they show (handoff §8), as keys of `groupHits` and of `search:groups`. */
const GROUPS = ['names', 'contents'] as const;

/** The footer's keys and what each does, as keys of `search:keys` and `search:hints`. */
const KEY_HINTS = [
  ['arrows', 'select'],
  ['enter', 'preview'],
  ['esc', 'close'],
] as const;

/**
 * The search dialog (app-shell handoff §8, UI architecture §9): results as you type in two
 * groups, ↑ ↓ to move through them while the input keeps focus, Enter or a click to show the file
 * in the Library and its preview. Esc or the scrim closes it, and focus returns to where it was.
 * Every opening starts with an empty field.
 */
export function SearchDialog({ isOpen, onClose }: DialogComponentProps<'search'>) {
  const { t } = useTranslation('search');
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      scrim="search"
      aria-label={t('label')}
    >
      <SearchPalette onClose={onClose} />
    </Modal>
  );
}

function SearchPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('search');
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const query = useSettledText(text, composing).trim();
  const search = useSearch(query, null);
  const count = useResultCount(search);
  useAnnounceOutcome(query, search, count);

  // Try again goes away with the error it answers: focus goes back to the field, which drives the list.
  const retry = () => {
    field.current?.focus();
    search.retry();
  };

  const choose = (key: Key) => {
    const hit = search.hits.find((candidate) => candidate.entry.id === key);
    if (hit === undefined) return;
    // The Library expands to the file, selects it and shows its preview (UI architecture §8.2).
    reveal(hit.entry);
    onClose();
  };

  return (
    <div
      className="search-palette"
      onKeyDownCapture={(event) => {
        // Autocomplete hands the field's Esc to the list, not the dialog, and a state block has no
        // list to hand it on from: the palette closes on Esc itself (an IME's Esc stays the IME's).
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) onClose();
      }}
    >
      <Autocomplete inputValue={text} onInputChange={setText}>
        <TextField className="search-palette__field" aria-label={t('label')} autoFocus>
          <Search aria-hidden size={SIZE.icon} className="search-palette__icon" />
          <Input
            ref={field}
            className="search-palette__input"
            placeholder={t('placeholder')}
            spellCheck={false}
            onCompositionStart={() => {
              setComposing(true);
            }}
            onCompositionEnd={() => {
              setComposing(false);
            }}
          />
          <KeyCap keys={t('keys.esc')} />
        </TextField>
        <div className="search-palette__body">
          <SearchBody query={query} search={search} onAction={choose} onRetry={retry} />
        </div>
      </Autocomplete>
      <footer className="search-palette__footer">
        {/* For sight: the list's roles tell screen readers how to move through it. */}
        <span className="search-palette__keys" aria-hidden>
          {KEY_HINTS.map(([key, hint]) => (
            <span key={key} className="search-palette__key">
              <KeyCap keys={t(`keys.${key}`)} />
              {t(`hints.${hint}`)}
            </span>
          ))}
        </span>
        {count !== null && <span className="search-palette__count">{count}</span>}
      </footer>
    </div>
  );
}

/** One of: the hint before any text, loading, the error, no matches, or the grouped results. */
function SearchBody({
  query,
  search,
  onAction,
  onRetry,
}: {
  query: string;
  search: SearchResults;
  onAction: (key: Key) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation(['search', 'errors']);
  if (search.status === 'idle') return <p className="search-palette__hint">{t('idle')}</p>;
  if (search.status === 'pending') return <Skeleton rows={4} />;
  const failure = search.error?.error;
  if (failure?.code === 'QueryTooLong') {
    return (
      <StateBlock
        tone="warning"
        icon={TextCursorInput}
        placement="preview"
        title={t('tooLong.title')}
        text={t('tooLong.text', { max: LIMITS.queryChars, count: charCount(query) })}
      />
    );
  }
  if (failure !== undefined) {
    return (
      <StateBlock
        tone="danger"
        icon={CircleX}
        placement="preview"
        title={t('failed')}
        text={t(`errors:${failure.code}`)}
        actions={
          <Button icon={RefreshCw} onPress={onRetry}>
            {t('tryAgain')}
          </Button>
        }
      />
    );
  }
  if (search.hits.length === 0) {
    return (
      <StateBlock
        icon={Search}
        placement="preview"
        title={t('empty.title', { text: query })}
        text={t('empty.text')}
      />
    );
  }
  return <SearchResultsList search={search} onAction={onAction} />;
}

function SearchResultsList({ search, onAction }: { search: SearchResults; onAction: (key: Key) => void }) {
  const { t } = useTranslation('search');
  const courses = useCourses().data;
  const groups = useMemo(() => groupHits(search.hits), [search.hits]);
  return (
    <ListBox
      className="search-results"
      aria-label={t('results')}
      aria-busy={search.isPrevious || undefined}
      onAction={onAction}
    >
      {GROUPS.map(
        (group) =>
          groups[group].length > 0 && (
            <ListBoxSection key={group} className="search-results__group">
              <Header className="search-results__header">{t(`groups.${group}`)}</Header>
              {/* Rows render once per hit: typing and further pages leave the others alone. */}
              <Collection items={groups[group]} dependencies={[courses]}>
                {(hit) => <HitRow id={hit.entry.id} hit={hit} courses={courses} />}
              </Collection>
            </ListBoxSection>
          ),
      )}
      <ListBoxLoadMoreItem
        className="search-results__more"
        onLoadMore={search.loadMore}
        isLoading={search.isLoadingMore}
      >
        {t('loadingMore')}
      </ListBoxLoadMoreItem>
    </ListBox>
  );
}

/**
 * A hit, a file or a folder (a course, too): its icon, name with its matches, the folder it is in
 * ("MAT232 / Problem sets") and, for a content match, the text around it. The folder and snippet
 * are the option's description.
 */
function HitRow({ id, hit, courses }: { id: string; hit: SearchHit; courses: readonly Course[] | undefined }) {
  // Only with the courses: without them a place would show folder names instead of course codes.
  const place = courses === undefined ? '' : placeOf(parentOf(hit.entry.path), courses);
  return (
    <ListBoxItem id={id} textValue={hit.entry.name} className="search-hit">
      {hit.entry.kind === 'folder' ? (
        <Folder aria-hidden size={SIZE.icon} className="search-hit__folder" />
      ) : (
        <FileTypeIcon name={hit.entry.name} />
      )}
      <Text slot="label" className="search-hit__name" title={hit.entry.name}>
        <Highlighted spans={hit.name} />
      </Text>
      <Text slot="description" className="search-hit__about">
        {place !== '' && (
          <span className="search-hit__place">
            {/* Cut in the middle for sight, so a long course name never hides the folder at the
                end; screen readers get the whole place. */}
            <span className="search-hit__place-cut" aria-hidden>
              <MiddleTruncate text={place} />
            </span>
            <span className="visually-hidden">{place}</span>
          </span>
        )}
        {hit.snippet !== null && (
          <span className="search-hit__snippet">
            <Highlighted spans={hit.snippet} />
          </span>
        )}
      </Text>
    </ListBoxItem>
  );
}

/** "12 results", or "50+ results" while more follow within the window; `null` before any. */
function useResultCount({ status, hits, hasMore }: SearchResults): string | null {
  const { t } = useTranslation('search');
  if (status !== 'success' || hits.length === 0) return null;
  return t(hasMore ? 'countMore' : 'count', { count: hits.length });
}

/**
 * Tells screen readers how a search ended, once per text and outcome: focus stays in the field, so
 * a count, no matches or an error would otherwise go unheard. A retry that works is told again;
 * loading more pages says nothing.
 */
function useAnnounceOutcome(query: string, search: SearchResults, count: string | null) {
  const { t } = useTranslation(['search', 'errors']);
  const told = useRef<string | null>(null);
  const settled = (search.status === 'success' && !search.isPrevious) || search.status === 'error';
  const failure = search.error?.error;
  useEffect(() => {
    const outcome = `${failure?.code ?? 'found'}:${query}`;
    if (!settled || told.current === outcome) return;
    told.current = outcome;
    if (failure?.code === 'QueryTooLong') announce(t('tooLong.title'));
    else if (failure !== undefined) announce(`${t('failed')}. ${t(`errors:${failure.code}`)}`);
    else announce(count ?? t('empty.title', { text: query }));
  }, [settled, query, failure, count, t]);
}
