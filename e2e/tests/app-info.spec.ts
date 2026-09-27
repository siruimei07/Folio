import { expect, test } from '../fixtures';

test('shows app info from the Rust shell and uses the isolated data directory', async ({
  folio,
}) => {
  await expect(folio.page.getByTestId('app-version')).toHaveText(/^\d+\.\d+\.\d+/);
  await expect(folio.page.getByTestId('data-dir')).toHaveText(folio.dataDir);
});
