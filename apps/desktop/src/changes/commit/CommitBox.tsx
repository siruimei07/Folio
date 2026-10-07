import './commit.css';

import { useTranslation } from 'react-i18next';

import { MessageButton } from './MessageButton';
import {
  AiNoteView,
  BlockLine,
  CommitButton,
  DescriptionField,
  FailureNote,
  onCommitBoxKey,
  SummaryField,
  useCommitBoxFocus,
  useCommitIds,
  WritingStatus,
} from './parts';
import type { CommitBoxModel } from './useCommitBox';

/**
 * The commit box (workspace-history handoff §4.1): a card at the top of the commit lane. The danger
 * note of a failed commit, the field group (summary, description, and the footer with the AI's
 * status and the message button), the AI's note, the commit button, and why committing waits.
 */
export function CommitBox({ model }: { model: CommitBoxModel }) {
  const { t } = useTranslation('changes');
  const keepFocus = useCommitBoxFocus(model);
  const ids = useCommitIds();
  return (
    <section ref={keepFocus} className="panel commit-box" aria-label={t('commit.label')} onKeyDown={onCommitBoxKey(model)}>
      {model.failure !== null && <FailureNote failure={model.failure} />}
      <div className="commit-box__group">
        <SummaryField model={model} className="commit-box__summary" />
        <DescriptionField model={model} className="commit-box__description" />
        <div className="commit-box__footer">
          <div className="commit-box__status">
            <WritingStatus model={model} id={ids.status} />
          </div>
          <MessageButton model={model} ids={ids} />
        </div>
      </div>
      <AiNoteView model={model} />
      <CommitButton model={model} ids={ids} />
      {model.block !== null && <BlockLine block={model.block} id={ids.reason} />}
    </section>
  );
}
