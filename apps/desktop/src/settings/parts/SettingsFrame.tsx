import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading, type Key, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';

import { useLayout } from '../../app/layout';
import { Modal } from '../../components/Dialog/Dialog';
import { IconButton } from '../../components/IconButton/IconButton';
import { SelectionIndicator } from '../../components/SelectionIndicator/SelectionIndicator';
import { SIZE } from '../../tokens/tokens';

export interface SettingsPage<Id extends string> {
  id: Id;
  label: string;
  icon: LucideIcon;
  content: ReactNode;
  /**
   * Stays mounted while another page shows, so what the user typed there survives a look at
   * another page (the device name, the ignore rules). Other pages mount when shown.
   */
  keepMounted?: boolean;
}

export interface SettingsFrameProps<Id extends string> {
  isOpen: boolean;
  onClose: () => void;
  /** "Library settings" or "App settings": names the dialog. */
  title: string;
  pages: readonly SettingsPage<Id>[];
  page: Id;
  onPageChange: (page: Id) => void;
  /**
   * Dialogs opened over this one ("New semester…"). They render inside it, so its focus scope
   * lets focus into them and takes it back when they close.
   */
  children?: ReactNode;
}

/**
 * The frame of both settings dialogs (app-shell handoff §9, 25A): a modal over the scrim, the
 * navigation card with the title, the close button and one item per page, and the page's cards.
 * The items are a vertical tab list, so arrow keys move between pages; focus starts on the
 * active one. Esc, × and the scrim close it, and focus returns to the gear or the avatar.
 */
export function SettingsFrame<Id extends string>({
  isOpen,
  onClose,
  title,
  pages,
  page,
  onPageChange,
  children,
}: SettingsFrameProps<Id>) {
  const { t } = useTranslation(['settings', 'common']);
  const narrow = useLayout() === 'narrow';
  const tabs = useRef<HTMLDivElement>(null);

  // Focus starts on the active page's item (§9), not on the close button before it.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      tabs.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [isOpen]);

  const select = (key: Key) => {
    const next = pages.find(({ id }) => id === key);
    if (next !== undefined) onPageChange(next.id);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="settings-dialog"
    >
      <Tabs
        className="settings"
        orientation={narrow ? 'horizontal' : 'vertical'}
        selectedKey={page}
        onSelectionChange={select}
      >
        <div className="settings__nav">
          <div className="settings__nav-header">
            <Heading slot="title" className="settings__title">
              {title}
            </Heading>
            <IconButton icon={X} label={t('common:closeDialog')} onPress={onClose} />
          </div>
          <div ref={tabs} className="settings__tabs-scroll">
            <TabList className="settings__tabs" aria-label={t('nav', { title })}>
              {pages.map(({ id, label, icon: Icon }) => (
                <Tab key={id} id={id} className="settings__tab">
                  {({ isSelected }) => (
                    <>
                      {isSelected && <SelectionIndicator placement="tab" />}
                      <Icon aria-hidden size={SIZE.icon} className="settings__tab-icon" />
                      <span className="settings__tab-label">{label}</span>
                    </>
                  )}
                </Tab>
              ))}
            </TabList>
          </div>
        </div>
        {pages.map(({ id, label, content, keepMounted }) => (
          <TabPanel key={id} id={id} className="settings__page" shouldForceMount={keepMounted}>
            <h3 className="visually-hidden">{label}</h3>
            {content}
          </TabPanel>
        ))}
      </Tabs>
      {children}
    </Modal>
  );
}
