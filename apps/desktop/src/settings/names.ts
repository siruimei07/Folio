// What settings say under a name field (library-actions handoff §2.1; ipc-m1 §16.3): one message
// per code a field can get, from the page's own checks (`data/names.ts`) or from the shell. The
// UI knows which field it sent, so each code has one message per field at most.
import { useTranslation } from 'react-i18next';

import type { IpcError } from '../ipc';

type Code = IpcError['code'];

/** The kinds of typed names in settings. */
export type NameField = 'semester' | 'course' | 'code' | 'badge' | 'tag' | 'device';

/** The rules every folder name shares (semesters and courses), worded once. */
const FOLDER = {
  NameTrailingDotOrSpace: 'fields.folder.NameTrailingDotOrSpace',
  NameReserved: 'fields.folder.NameReserved',
  NameTooLong: 'fields.folder.NameTooLong',
  PathTooLong: 'fields.folder.PathTooLong',
} as const;

const MESSAGES = {
  semester: {
    ...FOLDER,
    NameEmpty: 'fields.semester.NameEmpty',
    NameInvalidCharacter: 'fields.semester.NameInvalidCharacter',
    AlreadyExists: 'fields.semester.AlreadyExists',
  },
  course: {
    ...FOLDER,
    NameEmpty: 'fields.course.NameEmpty',
    NameInvalidCharacter: 'fields.course.NameInvalidCharacter',
    AlreadyExists: 'fields.course.AlreadyExists',
  },
  code: {
    NameTooLong: 'fields.code.NameTooLong',
    NameInvalidCharacter: 'fields.code.NameInvalidCharacter',
  },
  badge: {
    NameTooLong: 'fields.badge.NameTooLong',
    NameInvalidCharacter: 'fields.badge.NameInvalidCharacter',
  },
  tag: {
    NameEmpty: 'fields.tag.NameEmpty',
    NameTooLong: 'fields.tag.NameTooLong',
    NameInvalidCharacter: 'fields.tag.NameInvalidCharacter',
    AlreadyExists: 'fields.tag.AlreadyExists',
  },
  device: {
    NameEmpty: 'fields.device.NameEmpty',
    NameTooLong: 'fields.device.NameTooLong',
    NameInvalidCharacter: 'fields.device.NameInvalidCharacter',
  },
} as const satisfies Record<NameField, Partial<Record<Code, string>>>;

/** Every message key above. */
type MessageKey = { [K in NameField]: (typeof MESSAGES)[K][keyof (typeof MESSAGES)[K]] }[NameField];

/** The values a message names: the semester of a course, the name that is taken. */
export interface NameValues {
  name?: string;
  semester?: string;
}

/**
 * The message for `code` under a field of `kind`, or `null` when the code is not about the
 * field (the page shows it elsewhere, as a banner or a toast).
 */
export function useNameMessage(): (kind: NameField, code: Code, values?: NameValues) => string | null {
  const { t } = useTranslation('settings');
  return (kind, code, values = {}) => {
    const messages: Partial<Record<Code, MessageKey>> = MESSAGES[kind];
    const key = messages[code];
    return key === undefined ? null : t(key, { name: values.name ?? '', semester: values.semester ?? '' });
  };
}

/** The messages of the course rows' names and codes (app/courseRowsForm.ts), in settings' words. */
export function useCourseRowMessage(): (field: 'course' | 'code', code: Code, semester: string) => string | null {
  const message = useNameMessage();
  return (field, code, semester) => message(field, code, { semester });
}
