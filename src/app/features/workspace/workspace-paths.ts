/**
 * Paths of a workspace (prompt 015): every file is stored absolute and relative to the `.lcw`, so a workspace
 * moved together with its logs (or opened on another machine) still finds them. Pure string work for POSIX and
 * Windows paths (drive letters, UNC); relative paths are stored with `/`.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\/]+[\\/][^\\/]+/;

export function isWindowsPath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || UNC.test(path);
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || isWindowsPath(path);
}

interface Parsed {
  /** `/`, `C:`, `\\server\share`. */
  root: string;
  parts: string[];
  windows: boolean;
}

function parse(path: string): Parsed | null {
  if (!isAbsolutePath(path) || path.includes('\0')) return null;
  const windows = isWindowsPath(path);
  let root: string;
  let rest: string;
  if (!windows) {
    root = '/';
    rest = path;
  } else if (WINDOWS_DRIVE.test(path)) {
    root = path.slice(0, 2).toUpperCase();
    rest = path.slice(2);
  } else {
    const m = /^\\\\([^\\/]+)[\\/]([^\\/]+)/.exec(path) as RegExpExecArray;
    root = `\\\\${m[1]}\\${m[2]}`;
    rest = path.slice(m[0].length);
  }
  const parts: string[] = [];
  for (const part of rest.split(windows ? /[\\/]/ : '/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return { root, parts, windows };
}

function format(p: Parsed): string {
  if (!p.windows) return `/${p.parts.join('/')}`;
  return `${p.root}\\${p.parts.join('\\')}`;
}

/**
 * A path that reaches another machine when touched: UNC (`\\\\host\\share`, `\\\\?\\UNC\\`), `//host`, macOS automounts
 * (`/net/`, `/Network/`). A workspace from someone else must not make the app connect there (SMB hash leak,
 * automount hangs); the backend refuses them as well.
 */
export function isNetworkPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.startsWith('\\\\') ||
    p.startsWith('//') ||
    p.startsWith('\\/') ||
    p.startsWith('/\\') ||
    p.startsWith('/net/') ||
    p.startsWith('/network/')
  );
}

/** The path without `.`, `..` and doubled separators; null if it is not absolute. */
export function normalizePath(path: string): string | null {
  const parsed = parse(path);
  return parsed ? format(parsed) : null;
}

/** The folder of a file. */
export function dirName(path: string): string {
  const parsed = parse(path);
  if (!parsed) return path;
  parsed.parts.pop();
  return format(parsed);
}

function samePart(a: string, b: string, windows: boolean): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `target` relative to the folder `fromDir` (with `/`), or null if they share no root (other drive). */
export function relativePath(fromDir: string, target: string): string | null {
  const from = parse(fromDir);
  const to = parse(target);
  if (!from || !to || from.windows !== to.windows) return null;
  if (!samePart(from.root, to.root, from.windows)) return null;
  let common = 0;
  while (
    common < from.parts.length &&
    common < to.parts.length &&
    samePart(from.parts[common], to.parts[common], from.windows)
  ) {
    common++;
  }
  const up = from.parts.slice(common).map(() => '..');
  const rel = [...up, ...to.parts.slice(common)].join('/');
  return rel || '.';
}

/** A relative path from the workspace against its folder; null for anything that is not a relative path. */
export function resolveRelative(baseDir: string, relative: string): string | null {
  if (!relative || relative.includes('\0') || isAbsolutePath(relative)) return null;
  // A drive-relative `C:x` or a root-relative `\x` is no relative path either.
  if (/^[A-Za-z]:/.test(relative) || relative.startsWith('\\')) return null;
  const base = parse(baseDir);
  if (!base) return null;
  const sep = base.windows ? '\\' : '/';
  return normalizePath(`${format(base)}${sep}${relative.replace(/[\\/]/g, sep)}`);
}
