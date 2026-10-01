import { DeskIllustration } from '../../components/DeskIllustration/DeskIllustration';

export interface EmptyPreviewProps {
  title: string;
  text: string;
}

/**
 * The preview with nothing to show (app-shell handoff §5, 9C): the desk illustration on the dot
 * grid, then what to do. Read in place: it is what the region holds, not news.
 */
export function EmptyPreview({ title, text }: EmptyPreviewProps) {
  return (
    <div className="empty-preview">
      <DeskIllustration />
      <div className="empty-preview__words">
        <p className="empty-preview__title">{title}</p>
        <p className="empty-preview__text">{text}</p>
      </div>
    </div>
  );
}
