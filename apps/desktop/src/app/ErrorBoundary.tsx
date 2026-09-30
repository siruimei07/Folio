import { TriangleAlert } from 'lucide-react';
import { Component, Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/Button/Button';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { describeError } from './log';
import { copyDetails } from './windowErrors';

export interface ViewFailureProps {
  error: unknown;
  /** Mounts the view again from scratch. */
  reload: () => void;
  /** view: a rail view or dialog; preview: the preview pane. */
  kind?: 'view' | 'preview';
}

/**
 * What a view shows when it stopped working (library-actions handoff §9.6): "Reload this view"
 * and "Copy details", in place of the `Internal` message, which asks for a restart first.
 */
export function ViewFailure({ error, reload, kind = 'view' }: ViewFailureProps) {
  const { t } = useTranslation('shell');
  const title = t(kind === 'preview' ? 'viewError.previewTitle' : 'viewError.title');
  return (
    <StateBlock
      tone="danger"
      icon={TriangleAlert}
      title={title}
      text={t('viewError.text')}
      placement="preview"
      actions={
        <>
          <Button variant="accent" onPress={reload}>
            {t('viewError.reload')}
          </Button>
          <Button
            onPress={() => {
              const { message, stack } = describeError(error);
              copyDetails([title, message, stack].filter((part) => part !== null).join('\n'));
            }}
          >
            {t('copyDetails.action')}
          </Button>
        </>
      }
    />
  );
}

export interface ErrorBoundaryProps {
  /** Names the view in the log, like `view.library` or `dialog.search`. */
  source: string;
  kind?: ViewFailureProps['kind'];
  /** Replaces the default failure block, for example to keep a dialog's frame. */
  fallback?: (props: ViewFailureProps) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
  failed: boolean;
  /** Changes on "Reload this view", so the children mount from scratch. */
  generation: number;
}

/**
 * Each rail view, dialog and the preview sits in one (UI architecture §13). React reports what it
 * catches to the root's `onCaughtError`, which logs it with this boundary's `source`.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, failed: false, generation: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error, failed: true };
  }

  private readonly reload = () => {
    this.setState(({ generation }) => ({ error: null, failed: false, generation: generation + 1 }));
  };

  override render() {
    const { kind, fallback, children } = this.props;
    const { error, failed, generation } = this.state;
    if (failed) {
      const props = { error, reload: this.reload, kind };
      return fallback ? fallback(props) : <ViewFailure {...props} />;
    }
    return <Fragment key={generation}>{children}</Fragment>;
  }
}

/** The `source` of the boundary that caught an error, for the log. */
export function boundarySource(info: { errorBoundary?: unknown }): string {
  return info.errorBoundary instanceof ErrorBoundary ? info.errorBoundary.props.source : 'boundary';
}
