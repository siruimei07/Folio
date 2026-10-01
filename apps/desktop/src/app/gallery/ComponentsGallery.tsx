import './gallery.css';

import {
  Copy,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  Grid2x2,
  List,
  ListTree,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import { Callout } from '../../components/Callout/Callout';
import { ChangeStatusIcon } from '../../components/ChangeStatusIcon/ChangeStatusIcon';
import { CountPill } from '../../components/CountPill/CountPill';
import { CourseBadge } from '../../components/CourseBadge/CourseBadge';
import { CourseLabel } from '../../components/CourseLabel/CourseLabel';
import { DialogFrame } from '../../components/Dialog/Dialog';
import { FieldError } from '../../components/FieldError/FieldError';
import { FileTypeIcon } from '../../components/FileTypeIcon/FileTypeIcon';
import { IconButton } from '../../components/IconButton/IconButton';
import { KeyCap } from '../../components/KeyCap/KeyCap';
import {
  ContextMenu,
  Menu,
  type MenuAnchor,
  MenuButton,
  MenuItem,
  MenuSeparator,
  Submenu,
  useContextMenuTrigger,
} from '../../components/Menu/Menu';
import { Panel } from '../../components/Panel/Panel';
import { ProgressBar, ProgressRing, Spinner } from '../../components/Progress/Progress';
import { SegmentedControl } from '../../components/SegmentedControl/SegmentedControl';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { StateBlock } from '../../components/StateBlock/StateBlock';
import { TagChipList, TagToggle } from '../../components/TagChip/TagChip';
import { TagDot } from '../../components/TagDot/TagDot';
import { Toast } from '../../components/Toast/Toast';
import { ActivityPanel } from '../activity/Activity';
import { showToast } from '../toasts';
import { ToastRegion } from '../ToastRegion';
import { showWindowFailure } from '../windowErrors';
import { SAMPLE_COURSES, SAMPLE_TAGS, sampleJobs } from './samples';

const FILES = ['Lecture 7.pdf', 'ps2.docx', 'Week 3.pptx', 'grades.xlsx', 'notes.md', 'Main.java', 'figure.png', 'lecture.m4a', 'demo.mp4', 'lab.zip', 'readme.txt', 'data.bin'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery__section">
      <h2 className="gallery__title">{title}</h2>
      <div className="gallery__row">{children}</div>
    </section>
  );
}

function ContextArea() {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { contextMenuProps } = useContextMenuTrigger((point) => {
    setAnchor(point);
  });
  return (
    <>
      <div className="gallery__context" tabIndex={0} {...contextMenuProps}>
        Right-click or Shift+F10 here
      </div>
      <ContextMenu
        anchor={anchor}
        label="File"
        onClose={() => {
          setAnchor(null);
        }}
      >
        <Menu aria-label="File" autoFocus="first">
          <MenuItem icon={ExternalLink}>Open with default app</MenuItem>
          <MenuItem icon={FolderSearch}>Show in File Explorer</MenuItem>
          <MenuSeparator />
          <Submenu trigger={<MenuItem icon={Tag}>Tags</MenuItem>}>
            <Menu aria-label="Tags" selectionMode="multiple" defaultSelectedKeys={['Notes']}>
              {SAMPLE_TAGS.map((tag) => (
                <MenuItem key={tag.id} id={tag.name} icon={<TagDot color={tag.color} />} mixed={tag.name === 'Exams'}>
                  {tag.name}
                </MenuItem>
              ))}
            </Menu>
          </Submenu>
          <MenuItem icon={Pencil} shortcut="F2">
            Rename
          </MenuItem>
          <MenuItem icon={Copy} shortcut="Ctrl+Shift+C">
            Copy path
          </MenuItem>
          <MenuItem icon={Plus} isDisabled>
            Add files…
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash} shortcut="Del" destructive>
            Delete
          </MenuItem>
        </Menu>
      </ContextMenu>
    </>
  );
}

export function ComponentsGallery() {
  const [segment, setSegment] = useState<'list' | 'tree'>('tree');
  const [grid, setGrid] = useState<'list' | 'grid'>('grid');
  const [selectedTags, setSelectedTags] = useState<string[]>(['t2']);
  const [dialog, setDialog] = useState<'small' | 'large' | null>(null);
  const [now] = useState(() => Date.now());

  return (
    <main className="gallery">
      <h1 className="gallery__title">Folio components</h1>
      <Section title="Buttons">
        <Button variant="primary" icon={RefreshCw}>
          Sync
        </Button>
        <Button variant="accent">Save</Button>
        <Button>Cancel</Button>
        <Button variant="danger">Delete course</Button>
        <Button variant="link">Details</Button>
        <Button isDisabled>Nothing selected</Button>
        <Button size="compact">View problems</Button>
        <Button size="dialog" variant="accent">
          Add 12 files
        </Button>
        <IconButton icon={Plus} label="Add files" shortcut="Ctrl+O" />
        <IconButton icon={FolderOpen} label="Open in File Explorer" size="small" />
        <IconButton icon={FolderSearch} label="Search" variant="outline" />
        <SegmentedControl
          label="Library view"
          selected={segment}
          onChange={setSegment}
          segments={[
            { id: 'list', label: 'List', icon: List },
            { id: 'tree', label: 'Tree', icon: ListTree },
          ]}
        />
        <SegmentedControl
          label="Show as"
          selected={grid}
          onChange={setGrid}
          segments={[
            { id: 'list', label: 'List' },
            { id: 'grid', label: 'Grid', icon: Grid2x2 },
          ]}
        />
      </Section>

      <Section title="Courses, tags, files">
        {SAMPLE_COURSES.map((course) => (
          <span key={course.name} className="gallery__inline">
            <CourseBadge course={course} />
            <CourseBadge course={course} size="compact" />
            <CourseBadge course={course} size="mini" />
            <CourseLabel course={course} />
            <CountPill count={course.files} />
          </span>
        ))}
        <KeyCap keys="Ctrl K" />
        <KeyCap keys="Esc" />
        <span className="gallery__inline" role="img" aria-label="Tags: Notes, Exams">
          <TagDot color="blue" />
          <TagDot color="red" />
          <TagDot color="unknown" />
        </span>
        <TagToggle tag={null} isSelected={selectedTags.length === 0} onChange={() => { setSelectedTags([]); }}>
          All
        </TagToggle>
        {SAMPLE_TAGS.map((tag) => (
          <TagToggle
            key={tag.id}
            tag={tag}
            isSelected={selectedTags.includes(tag.id)}
            onChange={(on) => {
              setSelectedTags((tags) => (on ? [...tags, tag.id] : tags.filter((id) => id !== tag.id)));
            }}
          />
        ))}
        <TagChipList label="Tags" tags={SAMPLE_TAGS.slice(0, 2)} onRemove={(id) => { showToast({ tone: 'info', title: `Remove ${id}` }); }} />
        {FILES.map((name) => (
          <span key={name} className="gallery__inline">
            <FileTypeIcon name={name} />
            {name}
          </span>
        ))}
        <ChangeStatusIcon status="added" />
        <ChangeStatusIcon status="modified" />
        <ChangeStatusIcon status="deleted" />
        <ChangeStatusIcon status="renamed" />
      </Section>

      <Section title="Banners, fields, callouts">
        <div className="gallery__column">
          <Banner
            tone="warning"
            icon={Lock}
            title="Read-only for now."
            text="A newer version of Folio changed this library's settings. You can browse and search; update Folio to change tags and courses."
          />
          <Banner tone="info" title="Rebuilding the search index." text="Some files may be missing from search until it finishes. Changes are paused." />
          <Banner tone="info" title="Folio rebuilt its index for this library." text="Your files and tags are safe." onDismiss={() => undefined} />
          <Banner
            tone="warning"
            size="block"
            title="Choose or drop the files again"
            text="A selection lasts 10 minutes, and this one ran out. Nothing was added."
            actions={<Button size="compact">Choose files…</Button>}
            announce
          />
          <Banner tone="danger" size="block" title="Folio couldn't check these files" text="Something went wrong inside Folio." announce />
        </div>
        <div className="gallery__column">
          <label className="gallery__field">
            Device name
            <input aria-invalid="true" aria-describedby="device-error" defaultValue="G16:" />
          </label>
          <FieldError id="device-error">A name can't contain \ / : * ? " &lt; &gt; |</FieldError>
          <div className="gallery__callout-host">
            <input aria-label="New name" aria-describedby="rename-error" aria-invalid="true" defaultValue="ps3:solutions.docx" />
            <Callout id="rename-error">A name can't contain \ / : * ? &quot; &lt; &gt; |</Callout>
          </div>
        </div>
      </Section>

      <Section title="State blocks">
        <Panel title="Library" count={0} className="gallery__panel">
          <StateBlock
            icon={FolderOpen}
            title="No courses in Winter 2027"
            text="Add the courses you're taking. Folio makes a folder for each one inside Winter 2027."
            actions={<Button variant="accent">Add courses</Button>}
            hint="Or switch semesters in the menu above."
          />
        </Panel>
        <Panel title="Library (failed)" className="gallery__panel">
          <StateBlock
            tone="danger"
            icon={FolderOpen}
            title="Couldn't load your courses"
            text="Something went wrong while reading or writing files. Try again."
            actions={<Button icon={RefreshCw}>Try again</Button>}
          />
        </Panel>
        <Panel title="Loading" className="gallery__panel">
          <Skeleton rows={4} />
          <StateBlock icon={RefreshCw} spinning title="Reading your library…" text="Courses show up here as Folio finds them." />
        </Panel>
      </Section>

      <Section title="Progress and toasts">
        <div className="gallery__column">
          <ProgressBar label="Adding files" value={58} />
          <ProgressBar label="Rebuilding" value={null} />
          <span className="gallery__inline">
            <ProgressRing value={38} />
            <ProgressRing value={null} />
            <Spinner />
          </span>
        </div>
        <div className="gallery__column">
          <Toast tone="success" title="Added 12 files to MAT232" body="3 replaced · 1 kept as a copy" actions={[{ label: 'Show', onPress: () => undefined }]} onDismiss={() => undefined} />
          <Toast tone="progress" title="Adding 12 files to MAT232" body="7 of 12 · Lecture 7 Lagrange Examples.pptx" progress={58} actions={[{ label: 'Cancel', onPress: () => undefined }]} dismissLabel="hide" onDismiss={() => undefined} />
          <Toast tone="danger" title="Couldn't maximize the window" body="Press Windows+Up to maximize it instead. If window buttons keep failing, restart Folio." actions={[{ label: 'Copy details', onPress: () => undefined }]} onDismiss={() => undefined} />
        </div>
        <div className="gallery__column">
          <Button onPress={() => showToast({ tone: 'success', title: 'Moved 3 items to MAT232 / Problem sets' })}>Success toast</Button>
          <Button onPress={() => showToast({ tone: 'warning', title: 'Deleted 2 of 3 items', actions: [{ label: 'Details', onPress: () => undefined }] })}>Warning toast</Button>
          <Button onPress={() => showToast({ tone: 'info', title: 'Copied the path' })}>Info toast</Button>
          <Button onPress={() => { showWindowFailure({ command: 'maximize', source: 'windowControls.toggleMaximize', error: { code: 'Window', detail: 'gallery' } }); }}>
            Window failure
          </Button>
        </div>
      </Section>

      <Section title="Menus and dialogs">
        <MenuButton trigger={<Button>More</Button>}>
          <Menu aria-label="More">
            <MenuItem icon={Pencil} shortcut="F2">Rename</MenuItem>
            <MenuItem icon={Copy} shortcut="Ctrl+Shift+C">Copy path</MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash} shortcut="Del" destructive>Delete</MenuItem>
          </Menu>
        </MenuButton>
        <ContextArea />
        <Button onPress={() => { setDialog('small'); }}>Confirm dialog</Button>
        <Button onPress={() => { setDialog('large'); }}>Large dialog</Button>
        <DialogFrame
          isOpen={dialog === 'small'}
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          title="Delete MAT232?"
          footer={
            <>
              <Button size="dialog" autoFocus onPress={() => { setDialog(null); }}>Cancel</Button>
              <Button size="dialog" variant="danger" onPress={() => { setDialog(null); }}>Delete course</Button>
            </>
          }
        >
          <p>The course folder “Calculus of Several Variables” and its 10 files go to the Recycle Bin.</p>
        </DialogFrame>
        <DialogFrame
          isOpen={dialog === 'large'}
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          title="Problems"
          size="large"
          isDismissable
          banner={<Banner tone="info" size="block" title="Stand-in body" text="The problems list comes with its lane." />}
          footer={<Button size="dialog" onPress={() => { setDialog(null); }}>Close</Button>}
        >
          <Skeleton rows={8} />
        </DialogFrame>
      </Section>

      <Section title="Activity popover">
        <div className="gallery__popover">
          <ActivityPanel jobs={sampleJobs(now)} problems={7} onCancel={() => undefined} onDetails={() => undefined} onViewProblems={() => undefined} onClose={() => undefined} />
        </div>
        <div className="gallery__popover">
          <ActivityPanel jobs={sampleJobs(now).slice(2)} problems={0} onCancel={() => undefined} onDetails={() => undefined} onViewProblems={() => undefined} onClose={() => undefined} />
        </div>
      </Section>
      <ToastRegion />
    </main>
  );
}
