import i18n from 'i18next';
import { describe, it } from 'vitest';

describe('i18n', () => {
  it('types keys against the en strings', () => {
    // Fails `tsc` if the declaration in i18next.ts stops applying, for example after an i18next
    // upgrade, and every key would quietly type-check.
    // @ts-expect-error: a key that en lacks does not compile.
    i18n.t('missing');
  });
});
