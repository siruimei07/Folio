// Writes text to the Windows clipboard, for "Copy details" and "Copy path". The window has the
// clipboard; the preview frame never does (UI architecture §10.4).

/** Whether the text reached the clipboard. A failure is reported to the console only. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error: unknown) {
    console.error('copying to the clipboard failed', error);
    return false;
  }
}
