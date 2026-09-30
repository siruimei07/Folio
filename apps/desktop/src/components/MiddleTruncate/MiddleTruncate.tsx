import './MiddleTruncate.css';

/** Characters kept whole at the end: enough for a file name's end and its extension. */
const TAIL = 16;

/**
 * Text cut in the middle when it does not fit, so the end of a path or file name stays readable:
 * "MAT232/Problem se…ps3-solutions.docx". The whole text stays in the accessible name.
 */
export function MiddleTruncate({ text }: { text: string }) {
  const characters = Array.from(text);
  if (characters.length <= TAIL) return <span className="middle-truncate">{text}</span>;
  const head = characters.slice(0, -TAIL).join('');
  const tail = characters.slice(-TAIL).join('');
  return (
    <span className="middle-truncate" title={text}>
      <span className="middle-truncate__head">{head}</span>
      <span className="middle-truncate__tail">{tail}</span>
    </span>
  );
}
