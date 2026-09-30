import '../motion.css';
import './Dialog.css';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog as AriaDialog, Heading, Modal as AriaModal, ModalOverlay } from 'react-aria-components';

import { IconButton } from '../IconButton/IconButton';

/** The window's bar: a press on it never closes a dismissable dialog. */
export const WINDOW_BAR_ATTRIBUTE = 'data-window-bar';

/**
 * React Aria's marker for what stays usable over a modal: while a dialog or modal popover is
 * open, React Aria makes everything else inert, except elements with this attribute, which keep
 * clicks, focus and their place in the accessibility tree (the caption buttons, the toasts).
 */
export const TOP_LAYER_ATTRIBUTE = 'data-react-aria-top-layer';

/** On every open modal's overlay, so the app can tell that one is open. */
export const MODAL_ATTRIBUTE = 'data-modal';

/** Whether a modal dialog is on screen, including one that is closing. */
export function isModalOpen(): boolean {
  return document.querySelector(`[${MODAL_ATTRIBUTE}]`) !== null;
}

export interface ModalProps {
  isOpen: boolean;
  /** Called with `false` for Esc, the close button and, when `isDismissable`, the scrim. */
  onOpenChange: (isOpen: boolean) => void;
  /** Closes on a click on the scrim (never on the window's bar). */
  isDismissable?: boolean;
  /** modal: settings, import, confirmations; search: the darker scrim of the search dialog. */
  scrim?: 'modal' | 'search';
  /** Positions and sizes the frame, like `import-dialog`. */
  className?: string;
  /** Names the dialog when it has no `Heading slot="title"`. */
  'aria-label'?: string;
  children: ReactNode;
}

/**
 * A modal dialog over a scrim that starts below the window's bar, so the caption buttons stay
 * usable and never close it (UI architecture §7.1). Focus is trapped inside and returns to where
 * it was when the dialog closes. Fades and rises 4 px (library-actions handoff §13).
 */
export function Modal({
  isOpen,
  onOpenChange,
  isDismissable = false,
  scrim = 'modal',
  className,
  children,
  ...labelling
}: ModalProps) {
  return (
    <ModalOverlay
      className="modal-overlay"
      {...{ [MODAL_ATTRIBUTE]: '' }}
      data-scrim={scrim}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      shouldCloseOnInteractOutside={(element) => !element.closest(`[${WINDOW_BAR_ATTRIBUTE}]`)}
    >
      <AriaModal className={className === undefined ? 'modal' : `modal ${className}`}>
        <AriaDialog className="modal__dialog" {...labelling}>
          {children}
        </AriaDialog>
      </AriaModal>
    </ModalOverlay>
  );
}

export interface DialogFrameProps extends Omit<ModalProps, 'children' | 'aria-label'> {
  title: string;
  /** small 440 px (confirmations), medium 560 px (import, results), large 720 × 560 (problems). */
  size?: 'small' | 'medium' | 'large';
  /** Under the header, before the body: a block banner for an error. */
  banner?: ReactNode;
  /** Buttons on the right, the primary last. */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The dialog frame (library-actions handoff §2.8): header with the title and a close button
 * ("Close (Esc)"), a scrolling body and a sunken footer.
 */
export function DialogFrame({ title, size = 'small', banner, footer, children, className, ...modal }: DialogFrameProps) {
  const { t } = useTranslation('common');
  return (
    <Modal {...modal} className={`dialog-frame${className === undefined ? '' : ` ${className}`}`}>
      <div className="dialog-frame__frame" data-size={size}>
        <header className="dialog-frame__header">
          <Heading slot="title" className="dialog-frame__title">
            {title}
          </Heading>
          <IconButton
            icon={X}
            label={t('closeDialog')}
            onPress={() => {
              modal.onOpenChange(false);
            }}
          />
        </header>
        {banner !== undefined && <div className="dialog-frame__banner">{banner}</div>}
        <div className="dialog-frame__body">{children}</div>
        {footer !== undefined && <footer className="dialog-frame__footer">{footer}</footer>}
      </div>
    </Modal>
  );
}
