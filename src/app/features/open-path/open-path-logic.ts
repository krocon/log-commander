const HOME_PREFIX = /^~(?=$|[\\/])/;

/** Removes what copying a path tends to bring along: outer whitespace and one pair of quotes. */
export function cleanPathInput(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2].trim() : trimmed;
}

export function usesHome(path: string): boolean {
  return HOME_PREFIX.test(path);
}

/** `~` and `~/x` become paths below `home`; `~user` and `/a/~` are left alone. */
export function expandHome(path: string, home: string): string {
  return path.replace(HOME_PREFIX, () => home.replace(/[\\/]+$/, ''));
}
