import '../palette.css';
import './FileTypeIcon.css';

import {
  File,
  FileArchive,
  FileCode,
  FileHeadphone,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  type LucideIcon,
  Presentation,
} from 'lucide-react';

import { FILE_TYPE_COLOR, type FileType, fileTypeOf } from '../../lib/file-types';
import { SIZE } from '../../tokens/tokens';

const SIZES = {
  regular: SIZE.icon,
  large: SIZE.iconLarge,
  thumbnail: SIZE.iconThumbnail,
  card: SIZE.iconCard,
} as const;

const ICONS: Readonly<Record<FileType, LucideIcon>> = {
  pdf: FileText,
  word: FileText,
  powerpoint: Presentation,
  excel: FileSpreadsheet,
  markdown: FileText,
  code: FileCode,
  image: FileImage,
  audio: FileHeadphone,
  video: FileVideoCamera,
  archive: FileArchive,
  text: FileText,
  other: File,
};

export interface FileTypeIconProps {
  /** The file's name; its extension decides the icon and colour. */
  name: string;
  /**
   * regular 16 px (rows, headers); large 22 px (state tiles); thumbnail 34 px (grid tiles); card
   * 44 px (the preview's card for files it does not show).
   */
  size?: keyof typeof SIZES;
}

/** A file's type as a line icon in the type's palette colour (app-shell handoff 14B). Decorative. */
export function FileTypeIcon({ name, size = 'regular' }: FileTypeIconProps) {
  const type = fileTypeOf(name);
  const Icon = ICONS[type];
  return (
    <Icon
      aria-hidden
      className="file-type-icon"
      data-palette={FILE_TYPE_COLOR[type] ?? undefined}
      size={SIZES[size]}
    />
  );
}
