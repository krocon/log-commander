import { ReportSchema, SchemaColumn } from '../../core/log/log.models';
import { PanelKind } from './report-logic';

/** Width of a panel in columns of the 4-column grid, and its height. */
export type PanelWidth = 1 | 2 | 3 | 4;
export type PanelHeight = 's' | 'm' | 'l';

export interface PanelDef {
  id: string;
  title: string;
  sql: string;
  kind: PanelKind;
  width: PanelWidth;
  height: PanelHeight;
}

/** One dashboard, stored per profile id (the format of a file, like the column layouts). */
export interface DashboardDef {
  version: 1;
  panels: PanelDef[];
  /** Refresh every 5 s while shown. */
  auto: boolean;
  /** Column ids stored in the table; `null`: the numbers (backend default). */
  fields: string[] | null;
}

export const PANEL_KINDS: readonly { kind: PanelKind; label: string }[] = [
  { kind: 'line', label: 'Linie' },
  { kind: 'area', label: 'Fläche' },
  { kind: 'bars', label: 'Säulen' },
  { kind: 'stacked', label: 'Gestapelte Säulen' },
  { kind: 'pie', label: 'Kreis' },
  { kind: 'table', label: 'Tabelle' },
  { kind: 'value', label: 'Einzelwert' },
];

export const HEIGHTS: Record<PanelHeight, number> = { s: 180, m: 260, l: 380 };
export const MAX_PANELS = 24;
const MAX_SQL = 64 * 1024;
const MAX_TITLE = 120;
const MAX_DASHBOARDS = 200;
const MAX_FIELDS = 64;

let counter = 0;
export function panelId(): string {
  counter++;
  return `p${Date.now().toString(36)}${counter.toString(36)}`;
}

/** A starting point that needs no SQL: shown as plain SQL in the panel, to learn from and change. */
export interface Template {
  id: string;
  title: string;
  sql: string;
  kind: PanelKind;
  width: PanelWidth;
}

/** The numeric columns of the table (fields of prompt 011 and numeric columns of the format). */
export function numberFields(schema: ReportSchema | null): SchemaColumn[] {
  return (schema?.columns ?? []).filter(
    (c) => c.column !== null && c.included && c.sqlType === 'REAL' && !isIdName(c.column),
  );
}

/** Numbers that name something (pid, port, ids) get no template; mirrors `is_id_name` in report_db.rs. */
export function isIdName(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    ['pid', 'tid', 'ppid', 'port', 'id', 'uid', 'gid'].includes(lower) ||
    lower.endsWith('_id') ||
    lower.endsWith('.id') ||
    (id.endsWith('Id') && id.length > 2)
  );
}

/**
 * Templates for a session: entries per level per minute, error rate, levels as a whole, last errors, per
 * source (merge), mean and maximum per number field.
 */
export function templates(schema: ReportSchema | null): Template[] {
  const list: Template[] = [
    {
      id: 'levels-per-minute',
      title: 'Einträge je Level je Minute',
      kind: 'stacked',
      width: 4,
      sql: [
        "SELECT bucket(ts, '1m') AS t, level, count(*) AS n",
        'FROM log',
        'WHERE ts IS NOT NULL',
        'GROUP BY t, level',
        'ORDER BY t',
      ].join('\n'),
    },
    {
      id: 'error-rate',
      title: 'Fehlerrate je Minute (%)',
      kind: 'line',
      width: 2,
      sql: [
        "SELECT bucket(ts, '1m') AS t,",
        "       round(100.0 * sum(level IN ('ERROR', 'FATAL')) / count(*), 2) AS fehlerrate",
        'FROM log',
        'WHERE ts IS NOT NULL',
        'GROUP BY t',
        'ORDER BY t',
      ].join('\n'),
    },
    {
      id: 'levels-total',
      title: 'Level insgesamt',
      kind: 'pie',
      width: 2,
      sql: 'SELECT level, count(*) AS n\nFROM log\nGROUP BY level\nORDER BY n DESC',
    },
    {
      id: 'errors-total',
      title: 'Fehler insgesamt',
      kind: 'value',
      width: 1,
      sql: "SELECT count(*) AS fehler\nFROM log\nWHERE level IN ('ERROR', 'FATAL')",
    },
    {
      id: 'last-errors',
      title: 'Letzte Fehler',
      kind: 'table',
      width: 2,
      sql: [
        "SELECT line, datetime(ts / 1000, 'unixepoch', 'localtime') AS zeit, level",
        'FROM log',
        "WHERE level IN ('ERROR', 'FATAL')",
        'ORDER BY line DESC',
        'LIMIT 100',
      ].join('\n'),
    },
  ];
  if ((schema?.sources.length ?? 0) > 1) {
    list.push({
      id: 'per-source',
      title: 'Einträge je Quelle je Minute',
      kind: 'line',
      width: 2,
      sql: [
        "SELECT bucket(ts, '1m') AS t,",
        '       (SELECT name FROM sources s WHERE s.source = log.source) AS quelle,',
        '       count(*) AS n',
        'FROM log',
        'WHERE ts IS NOT NULL',
        'GROUP BY t, log.source',
        'ORDER BY t',
      ].join('\n'),
    });
  }
  for (const field of numberFields(schema)) {
    // Quoted: a field may be called `order` or `group`.
    const name = quoteIdent(field.name);
    const unit = baseUnit(field) ? ` (${baseUnit(field)})` : '';
    list.push({
      id: `field-${field.name}`,
      title: `${field.description}${unit}: Mittel und Maximum je Minute`,
      kind: 'line',
      width: 2,
      sql: [
        `SELECT bucket(ts, '1m') AS t, avg(${name}) AS mittel, max(${name}) AS maximum`,
        'FROM log',
        `WHERE ts IS NOT NULL AND ${name} IS NOT NULL`,
        'GROUP BY t',
        'ORDER BY t',
      ].join('\n'),
    });
  }
  return list;
}

/** An SQL identifier in double quotes (names from the backend are `[a-z0-9_]`, quotes doubled anyway). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The unit values of a field are stored in (prompt 011 `parse_value`). */
export function baseUnit(column: SchemaColumn): string {
  switch (column.kind) {
    case 'duration':
      return 's';
    case 'size':
      return 'Byte';
    case 'percent':
      return '%';
    default:
      return '';
  }
}

export function fromTemplate(template: Template): PanelDef {
  return {
    id: panelId(),
    title: template.title,
    sql: template.sql,
    kind: template.kind,
    width: template.width,
    height: 'm',
  };
}

/** A new dashboard: entries per level, error rate, levels, last errors and the first two number fields. */
export function defaultDashboard(schema: ReportSchema | null): DashboardDef {
  const all = templates(schema);
  const pick = all.filter(
    (t) =>
      !t.id.startsWith('field-') || all.filter((x) => x.id.startsWith('field-')).indexOf(t) < 2,
  );
  return {
    version: 1,
    panels: pick.filter((t) => t.id !== 'errors-total').map(fromTemplate),
    auto: true,
    fields: null,
  };
}

export function emptyPanel(): PanelDef {
  return {
    id: panelId(),
    title: 'Neues Panel',
    sql: "SELECT bucket(ts, '1m') AS t, count(*) AS n\nFROM log\nGROUP BY t\nORDER BY t",
    kind: 'line',
    width: 2,
    height: 'm',
  };
}

const KINDS = PANEL_KINDS.map((k) => k.kind);
const WIDTHS: readonly number[] = [1, 2, 3, 4];
const HEIGHT_KEYS: readonly string[] = ['s', 'm', 'l'];

/** Forgiving merge of the stored dashboards: broken panels are dropped, broken values fall back. */
export function mergeDashboards(saved: unknown): Record<string, DashboardDef> {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
  const result: Record<string, DashboardDef> = {};
  for (const [profile, value] of Object.entries(saved as Record<string, unknown>).slice(
    0,
    MAX_DASHBOARDS,
  )) {
    if (typeof value !== 'object' || value === null) continue;
    const d = value as Partial<Record<keyof DashboardDef, unknown>>;
    const panels: PanelDef[] = [];
    const ids = new Set<string>();
    for (const raw of Array.isArray(d.panels) ? (d.panels as unknown[]) : []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const p = raw as Partial<Record<keyof PanelDef, unknown>>;
      if (typeof p.id !== 'string' || !p.id || ids.has(p.id)) continue;
      if (typeof p.sql !== 'string' || p.sql.length > MAX_SQL) continue;
      ids.add(p.id);
      panels.push({
        id: p.id,
        title: typeof p.title === 'string' ? p.title.slice(0, MAX_TITLE) : 'Panel',
        sql: p.sql,
        kind: KINDS.includes(p.kind as PanelKind) ? (p.kind as PanelKind) : 'line',
        width: WIDTHS.includes(p.width as number) ? (p.width as PanelWidth) : 2,
        height: HEIGHT_KEYS.includes(p.height as string) ? (p.height as PanelHeight) : 'm',
      });
      if (panels.length >= MAX_PANELS) break;
    }
    const fields =
      Array.isArray(d.fields) && d.fields.every((f) => typeof f === 'string')
        ? (d.fields as string[]).slice(0, MAX_FIELDS)
        : null;
    result[profile] = { version: 1, panels, auto: d.auto !== false, fields };
  }
  return result;
}

/** A field ticked or unticked in the schema help: from the backend default (numbers) to an explicit list. */
export function toggleField(
  schema: ReportSchema,
  current: string[] | null,
  column: string,
  on: boolean,
): string[] {
  const base =
    current ??
    schema.columns.filter((c) => c.column !== null && c.included).map((c) => c.column as string);
  const without = base.filter((c) => c !== column);
  return on ? [...without, column] : without;
}

/** Changes of a panel's size: wider/narrower within 1–4, height through S/M/L. */
export function resized(
  panel: PanelDef,
  change: 'wider' | 'narrower' | 'taller' | 'lower',
): PanelDef {
  const heights: PanelHeight[] = ['s', 'm', 'l'];
  const h = heights.indexOf(panel.height);
  switch (change) {
    case 'wider':
      return { ...panel, width: Math.min(4, panel.width + 1) as PanelWidth };
    case 'narrower':
      return { ...panel, width: Math.max(1, panel.width - 1) as PanelWidth };
    case 'taller':
      return { ...panel, height: heights[Math.min(2, h + 1)] };
    case 'lower':
      return { ...panel, height: heights[Math.max(0, h - 1)] };
  }
}

/** Moves a panel one place up or down the list (the grid flows in that order). */
export function moved(panels: readonly PanelDef[], id: string, step: -1 | 1): PanelDef[] {
  const i = panels.findIndex((p) => p.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= panels.length) return [...panels];
  const out = [...panels];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
