import { AppError, describeError } from '../../core/errors/app-error';
import { ColumnLayout } from '../../core/settings/settings.models';
import { SourceStatus, WinAuth, WinEventConfig, WinTarget } from '../../core/log/log.models';
import { formatCount } from '../../shared/format';

/**
 * Windows event logs (prompt 018): defaults, checks of the dialog and of stored or shared configurations, labels,
 * status texts and the column layout of the format. The backend checks everything again; nothing here holds a
 * password beyond the dialog's input.
 */

export const WINEVENT_PROFILE = 'winevent';
export const DEFAULT_HOURS = 24;
export const MAX_HOURS = 24 * 366 * 10;
/** Sources at a time (backend `MAX_SOURCES`): at most this many channels per start. */
export const MAX_CHANNELS = 8;
const MAX_CHANNEL = 256;
const MAX_COMPUTER = 253;
const MAX_USER = 256;
const AUTHS: readonly WinAuth[] = ['current', 'password'];

/** The periods of the dialog; null: everything the channel holds. */
export const PERIODS: readonly { hours: number | null; label: string }[] = [
  { hours: 1, label: 'Letzte Stunde' },
  { hours: 24, label: 'Letzte 24 Stunden' },
  { hours: 24 * 7, label: 'Letzte 7 Tage' },
  { hours: 24 * 30, label: 'Letzte 30 Tage' },
  { hours: null, label: 'Alles (kann Millionen Ereignisse sein)' },
];

/** The classic logs, offered before the list of the computer is loaded. */
export const USUAL_CHANNELS: readonly string[] = ['Application', 'System', 'Security', 'Setup'];

const hasControl = (text: string): boolean =>
  [...text].some((c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 || (n >= 0x7f && n <= 0x9f);
  });

/** Empty (this computer), a host name or an address; `\\srv01` is `srv01`. */
export function computerName(text: string): string {
  return text.trim().replace(/^\\+/, '');
}

export function isComputerName(text: string): boolean {
  const t = computerName(text);
  return t.length <= MAX_COMPUTER && /^[A-Za-z0-9.\-_:]*$/.test(t) && !/^[-.]/.test(t);
}

/** `DOMAIN\user`, `user@domain` or `user`. */
export function isWinUser(text: string): boolean {
  const t = text.trim();
  return (
    t.length <= MAX_USER &&
    !hasControl(t) &&
    !/["/[\]:;|=,+*?<>]/.test(t) &&
    t.split('\\').length <= 2
  );
}

export function isChannel(text: string): boolean {
  return text.length > 0 && text.length <= MAX_CHANNEL && text.trim() === text && !hasControl(text);
}

/** What the dialog edits. */
export interface WinEventForm {
  computer: string;
  auth: WinAuth;
  user: string;
  channels: string[];
  hours: number | null;
  xml: boolean;
  /** Several channels: one merged tab (006) besides the tabs of the channels. */
  merge: boolean;
}

export function defaultWinEventForm(): WinEventForm {
  return {
    computer: '',
    auth: 'current',
    user: '',
    channels: [],
    hours: DEFAULT_HOURS,
    xml: true,
    merge: false,
  };
}

export function formOfConfig(config: WinEventConfig): WinEventForm {
  return {
    computer: config.computer,
    auth: config.auth,
    user: config.user,
    channels: [config.channel],
    hours: config.hours,
    xml: config.xml,
    merge: false,
  };
}

export interface WinEventCheck {
  target: WinTarget | null;
  configs: WinEventConfig[];
  errors: { computer?: string; user?: string; channels?: string };
}

/** The target of the form; null if computer or user do not fit. This computer: always the logged-on identity. */
export function checkWinEventForm(form: WinEventForm): WinEventCheck {
  const errors: WinEventCheck['errors'] = {};
  const computer = computerName(form.computer);
  if (!isComputerName(form.computer)) errors.computer = 'Ein Rechnername oder eine Adresse';
  const remote = computer !== '';
  const auth: WinAuth = remote ? form.auth : 'current';
  const user = auth === 'password' ? form.user.trim() : '';
  if (auth === 'password' && (!user || !isWinUser(user))) {
    errors.user = 'Benutzer, z. B. FIRMA\\name oder name@firma.de';
  }
  const target = errors.computer || errors.user ? null : { computer, auth, user };
  if (!form.channels.length) errors.channels = 'Mindestens einen Kanal wählen';
  else if (form.channels.length > MAX_CHANNELS)
    errors.channels = `Höchstens ${MAX_CHANNELS} Kanäle auf einmal`;
  const configs =
    target && !errors.channels
      ? form.channels.filter(isChannel).map((channel) => ({
          kind: 'winevent' as const,
          ...target,
          channel,
          hours: form.hours,
          xml: form.xml,
        }))
      : [];
  return { target, configs, errors };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A configuration from the settings or a workspace (maybe someone else's): every field checked, null otherwise. */
export function parseWinEventConfig(v: unknown): WinEventConfig | null {
  if (!isObj(v) || v['kind'] !== 'winevent') return null;
  const channel = v['channel'];
  const computer = v['computer'] ?? '';
  const auth = v['auth'] ?? 'current';
  const user = v['user'] ?? '';
  const hours = v['hours'] === undefined ? DEFAULT_HOURS : v['hours'];
  const xml = v['xml'] ?? true;
  if (typeof channel !== 'string' || !isChannel(channel)) return null;
  if (typeof computer !== 'string' || !isComputerName(computer)) return null;
  if (!AUTHS.includes(auth as WinAuth)) return null;
  if (typeof user !== 'string' || !isWinUser(user)) return null;
  const name = computerName(computer);
  if (auth === 'password' && (!name || !user.trim())) return null;
  if (
    hours !== null &&
    (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
  )
    return null;
  if (typeof xml !== 'boolean') return null;
  return {
    kind: 'winevent',
    channel,
    computer: name,
    auth: auth as WinAuth,
    user: auth === 'password' ? user.trim() : '',
    hours: hours as number | null,
    xml,
  };
}

/** The same computer and channel: the same source. */
export function wineventKey(config: WinEventConfig): string {
  return `winevent|${computerName(config.computer).toLowerCase()}|${config.channel.toLowerCase()}`;
}

/** Like the backend: „Ereignisse: System“, „Ereignisse srv01: System“. */
export function wineventLabel(config: WinEventConfig): string {
  const computer = computerName(config.computer);
  return computer ? `Ereignisse ${computer}: ${config.channel}` : `Ereignisse: ${config.channel}`;
}

/** „dieser Rechner“ or the computer with how it is logged on to. */
export function wineventWhere(config: WinEventConfig): string {
  const computer = computerName(config.computer);
  if (!computer) return 'dieser Rechner';
  return config.auth === 'password' ? `${computer} als ${config.user}` : computer;
}

/** Channels matching the filter (case-insensitive parts in any order), the chosen ones always. */
export function filterChannels(
  all: readonly string[],
  query: string,
  chosen: readonly string[] = [],
): string[] {
  const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((c) => chosen.includes(c) || parts.every((p) => c.toLowerCase().includes(p)));
}

/** „1.234 Ereignisse · 2 gekürzt · 1 Lücke“. */
export function wineventCounters(status: SourceStatus): string {
  const parts = [`${formatCount(status.received)} Ereignisse`];
  if (status.truncated) parts.push(`${formatCount(status.truncated)} gekürzt`);
  if (status.dropped) parts.push(`${formatCount(status.dropped)} verworfen`);
  if (status.rejected) parts.push(`${formatCount(status.rejected)} nicht lesbar`);
  const gaps = status.gaps ?? 0;
  if (gaps) parts.push(gaps === 1 ? '1 Lücke' : `${formatCount(gaps)} Lücken`);
  return parts.join(' · ');
}

export const WINEVENT_COUNTER_TITLE =
  'Ereignisse: gelesen und in den Spool geschrieben · gekürzt: Meldung über 32 000 oder XML über 64 000 Zeichen · ' +
  'nicht lesbar: Ereignis ließ sich nicht darstellen (Platzhalter-Zeile) · ' +
  'Lücke: das Protokoll wurde geleert oder überschrieben, während die Verbindung weg war';

/** Errors of the event log in words; the backend's texts already say what to do (rights, firewall). */
export function describeWinEventError(error: AppError): string {
  switch (error.code) {
    case 'permission_denied':
    case 'not_found':
    case 'connection_failed':
    case 'auth_failed':
    case 'io':
    case 'unsupported':
    case 'invalid_source':
      return error.message;
    case 'secret_required':
      return error.remote?.wrong ? 'Passwort nicht angenommen' : 'Passwort nötig';
    default:
      return describeError(error);
  }
}

/** Columns shown by default (prompt 018): time, level, provider, event ID, message; the rest hidden. */
export function defaultColumnLayout(profileId: string): ColumnLayout | undefined {
  if (profileId !== WINEVENT_PROFILE) return undefined;
  return {
    order: [
      'timestamp',
      'level',
      'provider',
      'eventId',
      'message',
      'channel',
      'computer',
      'task',
      'user',
      'recordId',
      'xml',
    ],
    widths: {},
    hidden: ['channel', 'computer', 'task', 'user', 'recordId', 'xml'],
  };
}
