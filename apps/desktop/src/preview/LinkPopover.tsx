import { Copy } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from 'react-aria-components';

import { copyText } from '../app/clipboard';
import { showToast } from '../app/toasts';
import { Button } from '../components/Button/Button';
import { Popover } from '../components/Popover/Popover';
import type { FrameLink } from './PreviewFrame';

export interface LinkPopoverProps {
  /** The clicked link; its `rect` is in the frame's viewport, and the frame fills its container. */
  link: FrameLink | null;
  onClose: () => void;
}

/**
 * A clicked link's address next to it, with "Copy address" (ADR-0005, product decision 2): links
 * in previews never open, and only the window has the clipboard (UI architecture §10.4).
 */
export function LinkPopover({ link, onClose }: LinkPopoverProps) {
  const { t } = useTranslation('preview');
  const anchorRef = useRef<HTMLSpanElement>(null);
  const rect = link?.rect;
  return (
    <>
      <span
        ref={anchorRef}
        className="link-anchor"
        aria-hidden
        style={rect === undefined ? undefined : { left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      />
      <Popover
        triggerRef={anchorRef}
        isOpen={link !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        placement="bottom start"
        className="link-popover"
      >
        <Dialog className="link-popover__dialog" aria-label={t('link.label')}>
          <p className="link-popover__address">{link?.href}</p>
          <p className="link-popover__note">{t('link.note')}</p>
          <Button
            icon={Copy}
            size="compact"
            autoFocus
            onPress={() => {
              const href = link?.href ?? '';
              onClose();
              void copyText(href).then((copied) => {
                showToast(
                  copied ? { tone: 'info', title: t('link.copied') } : { tone: 'danger', title: t('link.copyFailed') },
                );
              });
            }}
          >
            {t('link.copy')}
          </Button>
        </Dialog>
      </Popover>
    </>
  );
}
