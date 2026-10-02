import { ChevronLeft, ChevronRight, Minus, MoveHorizontal, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Toolbar } from 'react-aria-components';

import { Tooltip } from '../components/Tooltip/Tooltip';
import { SIZE } from '../tokens/tokens';
import type { PdfState } from './PreviewFrame';
import { PDF_ZOOM_MAX, PDF_ZOOM_MIN, type PdfCommand } from './protocol';

/** Zoom steps of the pill's − and + buttons, in percent. */
const STEPS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];

function nextZoom(percent: number, direction: 1 | -1): number {
  const step =
    direction === 1 ? STEPS.find((value) => value > percent) : STEPS.findLast((value) => value < percent);
  return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, step ?? percent));
}

interface PillButtonProps {
  label: string;
  icon: typeof Plus;
  isDisabled?: boolean;
  onPress: () => void;
}

function PillButton({ label, icon: Icon, isDisabled, onPress }: PillButtonProps) {
  return (
    <Tooltip content={label} placement="top">
      <Button className="pdf-pill__button" aria-label={label} isDisabled={isDisabled} onPress={onPress}>
        <Icon aria-hidden size={SIZE.iconSmall} />
      </Button>
    </Tooltip>
  );
}

export interface PdfPillProps {
  state: PdfState;
  command: (command: Omit<PdfCommand, 'kind'>) => void;
}

/**
 * The PDF's page and zoom pill, "1 / 4 · 100%" (app-shell §5), drawn by the window so its text and
 * focus stay here (UI architecture §10.3): previous and next page, zoom out and in, fit to width.
 */
export function PdfPill({ state, command }: PdfPillProps) {
  const { t } = useTranslation('preview');
  const { page, pages, percent } = state;
  return (
    <Toolbar className="pdf-pill" aria-label={t('pdf.controls')}>
      <PillButton
        label={t('pdf.previous')}
        icon={ChevronLeft}
        isDisabled={page <= 1}
        onPress={() => {
          command({ goToPage: page - 1 });
        }}
      />
      <span className="pdf-pill__text">
        <span aria-hidden>{t('pdf.page', { page, pages })}</span>
        <span className="visually-hidden">{t('pdf.pageLabel', { page, pages })}</span>
      </span>
      <PillButton
        label={t('pdf.next')}
        icon={ChevronRight}
        isDisabled={page >= pages}
        onPress={() => {
          command({ goToPage: page + 1 });
        }}
      />
      <span className="pdf-pill__divider" aria-hidden />
      <PillButton
        label={t('pdf.zoomOut')}
        icon={Minus}
        isDisabled={percent <= PDF_ZOOM_MIN}
        onPress={() => {
          command({ zoom: nextZoom(percent, -1) });
        }}
      />
      <span className="pdf-pill__text pdf-pill__zoom">{t('pdf.zoom', { percent })}</span>
      <PillButton
        label={t('pdf.zoomIn')}
        icon={Plus}
        isDisabled={percent >= PDF_ZOOM_MAX}
        onPress={() => {
          command({ zoom: nextZoom(percent, 1) });
        }}
      />
      <PillButton
        label={t('pdf.fitWidth')}
        icon={MoveHorizontal}
        onPress={() => {
          command({ zoom: 'fit-width' });
        }}
      />
    </Toolbar>
  );
}
