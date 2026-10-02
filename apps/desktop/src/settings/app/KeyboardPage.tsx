import { useTranslation } from 'react-i18next';

import { type KeyCombo, LIBRARY_SETTINGS_KEYS, SEARCH_KEYS, useShortcutLabel, viewKeys } from '../../app/shortcuts';
import { KeyCap } from '../../components/KeyCap/KeyCap';
import { Page, Row, Rows } from '../parts/Card';

/** The window's shortcuts in M1 (UI architecture §6.4); M2 and M3 add commit, sync and their views. */
const SHORTCUTS: readonly { id: 'search' | 'library' | 'settings'; keys: KeyCombo }[] = [
  { id: 'search', keys: SEARCH_KEYS },
  { id: 'library', keys: viewKeys('1') },
  { id: 'settings', keys: LIBRARY_SETTINGS_KEYS },
];

/** App settings → Keyboard (app-shell handoff §9): the shortcuts, read-only. */
export function KeyboardPage() {
  const { t } = useTranslation('settings');
  const label = useShortcutLabel();
  return (
    <Page>
      <Rows>
        {SHORTCUTS.map(({ id, keys }) => (
          <Row
            key={id}
            label={t(`keyboard.${id}`)}
            control={() => (
              <>
                <span className="visually-hidden">{label(keys)}</span>
                <KeyCap keys={label(keys, ' ')} />
              </>
            )}
          />
        ))}
      </Rows>
    </Page>
  );
}
