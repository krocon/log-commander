import { LEVELS, Level, ReportResult, ReportValue } from '../../core/log/log.models';

/** Points per series above which a larger bucket is suggested (not thinned out silently). */
export const MAX_POINTS = 5000;
/** Slices of a pie chart; the rest is „Sonstige“. */
export const MAX_SLICES = 8;
/** Series a text column may split into; the rest is left out with a note. */
export const MAX_SERIES = 24;

/** Names of a first column that make it the time axis (with whole numbers in it). */
const TIME_NAMES = ['ts', 't', 'time', 'zeit', 'bucket', 'minute', 'hour', 'day', 'stunde', 'tag'];

/** Intervals offered when there are too many points, as `bucket()` writes them. */
const INTERVALS: readonly { spec: string; ms: number }[] = [
  { spec: '1s', ms: 1000 },
  { spec: '10s', ms: 10_000 },
  { spec: '1m', ms: 60_000 },
  { spec: '5m', ms: 300_000 },
  { spec: '15m', ms: 900_000 },
  { spec: '1h', ms: 3_600_000 },
  { spec: '6h', ms: 21_600_000 },
  { spec: '1d', ms: 86_400_000 },
  { spec: '7d', ms: 604_800_000 },
];

export interface Series {
  label: string;
  values: (number | null)[];
  /** A series per level (text column `level`): drawn in the level's colour. */
  level: Level | null;
  /** The value of the splitting text column, for a filter from a bar. */
  splitValue: string | null;
}

export interface ChartData {
  /** `time`: x are milliseconds; `category`: x are indexes into `categories`; `empty`: nothing to draw. */
  axis: 'time' | 'category' | 'empty';
  x: number[];
  categories: string[];
  series: Series[];
  /** Name of the first column (the axis), and of the splitting text column, if any. */
  axisColumn: string;
  splitColumn: string | null;
  /** Distance of two buckets in ms (smallest step of x), null with fewer than two points. */
  step: number | null;
  /** Rows without a time on the time axis, left out. */
  skipped: number;
  /** Series beyond `MAX_SERIES`, left out. */
  droppedSeries: number;
  message: string | null;
}

const isNumber = (v: ReportValue): v is number => typeof v === 'number' && Number.isFinite(v);

function isTimeAxis(result: ReportResult): boolean {
  const name = result.columns[0]?.toLowerCase() ?? '';
  const named = TIME_NAMES.includes(name) || name.startsWith('bucket');
  if (!named) return false;
  const values = result.rows.map((r) => r[0]).filter((v) => v !== null);
  return values.length > 0 && values.every((v) => isNumber(v) && Number.isInteger(v));
}

/** Columns 1… whose values are all numbers (or null) and at least one number. */
function numericColumns(result: ReportResult): number[] {
  const out: number[] = [];
  for (let c = 1; c < result.columns.length; c++) {
    const values = result.rows.map((r) => r[c]);
    if (values.some(isNumber) && values.every((v) => v === null || isNumber(v))) out.push(c);
  }
  return out;
}

function label(value: ReportValue): string {
  if (value === null) return '(leer)';
  return String(value);
}

function asLevel(column: string | null, value: string): Level | null {
  if (column?.toLowerCase() !== 'level') return null;
  return (LEVELS as readonly string[]).includes(value) ? (value as Level) : null;
}

const empty = (result: ReportResult, message: string): ChartData => ({
  axis: 'empty',
  x: [],
  categories: [],
  series: [],
  axisColumn: result.columns[0] ?? '',
  splitColumn: null,
  step: null,
  skipped: 0,
  droppedSeries: 0,
  message,
});

/**
 * Rows of a query as series: the first column is the axis (time if it is `ts`/`bucket`/… with whole numbers,
 * else categories), further number columns are series, a text column splits them into series per value.
 * Missing combinations and NULL are gaps (`null`).
 */
export function toChartData(result: ReportResult, stepHint: number | null = null): ChartData {
  if (result.columns.length === 0) return empty(result, 'Keine Spalten');
  if (result.rows.length === 0) return empty(result, 'Keine Zeilen');
  const numeric = numericColumns(result);
  if (numeric.length === 0) {
    return empty(result, 'Keine Zahlenspalte: Diagramme brauchen nach der ersten Spalte eine Zahl');
  }
  const time = isTimeAxis(result);
  let splitIndex: number | null = null;
  for (let c = 1; c < result.columns.length; c++) {
    if (!numeric.includes(c)) {
      splitIndex = c;
      break;
    }
  }
  const splitColumn = splitIndex === null ? null : result.columns[splitIndex];

  // The axis: sorted times, or categories in the order they come.
  let skipped = 0;
  const keys: (number | string)[] = [];
  const seen = new Map<number | string, number>();
  const rows: { at: number; row: ReportValue[] }[] = [];
  for (const row of result.rows) {
    const raw = row[0];
    let key: number | string;
    if (time) {
      if (!isNumber(raw)) {
        skipped++;
        continue;
      }
      key = raw;
    } else {
      key = label(raw);
    }
    let at = seen.get(key);
    if (at === undefined) {
      at = keys.length;
      seen.set(key, at);
      keys.push(key);
    }
    rows.push({ at, row });
  }
  let order = keys.map((_, i) => i);
  if (time) order = order.sort((a, b) => (keys[a] as number) - (keys[b] as number));
  const position = new Map(order.map((k, i) => [k, i]));

  // Series: per number column, or per (split value × number column).
  const series: Series[] = [];
  const byKey = new Map<string, Series>();
  const dropped = new Set<string>();
  const seriesFor = (split: string | null, column: number): Series | null => {
    const key = `${split ?? ''}\u0000${column}`;
    const found = byKey.get(key);
    if (found) return found;
    if (series.length >= MAX_SERIES) {
      dropped.add(key);
      return null;
    }
    const name = result.columns[column];
    const created: Series = {
      label: split === null ? name : numeric.length > 1 ? `${split} · ${name}` : split,
      values: new Array<number | null>(keys.length).fill(null),
      level: split === null ? null : asLevel(splitColumn, split),
      splitValue: split,
    };
    byKey.set(key, created);
    series.push(created);
    return created;
  };
  for (const { at, row } of rows) {
    const split = splitIndex === null ? null : label(row[splitIndex]);
    for (const column of numeric) {
      const target = seriesFor(split, column);
      if (!target) continue;
      const value = row[column];
      const index = position.get(at) as number;
      if (isNumber(value)) target.values[index] = (target.values[index] ?? 0) + value;
    }
  }
  const x = time ? order.map((k) => keys[k] as number) : order.map((_, i) => i);
  const categories = time ? [] : order.map((k) => String(keys[k]));
  return {
    axis: time ? 'time' : 'category',
    x,
    categories,
    series,
    axisColumn: result.columns[0],
    splitColumn,
    step: time ? (stepHint ?? smallestStep(x)) : null,
    skipped,
    droppedSeries: dropped.size,
    message: x.length === 0 ? 'Keine Zeilen mit Zeit' : null,
  };
}

function smallestStep(x: readonly number[]): number | null {
  let step: number | null = null;
  for (let i = 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    if (d > 0 && (step === null || d < step)) step = d;
  }
  return step;
}

export type PanelKind = 'line' | 'area' | 'bars' | 'stacked' | 'pie' | 'table' | 'value';

/** What is drawn: without a time axis a line or area becomes bars. */
export function effectiveKind(kind: PanelKind, data: ChartData): PanelKind {
  if ((kind === 'line' || kind === 'area') && data.axis === 'category') return 'bars';
  return kind;
}

export interface Slice {
  label: string;
  value: number;
  level: Level | null;
  /** The value behind the slice, for a filter (null for „Sonstige“). */
  splitValue: string | null;
}

/**
 * Slices of a pie: with categories the first series per category, with a time axis each series summed over
 * time. Largest first, at most `MAX_SLICES`, the rest summed as „Sonstige“; non-positive values are left out.
 */
export function pieSlices(data: ChartData): Slice[] {
  let slices: Slice[];
  if (data.axis === 'category' && !data.splitColumn) {
    const first = data.series[0];
    slices = data.categories.map((c, i) => ({
      label: c,
      value: first?.values[i] ?? 0,
      level: asLevel(data.axisColumn, c),
      splitValue: c,
    }));
  } else {
    slices = data.series.map((s) => ({
      label: s.label,
      value: s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0),
      level: s.level,
      splitValue: s.splitValue,
    }));
  }
  slices = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  if (slices.length <= MAX_SLICES) return slices;
  const kept = slices.slice(0, MAX_SLICES - 1);
  const rest = slices.slice(MAX_SLICES - 1).reduce((sum, s) => sum + s.value, 0);
  return [...kept, { label: 'Sonstige', value: rest, level: null, splitValue: null }];
}

/** The value of a single-value panel: the first number of the first row. */
export function singleValue(result: ReportResult): number | string | null {
  const row = result.rows[0];
  if (!row) return null;
  const number = row.find(isNumber);
  if (number !== undefined) return number;
  return row[0] ?? null;
}

const NUMBER = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });

export function formatNumber(value: number): string {
  return NUMBER.format(value);
}

/** A time (ms, UTC) as local date and time, like the log shows it. */
export function formatTime(ms: number, withDate = true): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (!withDate) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** A cell of a table panel: times (column `ts`, `t`, `bucket` …) local, numbers German, NULL empty. */
export function formatCell(column: string, value: ReportValue): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    const name = column.toLowerCase();
    if (Number.isInteger(value) && (TIME_NAMES.includes(name) || name.startsWith('bucket'))) {
      return formatTime(value);
    }
    if (name === 'line') return String(value);
    return formatNumber(value);
  }
  return value;
}

/** Index of the column `line` in a result, if it has whole numbers: then rows are links into the log. */
export function lineColumn(result: ReportResult): number | null {
  const i = result.columns.findIndex((c) => c.toLowerCase() === 'line');
  return i < 0 ? null : i;
}

/** The line (1-based, as `line` stores it) of a table row, if any. */
export function lineOfRow(result: ReportResult, row: number): number | null {
  const column = lineColumn(result);
  if (column === null) return null;
  const value = result.rows[row]?.[column];
  return isNumber(value) && Number.isInteger(value) && value >= 1 ? value : null;
}

/** The time range of a point on the time axis: from its bucket to the next one (or one step on). */
export function rangeAt(data: ChartData, index: number): { from: number; to: number } | null {
  if (data.axis !== 'time' || index < 0 || index >= data.x.length) return null;
  const from = data.x[index];
  const next = data.x[index + 1];
  const step = data.step ?? 1;
  const to = next !== undefined && next - from <= step ? next : from + step;
  return { from, to: Math.max(to, from + 1) };
}

/** SQL for the first line in a time range, for a series of one level only that level. */
export function firstLineQuery(range: { from: number; to: number }, level: Level | null): string {
  const where = [`ts >= ${Math.trunc(range.from)}`, `ts < ${Math.trunc(range.to)}`];
  if (level) where.push(`level = '${level}'`);
  return `SELECT min(line) AS line FROM log WHERE ${where.join(' AND ')}`;
}

/**
 * The bucket length a query groups by, from its first `bucket(…)` (without an interval: one minute), in ms;
 * local days count as 24 h. `null` without `bucket`.
 */
export function intervalOf(sql: string): number | null {
  const call = /bucket\(\s*[^,()]+?\s*(?:,\s*'([^']*)'\s*)?\)/i.exec(sql);
  if (!call) return null;
  if (call[1] === undefined) return 60_000;
  const m = /^\s*(\d+)\s*(ms|s|sec|m|min|h|d)\s*$/.exec(call[1]);
  if (!m) return null;
  const unit: Record<string, number> = {
    ms: 1,
    s: 1000,
    sec: 1000,
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Number(m[1]) * unit[m[2]];
}

/** Over `MAX_POINTS` per series: the smallest standard interval that brings it under, as `bucket()` writes it. */
export function suggestInterval(data: ChartData): string | null {
  if (data.axis !== 'time' || data.x.length <= MAX_POINTS) return null;
  const span = data.x[data.x.length - 1] - data.x[0];
  const step = data.step ?? 0;
  for (const interval of INTERVALS) {
    if (interval.ms > step && span / interval.ms <= MAX_POINTS) return interval.spec;
  }
  return INTERVALS[INTERVALS.length - 1].spec;
}

/** The SQL with every `bucket(…, '…')` set to another interval (or the interval added). */
export function withInterval(sql: string, spec: string): string {
  return sql
    .replace(/bucket\(\s*([^,()]+?)\s*,\s*'[^']*'\s*\)/gi, `bucket($1, '${spec}')`)
    .replace(/bucket\(\s*([^,()]+?)\s*\)/gi, `bucket($1, '${spec}')`);
}

/** Error texts of the backend in German where they are known; the engine's own text stays as detail. */
export function describeQueryError(message: string): string {
  const known: [RegExp, string][] = [
    [/time limit of ([\d.]+) s exceeded/, 'Zeitlimit von $1 s überschritten'],
    [/only reading queries/, 'Nur lesende Abfragen (SELECT, WITH) sind erlaubt'],
    [/only one statement/, 'Nur eine Anweisung je Abfrage'],
    [/^not authorized$/, 'Nicht erlaubt: nur Lesen aus log und sources'],
    [/cancelled by a newer query.*/, 'Abgebrochen (neuere Abfrage oder Dashboard geschlossen)'],
    [/too many queries at once \(at most (\d+)\)/, 'Zu viele Abfragen zugleich (höchstens $1)'],
    [/out of memory/, 'Speichergrenze der Abfragen erreicht'],
    [/string or blob too big/, 'Wert zu groß (höchstens 64 KB je Wert)'],
    [/LIKE or GLOB pattern too complex/, 'Muster zu lang (höchstens 256 Zeichen)'],
    [/the dashboard of this tab is not open/, 'Dashboard nicht geöffnet'],
    [/^empty query$/, 'Keine Abfrage'],
    [/disk full|disk almost full/, 'Laufwerk (fast) voll, Aufbau angehalten'],
    [/not enough disk space/, 'Zu wenig freier Speicher für die Datenbank'],
  ];
  for (const [pattern, text] of known) {
    if (pattern.test(message)) return message.replace(pattern, text);
  }
  return message;
}

/** Sums per series (for tests and the data attributes of a chart). */
export function seriesSums(data: ChartData): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const s of data.series) sums[s.label] = s.values.reduce<number>((a, v) => a + (v ?? 0), 0);
  return sums;
}
