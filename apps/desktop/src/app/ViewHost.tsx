import { Activity as ReactActivity, useState } from 'react';

import { ErrorBoundary } from './ErrorBoundary';
import { useNavigation, type ViewId } from './navigation';
import type { ViewDefinition } from './registry';

/**
 * The rail views (UI architecture §6.2). A view mounts the first time it is shown; after that it
 * stays mounted inside React's `<Activity>`, hidden while another view shows, so it keeps its
 * state and DOM while its effects and queries rest. Each sits in its own error boundary.
 */
export function ViewHost({ views }: { views: readonly ViewDefinition[] }) {
  const active = useNavigation((state) => state.view);
  const [visited, setVisited] = useState<readonly ViewId[]>([active]);
  if (!visited.includes(active)) setVisited([...visited, active]);

  return views
    .filter(({ id }) => visited.includes(id))
    .map(({ id, component: View }) => (
      <ReactActivity key={id} mode={id === active ? 'visible' : 'hidden'}>
        <ErrorBoundary source={`view.${id}`}>
          <View />
        </ErrorBoundary>
      </ReactActivity>
    ));
}
