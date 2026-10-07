// The message button (workspace-history handoff §4.1, §4.2): a split button at the right of the
// commit box's footer, "Generate" with the AI on or "Use template" with it off, and the "Message
// options" chevron; "Stop" while Generate runs; hidden while a commit waits for the AI. In the
// narrow window's bar, one icon button (§4.7). With the AI off nothing mentions DeepSeek.
import { ChevronDown, LayoutTemplate, Settings, Sparkles, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useCanOpenDialog } from '../../app/navigation';
import { Button } from '../../components/Button/Button';
import { IconButton } from '../../components/IconButton/IconButton';
import { Menu, MenuButton, MenuItem, MenuSeparator } from '../../components/Menu/Menu';
import { SIZE } from '../../tokens/tokens';
import { type CommitIds, messageReasonOf, openAiSettings } from './parts';
import type { CommitBoxModel } from './useCommitBox';

/** The options menu's items. */
const WRITE_ITEM = 'write';
const TEMPLATE_ITEM = 'template';
const SETTINGS_ITEM = 'settings';

/**
 * The split button (§4.1): its first part stays one button through Generate and Stop, so it keeps
 * the focus; the options go while Generate runs.
 */
export function MessageButton({ model, ids }: { model: CommitBoxModel; ids: CommitIds }) {
  const { t } = useTranslation('changes');
  const canSettings = useCanOpenDialog('appSettings');
  if (model.writing === 'waiting') return null;
  const reason = messageReasonOf(model, ids);
  const generating = model.writing === 'generating';
  const { on, service } = model.ai;
  return (
    <div className="commit-message" role="group" aria-label={t('commit.message')}>
      {generating ? (
        <Button size="compact" data-commit-focus="message" onPress={model.stop}>
          <Square aria-hidden size={SIZE.iconTiny} className="button__icon" />
          {t('commit.stop')}
        </Button>
      ) : (
        <Button
          size="compact"
          icon={on ? Sparkles : LayoutTemplate}
          isPending={!model.canWrite}
          aria-describedby={reason}
          data-commit-focus="message"
          onPress={on ? model.generate : model.chooseTemplate}
        >
          {on ? t('commit.generate') : t('commit.useTemplate')}
        </Button>
      )}
      {!generating && (
        <MenuButton
          placement="bottom end"
          trigger={
            <IconButton
              icon={ChevronDown}
              label={t('commit.options')}
              variant="outline"
              isPending={model.readOnly}
              aria-describedby={model.readOnly ? ids.commit : undefined}
            />
          }
        >
          <Menu
            aria-label={t('commit.options')}
            disabledKeys={model.canWrite ? [] : [WRITE_ITEM, TEMPLATE_ITEM]}
            onAction={(key) => {
              if (key === WRITE_ITEM) model.generate();
              else if (key === TEMPLATE_ITEM) model.chooseTemplate();
              else if (key === SETTINGS_ITEM) openAiSettings();
            }}
          >
            {on && (
              <MenuItem id={WRITE_ITEM} icon={Sparkles}>
                {t('commit.writeWith', { service: t(`commit.service.${service}`) })}
              </MenuItem>
            )}
            <MenuItem id={TEMPLATE_ITEM} icon={LayoutTemplate}>
              {t('commit.useTheTemplate')}
            </MenuItem>
            {canSettings && <MenuSeparator />}
            {canSettings && (
              <MenuItem id={SETTINGS_ITEM} icon={Settings}>
                {t('commit.aiSettings')}
              </MenuItem>
            )}
          </Menu>
        </MenuButton>
      )}
    </div>
  );
}

/** The narrow bar's message button: one 32 px icon button (§4.7), "Stop" while Generate runs. */
export function MessageIconButton({ model, ids }: { model: CommitBoxModel; ids: CommitIds }) {
  const { t } = useTranslation('changes');
  if (model.writing === 'waiting') return null;
  if (model.writing === 'generating') {
    return <IconButton icon={Square} label={t('commit.stop')} variant="outline" data-commit-focus="message" onPress={model.stop} />;
  }
  const { on } = model.ai;
  return (
    <IconButton
      icon={on ? Sparkles : LayoutTemplate}
      label={on ? t('commit.generateMessage') : t('commit.useTemplate')}
      variant="outline"
      isPending={!model.canWrite}
      aria-describedby={messageReasonOf(model, ids)}
      data-commit-focus="message"
      onPress={on ? model.generate : model.chooseTemplate}
    />
  );
}
