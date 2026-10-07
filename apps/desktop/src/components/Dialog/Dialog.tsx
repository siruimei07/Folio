import '../motion.css';
import './Dialog.css';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
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

/**
 * Where a dialog's top edge sits (workspace-history handoff §8.5), so it stays put when its
 * content grows: a form dialog `size.dialog-top-form` (96 px) from the window's top, a
 * confirmation `size.dialog-top-confirmation` (220 px). A window too short for that centres the
 * dialog, but never closer to the bar than the overlay's top margin. A frame of a fixed size
 * (settings, app-shell §9) is centred: `center`.
 */
export type DialogPlacement = 'form' | 'confirmation' | 'center';

export interface ModalProps {
  isOpen: boolean;
  /** Called with `false` for Esc, the close button and, when `isDismissable`, the scrim. */
  onOpenChange: (isOpen: boolean) => void;
  /** Closes on a click on the scrim (never on the window's bar). */
  isDismissable?: boolean;
  /** modal: settings, import, confirmations; search: the darker scrim of the search dialog. */
  scrim?: 'modal' | 'search';
  /** Where its top edge sits; centred unless said. The search scrim places its dialog itself. */
  placement?: DialogPlacement;
  /** Positions and sizes the frame, like `import-dialog`. */
  className?: string;
  /** Names the dialog when it has no `Heading slot="title"`. */
  'aria-label'?: string;
  /** The element that describes the dialog, read after its name. */
  'aria-describedby'?: string;
  /** alertdialog: a confirmation that interrupts the user, read with its description. */
  role?: 'dialog' | 'alertdialog';
  children: ReactNode;
}

/**
 * A modal dialog over a scrim that starts below the window's bar, so the caption buttons stay
 * usable and never close it (UI architecture §7.1), its top edge placed by `placement`. Focus is
 * trapped inside and returns to where it was when the dialog closes. Fades and rises 4 px
 * (library-actions handoff §13).
 */
export function Modal({
  isOpen,
  onOpenChange,
  isDismissable = false,
  scrim = 'modal',
  placement = 'center',
  className,
  children,
  ...labelling
}: ModalProps) {
  return (
    <ModalOverlay
      className="modal-overlay"
      {...{ [MODAL_ATTRIBUTE]: '' }}
      data-scrim={scrim}
      data-placement={scrim === 'search' ? undefined : placement}
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

/**
 * `aria-describedby` names an element of the body that describes the dialog (a confirmation's
 * message there, read with an alert dialog's name); `description` takes its place when given.
 */
export interface DialogFrameProps extends Omit<ModalProps, 'children' | 'aria-label'> {
  title: string;
  /** After the title, like the problems list's count pill. */
  titleAside?: ReactNode;
  /**
   * Focus starts on the title (`tabindex="-1"`) instead of the first control, so a screen reader
   * reads the name and the description first (the problems list).
   */
  focusTitle?: boolean;
  /** A line under the header that describes the dialog (`aria-describedby`). */
  description?: ReactNode;
  /** small 440 px (confirmations), medium 560 px (import, results), large 720 × 560 (problems). */
  size?: 'small' | 'medium' | 'large';
  /** `confirmation` for a small dialog, else `form`; a small form (Move, a tag) says `form`. */
  placement?: DialogPlacement;
  /** A body without padding, for content that runs to the frame's edges (the problems list). */
  flush?: boolean;
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
export function DialogFrame({
  title,
  titleAside,
  focusTitle = false,
  description,
  size = 'small',
  placement = size === 'small' ? 'confirmation' : 'form',
  flush = false,
  banner,
  footer,
  children,
  className,
  ...modal
}: DialogFrameProps) {
  const { t } = useTranslation('common');
  const descriptionId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // After React Aria has moved focus into the dialog, as Library settings does for its tab.
  useEffect(() => {
    if (!modal.isOpen || !focusTitle) return;
    const frame = requestAnimationFrame(() => {
      heading.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [modal.isOpen, focusTitle]);

  return (
    <Modal
      {...modal}
      placement={placement}
      aria-describedby={description === undefined ? modal['aria-describedby'] : descriptionId}
      className={`dialog-frame${className === undefined ? '' : ` ${className}`}`}
    >
      <div className="dialog-frame__frame" data-size={size}>
        <header className="dialog-frame__header">
          {/* One parent always, so the title keeps its focus when the aside comes or goes. */}
          <div className="dialog-frame__heading">
            <Heading slot="title" ref={heading} className="dialog-frame__title" tabIndex={focusTitle ? -1 : undefined}>
              {title}
            </Heading>
            {titleAside}
          </div>
          <IconButton
            icon={X}
            label={t('closeDialog')}
            onPress={() => {
              modal.onOpenChange(false);
            }}
          />
        </header>
        {description !== undefined && (
          <p id={descriptionId} className="dialog-frame__description">
            {description}
          </p>
        )}
        {banner !== undefined && <div className="dialog-frame__banner">{banner}</div>}
        <div className="dialog-frame__body" data-flush={flush || undefined}>
          {children}
        </div>
        {footer !== undefined && <footer className="dialog-frame__footer">{footer}</footer>}
      </div>
    </Modal>
  );
}
