import { type ComponentType, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Modal } from '../components/Dialog/Dialog';
import { ErrorBoundary, ViewFailure } from './ErrorBoundary';
import { closeDialog, type DialogKind, type OpenDialog, useNavigation } from './navigation';
import type { DialogComponentProps, DialogRegistry } from './registry';

/**
 * The dialogs the navigation store opens, one at a time (UI architecture §6.2). A dialog mounts
 * the first time it opens and then stays mounted with `isOpen`, so its closing animation plays,
 * keeping the parameters it was last opened with. Each sits in an error boundary that keeps a
 * modal frame.
 */
export function DialogHost({ dialogs }: { dialogs: DialogRegistry }) {
  const { t } = useTranslation('shell');
  const open = useNavigation((state) => state.dialog);
  // The last opening of each kind: a dialog renders only once it has one.
  const [opened, setOpened] = useState<Partial<Record<DialogKind, OpenDialog>>>(() =>
    open === null ? {} : { [open.kind]: open },
  );
  if (open !== null && opened[open.kind] !== open) setOpened({ ...opened, [open.kind]: open });

  return Object.values(opened).map(({ kind, params }) => {
    // Each kind's component takes that kind's parameters, which `opened` keeps by kind.
    const Dialog = dialogs[kind] as ComponentType<DialogComponentProps<DialogKind>> | undefined;
    if (!Dialog) return null;
    const isOpen = open?.kind === kind;
    return (
      <ErrorBoundary
        key={kind}
        source={`dialog.${kind}`}
        fallback={(failure) => (
          <Modal
            isOpen={isOpen}
            onOpenChange={(next) => {
              if (!next) closeDialog();
            }}
            aria-label={t('viewError.title')}
            className="dialog-failure"
          >
            <ViewFailure {...failure} />
          </Modal>
        )}
      >
        <Dialog isOpen={isOpen} params={params} onClose={closeDialog} />
      </ErrorBoundary>
    );
  });
}
