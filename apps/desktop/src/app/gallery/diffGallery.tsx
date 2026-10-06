// Dev server only (gallery.html is not a build input): the diff pane on the fake shell, before the
// Changes and History views host it, for design and accessibility reviews in the browser pane.
//
//   /gallery.html?view=diff&scenario=small|diffs|history-long   the fake shell's scenarios
//   &select=<text>     selects the first row whose label holds the text, like `select=data.csv`
//   &latency=<ms>  &fail=get_workspace_diff:InUse  &theme=dark  &motion=on   as in the browser pane
//
// The list beside the pane holds the workspace's items, its tag and settings changes and the rows
// of the newest commits. Selection follows the keyboard, as in the Changes list, and Enter moves the
// focus into the diff; F7 and Shift+F7 work from anywhere; below 760 px the pane covers the list
// with "Back" (Esc, Alt+Left). History's text and Word rows offer Restore (a toast), disabled with a
// reason on the newest commit's rows; below 600 px of pane it and the toggle are in "More".
// `__FOLIO_FAKE_SHELL__.editFile(path)` in the console sends WorkspaceChanged.
import './diffGallery.css';

import { useQueries, useQuery } from '@tanstack/react-query';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { Header, I18nProvider, ListBox, ListBoxItem, ListBoxSection } from 'react-aria-components';

import { MenuItem } from '../../components/Menu/Menu';
import { Panel } from '../../components/Panel/Panel';
import { createQueryClient } from '../../data/client';
import { DataProvider } from '../../data/DataProvider';
import { unwrap } from '../../data/errors';
import { ipc } from '../../ipc';
import { installFakeShell, optionsFromUrl } from '../../ipc/mock';
import { Announcer } from '../announcer';
import { useLayout } from '../layout';
import { DIFF_PANE, type DiffPaneHandle, type DiffRestore, type DiffTarget } from '../panes';
import { installShortcuts } from '../shortcuts';
import { ToastRegion } from '../ToastRegion';
import { showToast } from '../toasts';

const PAGE = { offset: 0, limit: 500 };

/** Commits whose rows the list shows, newest first. */
const COMMITS = 8;

interface Row {
  id: string;
  label: string;
  target: DiffTarget;
}

interface Section {
  title: string;
  rows: Row[];
}

function useRows(): Section[] {
  const items = useQuery({ queryKey: ['gallery', 'items'], queryFn: () => unwrap(ipc.listWorkspaceItems({ page: PAGE })) });
  const metadata = useQuery({ queryKey: ['gallery', 'metadata'], queryFn: () => unwrap(ipc.listMetadataChanges({ page: PAGE })) });
  const history = useQuery({
    queryKey: ['gallery', 'history'],
    queryFn: () => unwrap(ipc.listHistory({ page: { offset: 0, limit: COMMITS }, types: ['commit'] })),
  });
  const commits = (history.data?.items ?? []).flatMap((entry) => (entry.kind === 'commit' ? [entry.commit] : []));
  const changes = useQueries({
    queries: commits.map((commit) => ({
      queryKey: ['gallery', 'commit', commit.id],
      queryFn: async () => ({
        rows: (await unwrap(ipc.listCommitChanges({ commit: commit.id, page: PAGE }))).items,
        metadata: (await unwrap(ipc.listCommitMetadata({ commit: commit.id, page: PAGE }))).items,
      }),
    })),
  });
  return [
    {
      title: 'Changes',
      rows: (items.data?.items ?? []).map((item) => ({
        id: `item ${item.key}`,
        label: `${item.change} · ${item.path}`,
        target: { kind: 'workspace', item },
      })),
    },
    {
      title: 'Tags and settings',
      rows: (metadata.data?.items ?? []).map((change) => ({
        id: `meta ${change.key}`,
        label: `${change.subject.kind} · ${'path' in change.subject ? change.subject.path : change.change}`,
        target: { kind: 'workspaceMetadata', change },
      })),
    },
    ...commits.map((commit, index) => {
      const answer = changes[index]?.data;
      const title = `${commit.id.slice(3, 10)} ${commit.summary ?? commit.kind}`;
      const rows: Row[] = [
        ...(answer?.rows ?? []).map((row) => ({
          id: `row ${commit.id} ${row.key}`,
          label: `${row.change} · ${row.path}`,
          target: { kind: 'version', commit, row } as const,
        })),
        ...(answer?.metadata ?? []).map((change) => ({
          id: `rowmeta ${commit.id} ${change.key}`,
          label: `${change.subject.kind} · ${change.change}`,
          target: { kind: 'versionMetadata', commit, change } as const,
        })),
      ];
      return { title, rows };
    }),
  ];
}

const MORE = (
  <>
    {['Open with default app', 'Show in File Explorer', 'View history of this file', 'Copy path'].map((label) => (
      <MenuItem
        key={label}
        onAction={() => {
          showToast({ tone: 'info', title: `${label} (gallery)` });
        }}
      >
        {label}
      </MenuItem>
    ))}
  </>
);

/**
 * History's Restore, roughly as the History view will offer it: stored text and Word versions, and
 * disabled with its reason on the newest commit's rows (a stand-in for "the version you have now").
 */
function restoreOf(target: DiffTarget, newest: string | null): DiffRestore | undefined {
  if (target.kind !== 'version') return undefined;
  const { row } = target;
  if (row.kind !== 'file' || row.after === null || !row.after.stored || row.after.pruned) return undefined;
  if (row.class !== 'text' && row.class !== 'word') return undefined;
  const onRestore = () => {
    showToast({ tone: 'info', title: `Restore ${row.path} (gallery)` });
  };
  return target.commit.id === newest ? { onRestore, disabledReason: 'This is the version you have now.' } : { onRestore };
}

function DiffHarness({ select }: { select: string | null }) {
  const sections = useRows();
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const newest = rows.find((row) => row.target.kind === 'version')?.target;
  const newestId = newest?.kind === 'version' ? newest.commit.id : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const narrow = useLayout() === 'narrow';
  const selected =
    rows.find((row) => row.id === chosen) ??
    (chosen === null && select !== null ? rows.find((row) => row.label.includes(select)) : undefined);
  const Pane = DIFF_PANE;
  const paneRef = useRef<DiffPaneHandle>(null);
  useEffect(() => installShortcuts(), []);

  const list = (
    <Panel title="Rows" count={rows.length} className="diff-gallery__list">
      <ListBox
        aria-label="Rows"
        className="diff-gallery__rows"
        selectionMode="single"
        selectionBehavior="replace"
        selectedKeys={selected === undefined ? [] : [selected.id]}
        onSelectionChange={(keys) => {
          if (keys === 'all') return;
          const [key] = [...keys];
          if (key !== undefined) {
            setChosen(String(key));
            setOpen(true);
          }
        }}
        onAction={() => {
          paneRef.current?.focus();
        }}
      >
        {sections.map((section) => (
          <ListBoxSection key={section.title} className="diff-gallery__section">
            <Header className="diff-gallery__header">{section.title}</Header>
            {section.rows.map((row) => (
              <ListBoxItem key={row.id} id={row.id} textValue={row.label} className="diff-gallery__row">
                {row.label}
              </ListBoxItem>
            ))}
          </ListBoxSection>
        ))}
      </ListBox>
    </Panel>
  );
  const pane =
    selected === undefined ? (
      <p className="diff-gallery__empty">Select a row.</p>
    ) : (
      <Pane
        ref={paneRef}
        target={selected.target}
        actions={{
          open: (entry) => {
            showToast({ tone: 'info', title: `Open ${entry.path} (gallery)` });
          },
        }}
        moreItems={MORE}
        restore={restoreOf(selected.target, newestId)}
        back={
          narrow
            ? {
                label: selected.target.kind.startsWith('version') ? 'Back to history' : 'Back to changes',
                onBack: () => {
                  setOpen(false);
                },
              }
            : undefined
        }
      />
    );
  return (
    <div className="diff-gallery">
      {(!narrow || !open || selected === undefined) && list}
      {(!narrow || (open && selected !== undefined)) && <div className="panel diff-gallery__pane">{pane}</div>}
    </div>
  );
}

/** Installs the fake shell from the page's URL and returns the harness with the app's providers. */
export function diffGallery(search: string): ReactElement {
  installFakeShell(optionsFromUrl(search));
  const select = new URLSearchParams(search).get('select');
  return (
    <DataProvider client={createQueryClient()}>
      <I18nProvider locale="en">
        <DiffHarness select={select} />
        <ToastRegion />
        <Announcer />
      </I18nProvider>
    </DataProvider>
  );
}
