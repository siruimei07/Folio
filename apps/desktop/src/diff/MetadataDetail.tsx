// Tag and settings changes read as data (handoff §6.8; ipc-m2 §9.4): the tags block of a file or
// folder, and the two-column list of changed settings and tag definitions. Old values are struck
// through in the tertiary colour; screen readers hear "Changed from Violet to Blue" instead.
import '../components/TagChip/TagChip.css';

import { type ReactElement, type ReactNode, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { TagDot } from '../components/TagDot/TagDot';
import type { SettingChange, TagChange, TagDefinitionChange, TagLabel } from '../ipc';
import { sizeParts } from '../lib/format';
import { isPaletteColor } from '../lib/palette';

/** Which sentence opens the tags block. */
export type TagsIntro = 'file' | 'folder' | 'historyFile' | 'historyFolder' | 'withContent';

function TagChips({ tags, change }: { tags: readonly TagLabel[]; change?: 'added' | 'removed' }) {
  const { t } = useTranslation('diff');
  if (tags.length === 0) return <span className="diff-tags__none">{t('tags.none')}</span>;
  return (
    <ul className="diff-tags__list">
      {tags.map((tag) => (
        // The shared tag chip (13A) that only shows, on the line colours when added or removed.
        <li key={tag.id} className="tag-chip diff-chip" data-change={change}>
          {change !== undefined && (
            <span className="diff-chip__sign" aria-hidden>
              {t(`sign.${change}`)}
            </span>
          )}
          <TagDot color={tag.color ?? ''} />
          <span className="tag-chip__name">{tag.name ?? t('tags.unknown')}</span>
        </li>
      ))}
    </ul>
  );
}

/** One row of the tags block: its label, then its chips. */
function TagsRow({ label, ...chips }: { label: string; tags: readonly TagLabel[]; change?: 'added' | 'removed' }) {
  return (
    <div className="diff-tags__row">
      <dt className="diff-tags__label">{label}</dt>
      <dd className="diff-tags__value">
        <TagChips {...chips} />
      </dd>
    </div>
  );
}

/**
 * The tags block: a sentence, then "Added", "Removed" (each only when there are some) and "Now"
 * against the 76 px label column.
 */
export function TagsBlock({ tags, intro }: { tags: TagChange; intro: TagsIntro }) {
  const { t } = useTranslation('diff');
  return (
    <div className="diff-tags">
      <p className="diff-tags__intro">{t(`tags.intro.${intro}`)}</p>
      <dl className="diff-tags__rows">
        {tags.added.length > 0 && <TagsRow label={t('tags.added')} tags={tags.added} change="added" />}
        {tags.removed.length > 0 && <TagsRow label={t('tags.removed')} tags={tags.removed} change="removed" />}
        <TagsRow label={t('tags.now')} tags={tags.now} />
      </dl>
    </div>
  );
}

/** One row of the settings list: the label, then the value. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="diff-settings__row">
      <dt className="diff-settings__label">{label}</dt>
      <dd className="diff-settings__value">{children}</dd>
    </div>
  );
}

/** "Violet → Blue" with the old value struck through; read as "Changed from Violet to Blue". */
function Change({ before, after, field }: { before: string; after: string; field?: string }) {
  const { t } = useTranslation('diff');
  const components: Record<string, ReactElement> = {
    old: <s className="diff-settings__old" />,
    new: <span className="diff-settings__new" />,
  };
  return (
    <>
      <span aria-hidden>
        {field === undefined ? (
          <Trans t={t} i18nKey="settings.change" values={{ before, after }} components={components} />
        ) : (
          <Trans t={t} i18nKey="tagDefinitions.change" values={{ field, before, after }} components={components} />
        )}
      </span>
      <span className="visually-hidden">
        {field === undefined
          ? t('settings.changeSpoken', { before, after })
          : t('tagDefinitions.changeSpoken', { field, before, after })}
      </span>
    </>
  );
}

/** Values as the list shows them: palette names, sizes, "None" for an empty value, lists. */
function useValueText() {
  const { t, i18n } = useTranslation(['diff', 'common']);
  return useMemo(() => {
    const listFormat = new Intl.ListFormat(i18n.language, { type: 'unit', style: 'short' });
    return {
      colour: (value: string | null) => {
        if (value === null) return t('settings.none');
        return isPaletteColor(value) ? t(`common:colour.names.${value}`) : value;
      },
      text: (value: string | null) => (value === null || value === '' ? t('settings.none') : value),
      yesNo: (value: boolean) => (value ? t('settings.yes') : t('settings.no')),
      size: (bytes: string) => {
        const { value, unit } = sizeParts(Number(bytes), i18n.language);
        return t(`common:size.${unit}`, { value });
      },
      list: (items: readonly string[]) => listFormat.format(items),
    };
  }, [t, i18n.language]);
}

function SettingValue({ change }: { change: SettingChange }) {
  const { t } = useTranslation('diff');
  const values = useValueText();
  switch (change.field) {
    case 'abbr':
    case 'code':
    case 'name':
      return <Change before={values.text(change.before)} after={values.text(change.after)} />;
    case 'color':
      return <Change before={values.colour(change.before)} after={values.colour(change.after)} />;
    case 'archived':
      return <Change before={values.yesNo(change.before)} after={values.yesNo(change.after)} />;
    // The order is a sort key, not a position a person would recognise.
    case 'order':
      return t('settings.moved');
    case 'textMaxSize':
      return <Change before={values.size(change.before)} after={values.size(change.after)} />;
    case 'textExtensions':
    case 'wordExtensions':
      return (
        <span className="diff-settings__lines">
          {change.added.length > 0 && <span>{t('settings.added', { list: values.list(change.added) })}</span>}
          {change.removed.length > 0 && <span>{t('settings.removed', { list: values.list(change.removed) })}</span>}
        </span>
      );
  }
}

/** A semester's, a course's or the library's changed settings: "Colour: Violet → Blue". */
export function SettingsList({ changes }: { changes: readonly SettingChange[] }) {
  const { t } = useTranslation('diff');
  return (
    <dl className="diff-settings">
      {changes.map((change) => (
        <Row key={change.field} label={t(`settings.field.${change.field}`)}>
          <SettingValue change={change} />
        </Row>
      ))}
    </dl>
  );
}

/** Changed tag definitions: "New tag: Labs", "Tag “Exams”: colour Red → Pink". */
export function TagDefinitionsList({ changes }: { changes: readonly TagDefinitionChange[] }) {
  const { t } = useTranslation('diff');
  const values = useValueText();
  const rows: ReactElement[] = [];
  for (const { id, before, after } of changes) {
    // A new or deleted tag: the one side there is.
    const only = before === null ? after : after === null ? before : null;
    if (only !== null) {
      rows.push(
        <Row key={id} label={t(before === null ? 'tagDefinitions.added' : 'tagDefinitions.deleted')}>
          <span className="diff-settings__tag">
            <TagDot color={only.color} />
            {only.name}
          </span>
        </Row>,
      );
    } else if (before !== null && after !== null) {
      rows.push(
        <Row key={id} label={t('tagDefinitions.tag', { name: after.name })}>
          <span className="diff-settings__lines">
            {before.name !== after.name && (
              <span>
                <Change field={t('tagDefinitions.field.name')} before={before.name} after={after.name} />
              </span>
            )}
            {before.color !== after.color && (
              <span>
                <Change
                  field={t('tagDefinitions.field.color')}
                  before={values.colour(before.color)}
                  after={values.colour(after.color)}
                />
              </span>
            )}
            {before.order !== after.order && <span>{t('tagDefinitions.moved')}</span>}
          </span>
        </Row>,
      );
    }
  }
  return <dl className="diff-settings">{rows}</dl>;
}
