import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announce } from '../../app/announcer';
import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import { ColourButton } from '../../components/ColourButton/ColourButton';
import { DialogFrame } from '../../components/Dialog/Dialog';
import { Field } from '../../components/Field/Field';
import { useRenameEntry } from '../../data/entries';
import { useUpdateCourse } from '../../data/groups';
import { checkBadge, checkCourseCode, checkFolderName } from '../../data/names';
import type { Course, IpcError, Semester } from '../../ipc';
import { courseBadgeText, courseColor, courseTitle } from '../../lib/courses';
import type { PaletteColor } from '../../lib/palette';
import { ipcErrorOf } from '../feedback';
import { useNameMessage } from '../names';

export interface EditCourseDialogProps {
  course: Course;
  semester: Semester;
  onClose: () => void;
}

/**
 * Edits a course (app-shell handoff §9, brief §5.1): its folder name, code, badge and colour. The
 * badge left empty follows the name; a colour left as it was keeps following the name too
 * (ipc-m1 §7). `update_course` saves the code, badge and colour, then `rename_entry` the name;
 * a failed rename keeps the dialog open with the reason under the name.
 */
export function EditCourseDialog({ course, semester, onClose }: EditCourseDialogProps) {
  const { t } = useTranslation(['settings', 'errors', 'common']);
  const message = useNameMessage();
  const update = useUpdateCourse();
  const rename = useRenameEntry();
  const [name, setName] = useState(course.name);
  const [code, setCode] = useState(course.code ?? '');
  const [badge, setBadge] = useState(course.abbr ?? '');
  const [color, setColor] = useState<PaletteColor>(courseColor(course));
  const [errors, setErrors] = useState<{ name: string | null; code: string | null; badge: string | null }>({
    name: null,
    code: null,
    badge: null,
  });
  const [banner, setBanner] = useState<IpcError | null>(null);
  const saving = update.isPending || rename.isPending;
  const nameInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const badgeInput = useRef<HTMLInputElement>(null);

  const values = { semester: semester.name };
  const defaultBadge = courseBadgeText({
    abbr: null,
    code: code.trim(),
    name: name.trim() === '' ? course.name : name.trim(),
  });

  const save = async () => {
    if (saving) return;
    const checked = {
      name: checkFolderName(name, false),
      code: checkCourseCode(code),
      badge: checkBadge(badge),
    };
    const shown = {
      name: checked.name === null ? null : message('course', checked.name, values),
      code: checked.code === null ? null : message('code', checked.code),
      badge: checked.badge === null ? null : message('badge', checked.badge),
    };
    setErrors(shown);
    setBanner(null);
    const invalid = [
      { error: shown.name, input: nameInput },
      { error: shown.code, input: codeInput },
      { error: shown.badge, input: badgeInput },
    ].find((field) => field.error !== null);
    if (invalid !== undefined) {
      invalid.input.current?.focus();
      return;
    }

    const abbr = badge.trim() === '' ? null : badge.trim();
    const typedCode = code.trim() === '' ? null : code.trim();
    // An unchanged colour stays what it was: `null` keeps following the name.
    const sentColor = color === courseColor(course) ? course.color : color;
    const changed = abbr !== course.abbr || typedCode !== course.code || sentColor !== course.color;
    try {
      if (changed) {
        await update.mutateAsync({ course: course.folder, abbr, code: typedCode, color: sentColor, archived: course.archived });
      }
    } catch (failure: unknown) {
      setBanner(ipcErrorOf(failure));
      return;
    }
    if (name.trim() !== course.name) {
      try {
        await rename.mutateAsync({ entry: course.folder, name });
      } catch (failure: unknown) {
        const error = ipcErrorOf(failure);
        const under = message('course', error.code, values);
        if (under === null) setBanner(error);
        else {
          setErrors({ ...shown, name: under });
          nameInput.current?.focus();
        }
        return;
      }
    }
    announce(t('editCourse.saved', { course: courseTitle({ code: typedCode, name: name.trim() }) }));
    onClose();
  };

  const onEnter = () => {
    void save();
  };

  return (
    <DialogFrame
      isOpen
      placement="form"
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title={t('editCourse.title', { course: courseTitle(course) })}
      banner={banner === null ? undefined : <Banner tone="danger" size="block" announce title={t('editCourse.failed')} text={t(`errors:${banner.code}`)} />}
      footer={
        <>
          <Button size="dialog" onPress={onClose} isDisabled={saving}>
            {t('cancel')}
          </Button>
          <PendingButton variant="accent" pending={saving ? t('saving') : null} onPress={onEnter}>
            {t('save')}
          </PendingButton>
        </>
      }
    >
      <Field
        label={t('editCourse.name')}
        value={name}
        onChange={(value) => {
          setName(value);
          setErrors((current) => ({ ...current, name: null }));
        }}
        error={errors.name}
        help={t('editCourse.nameHelp')}
        readOnly={saving}
        inputRef={nameInput}
        autoFocus
        onEnter={onEnter}
      />
      <div className="settings-dialog-row">
        <Field
          label={t('editCourse.code')}
          value={code}
          onChange={(value) => {
            setCode(value);
            setErrors((current) => ({ ...current, code: null }));
          }}
          error={errors.code}
          help={t('editCourse.codeHelp')}
          readOnly={saving}
          inputRef={codeInput}
          onEnter={onEnter}
        />
        <Field
          label={t('editCourse.badge')}
          value={badge}
          onChange={(value) => {
            setBadge(value);
            setErrors((current) => ({ ...current, badge: null }));
          }}
          error={errors.badge}
          help={t('editCourse.badgeHelp', { badge: defaultBadge })}
          readOnly={saving}
          inputRef={badgeInput}
          onEnter={onEnter}
        />
      </div>
      <div className="settings-colour-field">
        <span className="field__label" aria-hidden>
          {t('editCourse.colour')}
        </span>
        <ColourButton
          label={t('editCourse.colourLabel', { colour: t(`common:colour.names.${color}`) })}
          color={color}
          badge={badge.trim() === '' ? defaultBadge : badge.trim()}
          onChange={setColor}
          isDisabled={saving}
        />
      </div>
    </DialogFrame>
  );
}
