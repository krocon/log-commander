import {
  SourceConfig,
  SourceState,
  SourceStatus,
  SyslogConfig,
  SyslogProtocol,
} from '../../core/log/log.models';
import { formatCount } from '../../shared/format';
import { databaseCounters, dbKey, dbLabel, parseDbConfig } from '../database/database-logic';
import { parseSftpConfig, remoteCounters, sftpKey, sftpLabel } from '../remote/remote-logic';
import {
  parseWinEventConfig,
  wineventCounters,
  wineventKey,
  wineventLabel,
} from '../winevent/winevent-logic';

/**
 * Sources without a file (prompt 016): defaults, checks of the dialog and of stored or shared configurations
 * (settings, workspaces), labels and status texts. The backend checks everything again.
 */

export const DEFAULT_SYSLOG_PORT = 5514;
export const LOOPBACK_V4 = '127.0.0.1';
/** Remembered sources in the settings. */
export const MAX_SAVED_SOURCES = 20;
/** Entries of the sender filter (the backend allows as many). */
export const MAX_ALLOW_ENTRIES = 64;
const MAX_ADDRESS_LENGTH = 64;

const PROTOCOLS: readonly SyslogProtocol[] = ['udp', 'tcp', 'both'];

/** A source remembered in the settings: what to open again, never a secret. */
export interface SavedSource {
  config: SourceConfig;
  keep: boolean;
}

export function defaultSyslogConfig(): SyslogConfig {
  return {
    kind: 'syslog',
    protocol: 'udp',
    address: LOOPBACK_V4,
    port: DEFAULT_SYSLOG_PORT,
    allow: [],
    allowRemote: false,
  };
}

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function stripBrackets(text: string): string {
  const t = text.trim();
  return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
}

/** An IPv6 address in any of its written forms (`::`, `fe80::1`, `::ffff:1.2.3.4`). */
function isV6(text: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(':') || text.includes(':::')) return false;
  if (/^:[^:]/.test(text) || /[^:]:$/.test(text)) return false;
  const double = text.split('::').length - 1;
  if (double > 1) return false;
  let groups = text.split(':');
  const last = groups[groups.length - 1];
  let extra = 0;
  if (last.includes('.')) {
    if (!V4.test(last)) return false;
    groups = groups.slice(0, -1);
    extra = 2;
  }
  if (groups.some((g) => g.length > 4 || g.includes('.'))) return false;
  const filled = groups.filter((g) => g !== '').length + extra;
  return double ? filled <= 7 : filled === 8 && groups.every((g) => g !== '');
}

/** An IP address (no host names: the backend does no DNS). Brackets around IPv6 are fine. */
export function isIpAddress(text: string): boolean {
  const t = stripBrackets(text);
  return V4.test(t) || isV6(t);
}

/** Only this computer: `127.x.x.x` or `::1`. */
export function isLoopbackAddress(text: string): boolean {
  const t = stripBrackets(text).toLowerCase();
  if (V4.test(t)) return t.startsWith('127.');
  return t === '::1' || t === '0:0:0:0:0:0:0:1';
}

/** An address or a network (`10.0.0.0/8`, `fd00::/8`) of the sender filter. */
export function isNetEntry(text: string): boolean {
  const t = text.trim();
  const [addr, prefix, ...rest] = t.split('/');
  if (rest.length || !isIpAddress(addr) || addr.startsWith('[')) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (V4.test(addr) ? 32 : 128);
}

/** Ports below 1024 need administrator or root rights. */
export function portNeedsPrivileges(port: number): boolean {
  return port > 0 && port < 1024;
}

/** The dialog's fields as typed. */
export interface SyslogForm {
  protocol: SyslogProtocol;
  address: string;
  port: string;
  /** One address or network per line (commas work too). */
  allowText: string;
  allowRemote: boolean;
}

export interface FormCheck {
  config: SyslogConfig | null;
  errors: { address?: string; port?: string; allow?: string; remote?: string };
}

export function formOf(config: SyslogConfig): SyslogForm {
  return {
    protocol: config.protocol,
    address: config.address,
    port: String(config.port),
    allowText: config.allow.join('\n'),
    allowRemote: config.allowRemote,
  };
}

export function splitAllow(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((e) => e.trim())
    .filter((e) => e !== '');
}

/** Checks the dialog; a configuration only if everything is fine. */
export function checkSyslogForm(form: SyslogForm): FormCheck {
  const errors: FormCheck['errors'] = {};
  const address = form.address.trim();
  if (!isIpAddress(address)) errors.address = 'Eine IP-Adresse, z. B. 127.0.0.1 (keine Hostnamen)';
  const port = Number(form.port.trim());
  if (!/^\d{1,5}$/.test(form.port.trim()) || port < 1 || port > 65535) {
    errors.port = 'Port von 1 bis 65535';
  }
  const allow = splitAllow(form.allowText);
  const bad = allow.filter((e) => !isNetEntry(e));
  if (bad.length) errors.allow = `Keine Adresse oder kein Netz: ${bad.slice(0, 3).join(', ')}`;
  else if (allow.length > MAX_ALLOW_ENTRIES)
    errors.allow = `Höchstens ${MAX_ALLOW_ENTRIES} Einträge`;
  if (!errors.address && !isLoopbackAddress(address) && !form.allowRemote) {
    errors.remote = 'Lauschen über diesen Rechner hinaus ausdrücklich erlauben';
  }
  if (Object.keys(errors).length) return { config: null, errors };
  return {
    config: {
      kind: 'syslog',
      protocol: form.protocol,
      address,
      port,
      allow,
      allowRemote: !isLoopbackAddress(address) && form.allowRemote,
    },
    errors,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A configuration from the settings or from a workspace (which may come from someone else): every field checked,
 * null if anything does not fit. Port 0 (chosen by the system) is not kept.
 */
export function parseSourceConfig(v: unknown, fromWorkspace = false): SourceConfig | null {
  // Prompt 017: a workspace keeps no key file (a path of someone else's machine).
  if (isObj(v) && v['kind'] === 'sftp') return parseSftpConfig(v, !fromWorkspace);
  // Prompt 018: a Windows event log channel (never a password in it).
  if (isObj(v) && v['kind'] === 'winevent') return parseWinEventConfig(v);
  // Prompt 019: a database query (never a password in it; a workspace keeps no CA file).
  if (isObj(v) && v['kind'] === 'database') return parseDbConfig(v, fromWorkspace);
  if (!isObj(v) || v['kind'] !== 'syslog') return null;
  const protocol = v['protocol'];
  const address = v['address'];
  const port = v['port'];
  const allow = v['allow'] ?? [];
  if (!PROTOCOLS.includes(protocol as SyslogProtocol)) return null;
  if (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH || !isIpAddress(address))
    return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Array.isArray(allow) || allow.length > MAX_ALLOW_ENTRIES) return null;
  if (!allow.every((e) => typeof e === 'string' && e.length <= MAX_ADDRESS_LENGTH && isNetEntry(e)))
    return null;
  const remote = !isLoopbackAddress(address);
  if (remote && v['allowRemote'] !== true) return null;
  return {
    kind: 'syslog',
    protocol: protocol as SyslogProtocol,
    address: address.trim(),
    port,
    allow: (allow as string[]).map((e) => e.trim()),
    allowRemote: remote,
  };
}

/** Listens beyond this computer: a workspace never starts such a source without asking. */
export function isRemoteSource(config: SourceConfig): boolean {
  return config.kind === 'syslog' && !isLoopbackAddress(config.address);
}

/** Same kind, protocol, address and port: the same listener; for SFTP the same server, user and file. */
export function sourceKey(config: SourceConfig): string {
  if (config.kind === 'sftp') return sftpKey(config);
  if (config.kind === 'winevent') return wineventKey(config);
  if (config.kind === 'database') return dbKey(config);
  return `${config.kind}|${config.protocol}|${stripBrackets(config.address).toLowerCase()}|${config.port}`;
}

/** Like the backend's label: „Syslog :5514“, „Syslog TCP 0.0.0.0:514“, `host:/var/log/app.log`. */
export function sourceLabel(config: SourceConfig): string {
  if (config.kind === 'sftp') return sftpLabel(config);
  if (config.kind === 'winevent') return wineventLabel(config);
  if (config.kind === 'database') return dbLabel(config);
  const proto = config.protocol === 'tcp' ? ' TCP' : config.protocol === 'both' ? ' UDP+TCP' : '';
  if (isLoopbackAddress(config.address)) return `Syslog${proto} :${config.port}`;
  const addr = stripBrackets(config.address);
  return addr.includes(':')
    ? `Syslog${proto} [${addr}]:${config.port}`
    : `Syslog${proto} ${addr}:${config.port}`;
}

/** Remembered sources: checked, without duplicates, newest first, at most `MAX_SAVED_SOURCES`. */
export function mergeSavedSources(saved: unknown): SavedSource[] {
  if (!Array.isArray(saved)) return [];
  const result: SavedSource[] = [];
  const keys = new Set<string>();
  for (const value of saved as unknown[]) {
    if (!isObj(value)) continue;
    const config = parseSourceConfig(value['config']);
    if (!config) continue;
    const key = sourceKey(config);
    if (keys.has(key)) continue;
    keys.add(key);
    result.push({ config, keep: value['keep'] === true });
    if (result.length >= MAX_SAVED_SOURCES) break;
  }
  return result;
}

/** Puts a source in front of the remembered ones. */
export function addSavedSource(saved: readonly SavedSource[], next: SavedSource): SavedSource[] {
  const key = sourceKey(next.config);
  return [next, ...saved.filter((s) => sourceKey(s.config) !== key)].slice(0, MAX_SAVED_SOURCES);
}

export interface SourcePill {
  label: string;
  cls: string;
}

export function sourcePill(state: SourceState): SourcePill {
  switch (state.kind) {
    case 'connecting':
      return { label: 'Verbinde …', cls: 'loading' };
    case 'loading':
      return { label: 'Lädt Bestand …', cls: 'loading' };
    case 'listening':
      return { label: 'Lauscht', cls: 'live' };
    case 'connected':
      return { label: 'Verbunden', cls: 'live' };
    case 'error':
      return { label: `Quelle: ${state.message}`, cls: 'bad' };
    case 'reconnecting':
      return { label: `Getrennt, neuer Versuch in ${state.retryInS} s`, cls: 'warn' };
    case 'stopped':
      return { label: 'Gestoppt', cls: 'warn' };
  }
}

/** „1.234 empfangen · 3 verworfen“, the other counters only when they are not 0. */
export function sourceCounters(
  status: SourceStatus,
  kind: SourceConfig['kind'] = 'syslog',
): string {
  if (kind === 'sftp') return remoteCounters(status);
  if (kind === 'winevent') return wineventCounters(status);
  if (kind === 'database') return databaseCounters(status);
  const parts = [`${formatCount(status.received)} empfangen`];
  if (status.dropped) parts.push(`${formatCount(status.dropped)} verworfen`);
  if (status.truncated) parts.push(`${formatCount(status.truncated)} gekürzt`);
  if (status.rejected) parts.push(`${formatCount(status.rejected)} abgewiesen`);
  if (status.connections) {
    parts.push(status.connections === 1 ? '1 Verbindung' : `${status.connections} Verbindungen`);
  }
  return parts.join(' · ');
}

/** Tooltip of the counters: what each one means. */
export const COUNTER_TITLE =
  'empfangen: angenommene Meldungen · verworfen: Spool kam nicht nach (Warteschlange voll oder Plattenfehler) · ' +
  'gekürzt: über 64 KB · abgewiesen: Absender nicht erlaubt oder zu viele Verbindungen';
