import { CircleCheck } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Banner } from '../components/Banner/Banner';
import { ProgressBar, Spinner } from '../components/Progress/Progress';
import { Select } from '../components/Select/Select';
import { IpcFailure } from '../data/errors';
import { useCourses, useDefaultSemester, useSemesters, useUpdateCourse } from '../data/groups';
import { useJob, useJobEnded } from '../data/jobs';
import { setCurrentSemester } from '../data/session';
import type { Course, IpcError, Job } from '../ipc';
import { courseColor } from '../lib/courses';
import { percentOf } from '../lib/format';
import type { PaletteColor } from '../lib/palette';
import { SCAN_ANNOUNCE_MS } from '../lib/timing';
import { SIZE } from '../tokens/tokens';
import { type CourseRow, CourseRows, rowInputId } from '../components/CourseRows/CourseRows';
import { Frame } from './Frame';
import { checkCourseCode, nextColor } from '../data/names';
import { endFlow } from '../app/startFlow';
import { PendingButton } from '../components/Button/PendingButton';
import { focusAccent, StepHeader } from './Step';

/** Semester names the help lists before "and 3 more" (§5.2). */
const NAMED_SEMESTERS = 4;

interface Seen {
  done: number;
  total: number | null;
}

/**
 * How far the scan has come: files read, and the total once known. A finished job no longer says
 * how many it read, so `seen` keeps the last progress; at the end every file of the total is read.
 */
function scanProgress(job: Job | undefined, seen: Seen) {
  switch (job?.status.state) {
    case undefined:
    case 'queued':
      return { state: 'running' as const, ...seen };
    case 'running': {
      const { done, total } = job.status.progress;
      return { state: 'running' as const, done: Math.max(seen.done, done), total };
    }
    case 'done':
      return { state: 'done' as const, done: seen.total ?? seen.done, total: seen.total };
    default:
      return { state: 'stopped' as const, ...seen };
  }
}

/** The scan strip (§5.2): Folio reading the folder it took over, with its progress. */
function ScanStrip({ scan }: { scan: string }) {
  const { t } = useTranslation('first-run');
  const job = useJob(scan);
  const [seen, setSeen] = useState<Seen>({ done: 0, total: null });
  const progress = scanProgress(job, seen);
  if (progress.state === 'running' && (progress.done !== seen.done || progress.total !== seen.total)) {
    setSeen({ done: progress.done, total: progress.total });
  }
  const text =
    progress.state === 'done'
      ? progress.done > 0
        ? t('review.read', { count: progress.done })
        : t('review.readDone')
      : progress.state === 'stopped'
        ? t('review.stopped')
        : progress.total === null
          ? t('review.soFar', { done: progress.done })
          : t('review.ofTotal', { done: progress.done, total: progress.total });
  const lead = progress.state === 'running' ? t('review.reading') : text;

  // Screen readers hear the strip at most every SCAN_ANNOUNCE_MS, and at once when it ends.
  const [spoken, setSpoken] = useState(lead);
  const lastSpoken = useRef(0);
  const announcement = progress.state === 'running' ? `${lead} ${text}` : text;
  useEffect(() => {
    const wait = progress.state === 'running' ? lastSpoken.current + SCAN_ANNOUNCE_MS - Date.now() : 0;
    const timer = setTimeout(() => {
      lastSpoken.current = Date.now();
      setSpoken(announcement);
    }, Math.max(0, wait));
    return () => {
      clearTimeout(timer);
    };
  }, [announcement, progress.state]);

  return (
    <div className="scan-strip" data-state={progress.state}>
      <span className="visually-hidden" role="status">
        {spoken}
      </span>
      <div className="scan-strip__line" aria-hidden>
        {progress.state === 'running' ? (
          <Spinner />
        ) : progress.state === 'done' ? (
          <CircleCheck size={SIZE.icon} className="scan-strip__done" />
        ) : null}
        <span className="scan-strip__lead">{lead}</span>
        {progress.state === 'running' && <span className="scan-strip__count">{text}</span>}
      </div>
      {progress.state === 'running' && (
        <>
          <ProgressBar
            label={t('review.progress')}
            value={progress.total === null ? null : percentOf(progress.done, progress.total)}
          />
          <p className="scan-strip__help">{t('review.readingHelp')}</p>
        </>
      )}
    </div>
  );
}

/** A course code as the user left it, by course folder path. */
interface Edit {
  code?: string;
  codeError?: string | null;
}

/**
 * Colours for the listed courses without one (§1): the first palette colour not yet used in the
 * semester, in list order. Folio writes the colour it shows, so these are sent on Finish.
 */
function colorsFor(courses: readonly Course[], picked: Readonly<Record<string, PaletteColor>>): Record<string, PaletteColor> {
  const used: string[] = courses.flatMap((course) => picked[course.folder.path] ?? course.color ?? []);
  const colors: Record<string, PaletteColor> = {};
  for (const course of courses) {
    if (course.color !== null || course.folder.path in picked) continue;
    const color = nextColor(used);
    colors[course.folder.path] = color;
    used.push(color);
  }
  return colors;
}

/** The focus target "Finish", when no course has an empty code. */
const FINISH = '';

/**
 * Step 2 after taking over a folder (first-run handoff §5.2): the scan's progress, the semester
 * to show first, and its courses, read from the folders, for codes and colours.
 */
export function ReviewStep({ scan }: { scan: string }) {
  const { t, i18n } = useTranslation(['first-run', 'errors']);
  const idPrefix = useId();
  const semesters = useSemesters();
  const [chosen, setChosen] = useState<string | null>(null);
  const picked = semesters.data?.find((semester) => semester.folder.path === chosen);
  // Until the user picks one, the semester the Library would show; it follows the scan (§5.2).
  const fallback = useDefaultSemester(semesters.data, picked === undefined);
  const currentSemester = picked ?? fallback;
  const current = currentSemester?.folder.path ?? null;
  const courses = useCourses(current);
  const listed = current === null ? [] : (courses.data ?? []);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  /** Colours set on this page: chosen by the user, or given to courses without one. */
  const [colors, setColors] = useState<Record<string, PaletteColor>>({});
  const [banner, setBanner] = useState<IpcError | null>(null);
  const [finishing, setFinishing] = useState(false);
  const updateCourse = useUpdateCourse();
  const footerRef = useRef<HTMLDivElement>(null);
  const autoFocused = useRef<HTMLElement | null>(null);

  // Kept once given, so they stay as first shown when the scan finds more courses before them.
  const given = colorsFor(listed, colors);
  if (Object.keys(given).length > 0) setColors({ ...colors, ...given });

  const codeOf = (course: Course) => edits[course.folder.path]?.code ?? course.code ?? '';
  const rows: CourseRow[] = listed.map((course) => ({
    key: course.folder.path,
    code: codeOf(course),
    name: course.name,
    color: courseColor({ folder: course.folder, color: colors[course.folder.path] ?? course.color }),
    done: false,
    nameError: null,
    codeError: edits[course.folder.path]?.codeError ?? null,
  }));

  // Initial focus (§9): the first empty code field once the scan has found courses, else Finish.
  // The scan can change the semester shown, which removes that field: focus then moves to the new
  // one, unless the user has put it somewhere else.
  const ended = useJobEnded(scan);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const ready = rows.length > 0 || (ended && courses.isSuccess);
  const wanted = rows.find((row) => row.code === '')?.key ?? FINISH;
  // Finish was only the target while no course had shown up; a course field that went is replaced.
  const lost = focusTarget === FINISH ? wanted !== FINISH : focusTarget !== null && !rows.some((row) => row.key === focusTarget);
  if (ready && (focusTarget === null || lost) && focusTarget !== wanted) setFocusTarget(wanted);
  useEffect(() => {
    if (focusTarget === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== autoFocused.current) return;
    autoFocused.current =
      focusTarget === FINISH ? focusAccent(footerRef) : document.getElementById(rowInputId(idPrefix, focusTarget, 'code'));
    autoFocused.current?.focus();
  }, [focusTarget, idPrefix]);

  const edit = (path: string, change: Edit) => {
    setEdits((all) => ({ ...all, [path]: { ...all[path], ...change } }));
  };
  const codeMessage = (code: string) => {
    const problem = checkCourseCode(code);
    return problem === null ? null : t(`fields.code.${problem}`);
  };

  const finish = async () => {
    if (finishing) return;
    // Checks first; the first invalid code takes focus.
    const invalid = rows.filter((row) => checkCourseCode(row.code) !== null);
    for (const row of invalid) edit(row.key, { codeError: codeMessage(row.code) });
    const [first] = invalid;
    if (first !== undefined) {
      document.getElementById(rowInputId(idPrefix, first.key, 'code'))?.focus();
      return;
    }
    setBanner(null);
    setFinishing(true);
    let failed: string | null;
    try {
      failed = await save();
    } finally {
      setFinishing(false);
    }
    if (failed !== null) {
      document.getElementById(rowInputId(idPrefix, failed, 'code'))?.focus();
      return;
    }
    if (current !== null) setCurrentSemester(current);
    endFlow();
  };

  /**
   * Writes every listed course whose code or colour changed, all at once: they are independent
   * folders. Resolves to the first one, in list order, that failed, or `null`.
   */
  const save = async () => {
    const changed = listed.flatMap((course) => {
      const typed = codeOf(course).trim();
      const code = typed === '' ? null : typed;
      const color = colors[course.folder.path] ?? course.color;
      return code === course.code && color === course.color ? [] : [{ course, code, color }];
    });
    const results = await Promise.allSettled(
      changed.map(({ course, code, color }) =>
        updateCourse.mutateAsync({ course: course.folder, abbr: course.abbr, code, color, archived: course.archived }),
      ),
    );
    let failed: string | null = null;
    for (const [index, result] of results.entries()) {
      const path = changed[index]?.course.folder.path;
      if (path === undefined) continue;
      if (result.status === 'fulfilled') {
        edit(path, { codeError: null });
        continue;
      }
      if (!(result.reason instanceof IpcFailure)) throw result.reason;
      const { code } = result.reason.error;
      if (code === 'NameTooLong' || code === 'NameInvalidCharacter') edit(path, { codeError: t(`fields.code.${code}`) });
      else setBanner(result.reason.error);
      failed ??= path;
    }
    return failed;
  };

  const names = (semesters.data ?? []).map((semester) => semester.name);
  const listedNames =
    names.length > NAMED_SEMESTERS
      ? [...names.slice(0, NAMED_SEMESTERS - 1), t('review.more', { count: names.length - (NAMED_SEMESTERS - 1) })]
      : names;
  const listFormat = useMemo(() => new Intl.ListFormat(i18n.language, { type: 'conjunction' }), [i18n.language]);
  const title = t('review.title');
  const semesterName = currentSemester?.name ?? '';

  return (
    <Frame windowTitle={t('documentTitle.page', { page: title })} layout="step" busy={finishing}>
      <div className="step" data-tall>
        <StepHeader step={t('step.two')} title={title} intro={t('review.intro')} />
        <ScanStrip scan={scan} />
        {semesters.data !== undefined && semesters.data.length > 0 && (
          <div className="step__select">
            <Select
              label={t('review.semesterLabel')}
              options={semesters.data.map((semester) => ({ id: semester.folder.path, label: semester.name }))}
              selected={current}
              isDisabled={finishing}
              onChange={setChosen}
            />
            <p className="field__help">{t('review.semesterHelp', { names: listFormat.format(listedNames) })}</p>
          </div>
        )}
        {current !== null && (
          <section className="step__section" aria-labelledby={`${idPrefix}-courses`}>
            <h2 id={`${idPrefix}-courses`} className="step__label">
              {t('review.coursesIn', { semester: semesterName, count: listed.length })}
            </h2>
            {courses.isSuccess && listed.length === 0 ? (
              <p className="step__empty">{t('review.noCourses', { semester: semesterName })}</p>
            ) : (
              <CourseRows
                rows={rows}
                mode="found"
                idPrefix={idPrefix}
                busy={finishing}
                onChange={(key, { code, color }) => {
                  if (color !== undefined) setColors((all) => ({ ...all, [key]: color }));
                  if (code !== undefined) edit(key, { code, codeError: codeMessage(code) });
                }}
                onEnter={() => {
                  void finish();
                }}
              />
            )}
          </section>
        )}
        {banner !== null && <Banner size="block" tone="danger" announce title={t(`errors:${banner.code}`)} />}
        <div ref={footerRef} className="step__footer">
          <p className="step__later">{t('review.laterNote')}</p>
          <div className="step__footer-end">
            <PendingButton
              variant="accent"
              pending={finishing ? t('review.finishing') : null}
              onPress={() => {
                void finish();
              }}
            >
              {t('review.finish')}
            </PendingButton>
          </div>
        </div>
      </div>
    </Frame>
  );
}
