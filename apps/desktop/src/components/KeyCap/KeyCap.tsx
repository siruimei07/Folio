import './KeyCap.css';

/** A key or key combination as printed on a key cap: "Ctrl K", "Esc". Decorative by default. */
export function KeyCap({ keys }: { keys: string }) {
  return (
    <kbd className="key-cap" aria-hidden>
      {keys}
    </kbd>
  );
}
