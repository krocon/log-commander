import { open, save } from '@tauri-apps/plugin-dialog';
import { call } from '../backend/call';

/**
 * The native open and save dialogs (tauri-plugin-dialog). An end-to-end run cannot operate a native dialog: it
 * puts the answers into `window.__lcDialogPaths` beforehand and each dialog takes the next one. That only works
 * when the backend says so (`scripted_dialogs`: a debug build running a scenario); a release build always shows
 * the real dialog.
 */
interface ScriptedDialogs {
  __lcDialogPaths?: (string | null)[];
}

let allowed: Promise<boolean> | null = null;

/** Asked once: may dialogs take scripted answers? */
function scriptingAllowed(): Promise<boolean> {
  allowed ??= call<boolean>('scripted_dialogs').catch(() => false);
  return allowed;
}

/** The next scripted answer if scripting is allowed; the queue is left alone otherwise. */
export function takeScripted(queue: unknown, allowedNow: boolean): { path: string | null } | null {
  if (!allowedNow || !Array.isArray(queue) || queue.length === 0) return null;
  const next: unknown = queue.shift();
  return { path: typeof next === 'string' ? next : null };
}

async function scriptedAnswer(): Promise<{ path: string | null } | null> {
  const queue = (window as unknown as ScriptedDialogs).__lcDialogPaths;
  if (!Array.isArray(queue) || queue.length === 0) return null;
  return takeScripted(queue, await scriptingAllowed());
}

export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** One file to read, or null when cancelled. */
export async function pickFile(title: string, filters?: DialogFilter[]): Promise<string | null> {
  const answer = await scriptedAnswer();
  if (answer) return answer.path;
  const chosen = await open({ multiple: false, directory: false, title, filters });
  return typeof chosen === 'string' ? chosen : null;
}

/** A file to write, or null when cancelled. */
export async function pickSaveFile(
  title: string,
  defaultPath: string,
  filters?: DialogFilter[],
): Promise<string | null> {
  const answer = await scriptedAnswer();
  if (answer) return answer.path;
  return (await save({ title, defaultPath, filters })) ?? null;
}
