import { AppError, describeError } from '../../core/errors/app-error';
import {
  DbAuth,
  DbConfig,
  DbEngine,
  DbPreview,
  DbTable,
  SourceStatus,
  TlsMode,
} from '../../core/log/log.models';
import { formatCount } from '../../shared/format';

/**
 * Logs from databases (prompt 019): engines, defaults, checks of the dialog and of stored or shared configurations
 * (mirroring `DbConfig::validate` in sources/database/mod.rs), the query of „Tabelle wählen“, labels, status texts
 * and the preview table. The backend checks everything again (and the query much more thoroughly); nothing here
 * holds a password beyond the dialog's input.
 */

export const DEFAULT_INTERVAL_MS = 2000;
export const MIN_INTERVAL_MS = 500;
export const MAX_INTERVAL_MS = 3_600_000;
export const DEFAULT_START_LAST = 1000;
export const MAX_START_LAST = 1_000_000;
const MAX_NAME = 128;
const MAX_HOST = 253;
const MAX_PATH = 4096;
const MAX_QUERY = 64 * 1024;

export const ENGINES: readonly { id: DbEngine; label: string; port: number }[] = [
  { id: 'postgres', label: 'PostgreSQL', port: 5432 },
  { id: 'mysql', label: 'MySQL / MariaDB', port: 3306 },
  { id: 'mssql', label: 'SQL Server', port: 1433 },
  { id: 'sqlite', label: 'SQLite (Datei)', port: 0 },
];
const ENGINE_IDS: readonly DbEngine[] = ENGINES.map((e) => e.id);
const AUTHS: readonly DbAuth[] = ['password', 'none'];
const TLS_MODES: readonly TlsMode[] = ['verify', 'noVerify', 'off'];

export const TLS_CHOICES: readonly { id: TlsMode; label: string }[] = [
  { id: 'verify', label: 'TLS mit Zertifikatsprüfung (empfohlen)' },
  { id: 'noVerify', label: 'TLS ohne Zertifikatsprüfung' },
  { id: 'off', label: 'Ohne TLS (unverschlüsselt)' },
];

export function defaultPort(engine: DbEngine): number {
  return ENGINES.find((e) => e.id === engine)?.port ?? 0;
}

const hasControl = (text: string): boolean =>
  [...text].some((c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 || (n >= 0x7f && n <= 0x9f);
  });

export function isHost(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= MAX_HOST && /^[A-Za-z0-9.\-_:]+$/.test(t) && !/^[-.]/.test(t);
}

const isAbsolutePath = (p: string): boolean =>
  p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

const isName = (text: string, needed: boolean): boolean =>
  text.length <= MAX_NAME && !hasControl(text) && (!needed || text.trim().length > 0);

/** What the dialog edits; numbers as typed. */
export interface DbForm {
  engine: DbEngine;
  host: string;
  /** Empty: the engine's default. */
  port: string;
  database: string;
  user: string;
  auth: DbAuth;
  tls: TlsMode;
  caFile: string;
  path: string;
  query: string;
  keyColumn: string;
  timeColumn: string;
  levelColumn: string;
  /** Seconds, decimals allowed. */
  interval: string;
  startAll: boolean;
  startLast: string;
}

export function defaultDbForm(): DbForm {
  return {
    engine: 'postgres',
    host: 'localhost',
    port: '',
    database: '',
    user: '',
    auth: 'password',
    tls: 'verify',
    caFile: '',
    path: '',
    query: '',
    keyColumn: 'id',
    timeColumn: '',
    levelColumn: '',
    interval: String(DEFAULT_INTERVAL_MS / 1000),
    startAll: false,
    startLast: String(DEFAULT_START_LAST),
  };
}

export function formOfDbConfig(config: DbConfig): DbForm {
  return {
    engine: config.engine,
    host: config.host,
    port: config.port ? String(config.port) : '',
    database: config.database,
    user: config.user,
    auth: config.auth,
    tls: config.tls,
    caFile: config.caFile,
    path: config.path,
    query: config.query,
    keyColumn: config.keyColumn,
    timeColumn: config.timeColumn,
    levelColumn: config.levelColumn,
    interval: String(config.intervalMs / 1000),
    startAll: config.startLast === null,
    startLast: String(config.startLast ?? DEFAULT_START_LAST),
  };
}

export interface DbCheck {
  /** Server, login and TLS fit: enough to list tables. */
  connection: DbConfig | null;
  /** Everything fits: enough for the preview and to open. */
  config: DbConfig | null;
  errors: Partial<
    Record<
      | 'host'
      | 'port'
      | 'user'
      | 'database'
      | 'caFile'
      | 'path'
      | 'query'
      | 'keyColumn'
      | 'timeColumn'
      | 'levelColumn'
      | 'interval'
      | 'startLast',
      string
    >
  >;
}

/** The first word of the query must be SELECT or WITH; `;` only at the end (the backend checks properly). */
function queryError(query: string): string | undefined {
  const q = query.trim().replace(/;+\s*$/, '');
  if (!q) return 'Abfrage fehlt';
  if (query.length > MAX_QUERY) return 'Abfrage länger als 64 KB';
  if (!/^(select|with)\b/i.test(q)) return 'Nur SELECT-Abfragen';
  return undefined;
}

export function checkDbForm(form: DbForm): DbCheck {
  const errors: DbCheck['errors'] = {};
  const sqlite = form.engine === 'sqlite';
  let port = 0;
  if (sqlite) {
    const path = form.path.trim();
    if (!path || path.length > MAX_PATH || hasControl(path)) errors.path = 'SQLite-Datei wählen';
    else if (!isAbsolutePath(path)) errors.path = 'Mit vollem Pfad';
  } else {
    if (!isHost(form.host)) errors.host = 'Hostname oder IP-Adresse';
    if (form.port.trim()) {
      port = Number(form.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Port 1–65535';
    }
    if (!isName(form.user, true)) errors.user = 'Benutzer fehlt';
    if (!isName(form.database, false)) errors.database = 'Kein Datenbankname';
    const ca = form.caFile.trim();
    if (ca && (ca.length > MAX_PATH || hasControl(ca) || !isAbsolutePath(ca)))
      errors.caFile = 'CA-Datei mit vollem Pfad';
  }
  const auth: DbAuth = sqlite ? 'none' : form.engine === 'mssql' ? 'password' : form.auth;
  const base = {
    kind: 'database' as const,
    engine: form.engine,
    host: sqlite ? '' : form.host.trim(),
    port: sqlite ? 0 : port,
    database: sqlite ? '' : form.database.trim(),
    user: sqlite ? '' : form.user.trim(),
    auth,
    tls: sqlite ? ('verify' as const) : form.tls,
    caFile: sqlite || form.tls !== 'verify' ? '' : form.caFile.trim(),
    path: sqlite ? form.path.trim() : '',
  };
  const connectionOk = Object.keys(errors).length === 0;
  const qe = queryError(form.query);
  if (qe) errors.query = qe;
  if (!isName(form.keyColumn, true)) errors.keyColumn = 'Schlüsselspalte fehlt';
  if (!isName(form.timeColumn, false)) errors.timeColumn = 'Kein Spaltenname';
  if (!isName(form.levelColumn, false)) errors.levelColumn = 'Kein Spaltenname';
  const intervalMs = Math.round(Number(form.interval.replace(',', '.')) * 1000);
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)
    errors.interval = 'Abstand 0,5 s bis 1 h';
  let startLast: number | null = null;
  if (!form.startAll) {
    startLast = Number(form.startLast);
    if (!Number.isInteger(startLast) || startLast < 1 || startLast > MAX_START_LAST)
      errors.startLast = `1–${formatCount(MAX_START_LAST)} Zeilen`;
  }
  const full = {
    ...base,
    query: form.query.trim(),
    keyColumn: form.keyColumn.trim(),
    timeColumn: form.timeColumn.trim(),
    levelColumn: form.levelColumn.trim(),
    intervalMs,
    startLast,
  };
  const empty = {
    query: '',
    keyColumn: '',
    timeColumn: '',
    levelColumn: '',
    intervalMs: DEFAULT_INTERVAL_MS,
    startLast: DEFAULT_START_LAST,
  };
  return {
    connection: connectionOk ? { ...base, ...empty } : null,
    config: Object.keys(errors).length === 0 ? full : null,
    errors,
  };
}

/** `"name"` (PostgreSQL, SQLite), `` `name` `` (MySQL), `[name]` (SQL Server), quotes doubled. */
export function quoteIdent(name: string, engine: DbEngine): string {
  switch (engine) {
    case 'mysql':
      return '`' + name.replaceAll('`', '``') + '`';
    case 'mssql':
      return '[' + name.replaceAll(']', ']]') + ']';
    default:
      return '"' + name.replaceAll('"', '""') + '"';
  }
}

/** „Tabelle wählen“: `SELECT * FROM "schema"."table"`. */
export function tableQuery(table: DbTable, engine: DbEngine): string {
  const name = quoteIdent(table.name, engine);
  return table.schema
    ? `SELECT * FROM ${quoteIdent(table.schema, engine)}.${name}`
    : `SELECT * FROM ${name}`;
}

export function tableLabel(table: DbTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/** Usual names of the columns, guessed from the preview's columns (the user can change them). */
export function guessColumns(names: readonly string[]): {
  key?: string;
  time?: string;
  level?: string;
} {
  const find = (candidates: readonly string[]) =>
    names.find((n) => candidates.includes(n.toLowerCase()));
  const time = find([
    'timestamp',
    'ts',
    'time',
    'logged_at',
    'created_at',
    'created',
    'date',
    'datetime',
    'zeit',
    'eventtime',
  ]);
  const level = find(['level', 'severity', 'loglevel', 'log_level', 'lvl', 'sev', 'priority']);
  const key = find(['id', 'log_id', 'logid', 'seq', 'sequence', 'rowid']) ?? time;
  return { key, time, level };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string | null =>
  v === undefined ? fallback : typeof v === 'string' ? v : null;

/**
 * A configuration from the settings or a workspace (maybe someone else's): every field checked, null otherwise.
 * A workspace keeps no CA file (a path of someone else's machine).
 */
export function parseDbConfig(v: unknown, fromWorkspace = false): DbConfig | null {
  if (!isObj(v) || v['kind'] !== 'database') return null;
  const engine = v['engine'];
  if (!ENGINE_IDS.includes(engine as DbEngine)) return null;
  const fields = [
    'host',
    'database',
    'user',
    'caFile',
    'path',
    'timeColumn',
    'levelColumn',
  ] as const;
  const text: Partial<Record<(typeof fields)[number], string>> = {};
  for (const f of fields) {
    const value = str(v[f]);
    if (value === null || value.length > MAX_PATH || hasControl(value)) return null;
    text[f] = value;
  }
  const query = v['query'];
  const keyColumn = v['keyColumn'];
  if (typeof query !== 'string' || typeof keyColumn !== 'string') return null;
  const auth = v['auth'] ?? 'password';
  const tls = v['tls'] ?? 'verify';
  const port = v['port'] ?? 0;
  const intervalMs = v['intervalMs'] ?? DEFAULT_INTERVAL_MS;
  const startLast = v['startLast'] === undefined ? DEFAULT_START_LAST : v['startLast'];
  if (!AUTHS.includes(auth as DbAuth) || !TLS_MODES.includes(tls as TlsMode)) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (typeof intervalMs !== 'number' || !Number.isInteger(intervalMs)) return null;
  if (startLast !== null && typeof startLast !== 'number') return null;
  const form: DbForm = {
    engine: engine as DbEngine,
    host: text.host ?? '',
    port: port ? String(port) : '',
    database: text.database ?? '',
    user: text.user ?? '',
    auth: auth as DbAuth,
    tls: tls as TlsMode,
    caFile: fromWorkspace ? '' : (text.caFile ?? ''),
    path: text.path ?? '',
    query,
    keyColumn,
    timeColumn: text.timeColumn ?? '',
    levelColumn: text.levelColumn ?? '',
    interval: String(intervalMs / 1000),
    startAll: startLast === null,
    startLast: String(startLast ?? DEFAULT_START_LAST),
  };
  return checkDbForm(form).config;
}

/** `host:port/database` or the SQLite file's name. */
export function dbWhere(config: DbConfig): string {
  if (config.engine === 'sqlite') return config.path.split(/[\\/]/).pop() || config.path;
  const port = config.port || defaultPort(config.engine);
  return config.database ? `${config.host}:${port}/${config.database}` : `${config.host}:${port}`;
}

/** The first table after a top-level FROM, like the backend's `table_of` (strings and subqueries skipped). */
export function tableOf(query: string): string | null {
  const flat = query
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  let depth = 0;
  let top = '';
  for (const c of flat) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0) top += c;
  }
  const part = String.raw`(?:"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[(?:[^\]]|\]\])+\]|[\p{L}\p{N}_$#@]+)`;
  const m = new RegExp(String.raw`\bfrom\s+(${part}(?:\s*\.\s*${part})*)`, 'iu').exec(top);
  if (!m) return null;
  return m[1]
    .split(/\s*\.\s*/)
    .map((p) => p.replace(/^["`[]|["`\]]$/g, ''))
    .join('.');
}

/** Like the backend: `db:schema.table`, else `db:database`. */
export function dbLabel(config: DbConfig): string {
  const table = tableOf(config.query);
  if (table) return `db:${table}`;
  if (config.engine === 'sqlite') return `db:${dbWhere(config)}`;
  return `db:${config.database || config.host}`;
}

/** The same server or file and query: the same source. */
export function dbKey(config: DbConfig): string {
  return [
    'database',
    config.engine,
    config.host.toLowerCase(),
    config.port || defaultPort(config.engine),
    config.database,
    config.path,
    config.query.trim(),
  ].join('|');
}

/** The query of a workspace for its confirmation: one line, at most 500 characters. */
export function workspaceQuery(query: string): string {
  const one = query.replace(/\s+/g, ' ').trim();
  return one.length > 500 ? `${one.slice(0, 500)} …` : one;
}

/** A warning when the connection is not encrypted or not checked; null with full TLS (and for SQLite). */
export function tlsWarning(config: Pick<DbConfig, 'engine' | 'tls'>): string | null {
  if (config.engine === 'sqlite') return null;
  if (config.tls === 'noVerify')
    return 'Ohne Zertifikatsprüfung kann sich ein anderer Rechner als der Server ausgeben und Passwort und Daten mitlesen.';
  if (config.tls === 'off')
    return 'Ohne TLS gehen Passwort und Daten unverschlüsselt durchs Netz (SQL Server verschlüsselt nur die Anmeldung).';
  return null;
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** „1.234 Zeilen · letzte Abfrage 10:15:30 (12 ms) · 2 gekürzt · 1 Lücke“. */
export function databaseCounters(status: SourceStatus): string {
  const parts = [`${formatCount(status.received)} Zeilen`];
  if (status.polledAtMs) {
    const took = status.latencyMs !== null ? ` (${formatCount(status.latencyMs)} ms)` : '';
    parts.push(`letzte Abfrage ${time(status.polledAtMs)}${took}`);
  }
  if (status.truncated) parts.push(`${formatCount(status.truncated)} gekürzt`);
  if (status.dropped) parts.push(`${formatCount(status.dropped)} verworfen`);
  if (status.rejected) parts.push(`${formatCount(status.rejected)} ohne Schlüssel`);
  const gaps = status.gaps ?? 0;
  if (gaps) parts.push(gaps === 1 ? '1 Lücke' : `${formatCount(gaps)} Lücken`);
  return parts.join(' · ');
}

export const DATABASE_COUNTER_TITLE =
  'Zeilen: gelesen und in den Spool geschrieben · letzte Abfrage: Ende und Dauer · ' +
  'gekürzt: Text über 32 000 Zeichen oder Zeile über 256 KB · ' +
  'Lücke: mehr als 100 000 Zeilen mit demselben Schlüssel, spätere mit diesem Schlüssel können fehlen';

/** Errors of the database in words; the backend's texts already say what to do (TLS, rights). */
export function describeDbError(error: AppError): string {
  switch (error.code) {
    case 'secret_required':
      return error.remote?.wrong ? 'Passwort nicht angenommen' : 'Passwort nötig';
    case 'invalid_query':
    case 'invalid_source':
    case 'connection_failed':
    case 'permission_denied':
    case 'auth_failed':
    case 'not_found':
    case 'unsupported':
    case 'too_large':
      return error.message;
    default:
      return describeError(error);
  }
}

export interface PreviewTable {
  columns: string[];
  rows: string[][];
}

/** The preview's lines as a table (keys of the first line in order); values as text, never as markup. */
export function previewTable(preview: DbPreview): PreviewTable {
  const objects = preview.lines.map((line) => {
    try {
      const v: unknown = JSON.parse(line);
      return isObj(v) ? v : {};
    } catch {
      return {};
    }
  });
  const columns: string[] = [];
  for (const o of objects)
    for (const k of Object.keys(o)) if (!columns.includes(k)) columns.push(k);
  const cell = (v: unknown): string =>
    v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return { columns, rows: objects.map((o) => columns.map((c) => cell(o[c]))) };
}
