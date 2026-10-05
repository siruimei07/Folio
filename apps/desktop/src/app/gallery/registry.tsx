// A registry for the gallery: the real views, with sample toolbar controls and stand-in dialogs,
// so the whole toolbar and rail show before their lanes land.

import { Archive, Plus } from 'lucide-react';

import { DialogFrame } from '../../components/Dialog/Dialog';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu/Menu';
import { Activity } from '../activity/Activity';
import type { ActivityJob } from '../activity/status';
import { showToast } from '../toasts';
import { type DialogComponentProps, type ShellRegistry, type ToolbarControlProps, VIEWS } from '../registry';
import { SemesterButton } from '../Toolbar';
import { sampleJobs } from './samples';

function jobsFor(state: string | null): { jobs: ActivityJob[]; problems: number | null } {
  const all = sampleJobs(Date.now());
  const finished = all.filter(({ job }) => job.status.state !== 'running' && job.status.state !== 'queued');
  switch (state) {
    case 'hidden':
      return { jobs: finished, problems: 0 };
    case 'problems':
      return { jobs: finished, problems: 7 };
    case 'several':
      return { jobs: all, problems: 0 };
    case 'unknown':
      return {
        jobs: [
          {
            job: {
              id: 'rebuild',
              kind: 'rebuild',
              cancellable: true,
              status: { state: 'running', progress: { done: 8400, total: null, permille: null, bytes: null, current: null } },
            },
          },
          ...finished,
        ],
        problems: null,
      };
    default:
      return { jobs: [all[0], ...finished].filter((item) => item !== undefined), problems: 7 };
  }
}

export function galleryRegistry(activity: string | null): ShellRegistry {
  const { jobs, problems } = jobsFor(activity);

  function SampleActivity({ compact }: ToolbarControlProps) {
    return (
      <Activity
        jobs={jobs}
        problems={problems}
        compact={compact}
        onCancel={(job) => {
          showToast({ tone: 'info', title: `Cancel ${job.kind} (gallery)` });
        }}
        onDetails={(job) => {
          showToast({ tone: 'info', title: `Details of ${job.id} (gallery)` });
        }}
        onViewProblems={() => {
          showToast({ tone: 'info', title: 'View problems (gallery)' });
        }}
      />
    );
  }

  function SampleSemester({ compact }: ToolbarControlProps) {
    return (
      <SemesterButton name="Fall 2026" compact={compact}>
        <Menu aria-label="Semester">
          <MenuItem icon={Plus}>New semester…</MenuItem>
          <MenuSeparator />
          <MenuItem icon={Archive}>Winter 2026</MenuItem>
          <MenuItem icon={Archive}>Fall 2025</MenuItem>
        </Menu>
      </SemesterButton>
    );
  }

  function StandIn({ isOpen, onClose, title }: DialogComponentProps<'search'> & { title: string }) {
    return (
      <DialogFrame isOpen={isOpen} onOpenChange={(open) => {
          if (!open) onClose();
        }} title={title} isDismissable>
        <p>Stand-in for the dialog its lane builds.</p>
      </DialogFrame>
    );
  }

  return {
    views: VIEWS,
    dialogs: {
      search: (props) => <StandIn {...props} title="Search" />,
      librarySettings: (props) => <StandIn {...props} params={undefined} title="Library settings" />,
      appSettings: (props) => <StandIn {...props} params={undefined} title="App settings" />,
    },
    toolbar: { semester: SampleSemester, activity: SampleActivity },
  };
}
