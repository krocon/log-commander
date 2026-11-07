const numberFormat = new Intl.NumberFormat('de-DE');

export function formatCount(value: number): string {
  return numberFormat.format(value);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: digits })} ${UNITS[unit]}`;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
