import { AppError, describeError } from '../../core/errors/app-error';
import {
  RemoteAuth,
  RemoteHost,
  RemoteTarget,
  SftpConfig,
  SourceStatus,
} from '../../core/log/log.models';
import { formatBytes, formatCount } from '../../shared/format';

/**
 * Remote log files over SSH/SFTP (prompt 017): defaults, checks of the dialog and of stored or shared
 * configurations, labels, the next step after an error (trust a host key, ask for a secret) and status texts.
 * The backend checks everything again. Nothing here ever holds a secret beyond the dialog's input.
 */

export const DEFAULT_START_MB = 50;
export const MAX_START_MB = 10_000;
export const DEFAULT_POLL_MS = 500;
export const MIN_POLL_MS = 200;
export const MAX_POLL_MS = 60_000;
const MAX_HOST = 255;
const MAX_USER = 64;
const MAX_PATH = 4096;
const AUTHS: readonly RemoteAuth[] = ['agent', 'key', 'password'];

export function defaultSftpConfig(): SftpConfig {
  return {
    kind: 'sftp',
    host: '',
    port: 22,
    user: '',
    auth: 'agent',
    keyFile: null,
    path: '',
    startMb: DEFAULT_START_MB,
    pollMs: DEFAULT_POLL_MS,
  };
}

const hasControl = (text: string): boolean =>
  [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** A host name, address or alias: no spaces, no `/`, `@`, no leading `-`. */
export function isHostName(text: string): boolean {
  const t = text.trim();
  return (
    t.length > 0 &&
    t.length <= MAX_HOST &&
    !hasControl(t) &&
    !/[\s/@]/.test(t) &&
    !t.startsWith('-')
  );
}

export function isUserName(text: string): boolean {
  const t = text.trim();
  return t.length <= MAX_USER && !hasControl(t) && !/[@:\s]/.test(t);
}

/** An absolute file path on the server. */
export function isRemoteFilePath(text: string): boolean {
  return (
    text.startsWith('/') && !text.endsWith('/') && text.length <= MAX_PATH && !hasControl(text)
  );
}

/** The dialog's fields as typed. */
export interface RemoteForm {
  host: string;
  port: string;
  user: string;
  auth: RemoteAuth;
  keyFile: string;
  path: string;
  whole: boolean;
  startMb: string;
  pollMs: string;
}

export interface RemoteFormCheck {
  config: SftpConfig | null;
  errors: Partial<
    Record<'host' | 'port' | 'user' | 'keyFile' | 'path' | 'startMb' | 'pollMs', string>
  >;
}

export function remoteFormOf(config: SftpConfig): RemoteForm {
  return {
    host: config.host,
    port: config.port ? String(config.port) : '',
    user: config.user,
    auth: config.auth,
    keyFile: config.keyFile ?? '',
    path: config.path,
    whole: config.startMb === null,
    startMb: String(config.startMb ?? DEFAULT_START_MB),
    pollMs: String(config.pollMs),
  };
}

const intIn = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

/** Checks the dialog; a configuration only if everything is fine. Empty port: from `~/.ssh/config`, else 22. */
export function checkRemoteForm(form: RemoteForm): RemoteFormCheck {
  const errors: RemoteFormCheck['errors'] = {};
  if (!isHostName(form.host)) errors.host = 'Hostname, Adresse oder Eintrag aus ~/.ssh/config';
  const port = form.port.trim() === '' ? 0 : intIn(form.port, 1, 65535);
  if (port === null) errors.port = 'Port von 1 bis 65535';
  if (!isUserName(form.user)) errors.user = 'Benutzername ohne @, : und Leerzeichen';
  const keyFile = form.keyFile.trim();
  if (
    form.auth === 'key' &&
    keyFile &&
    !(keyFile.startsWith('/') || /^[A-Za-z]:[\\/]/.test(keyFile))
  ) {
    errors.keyFile = 'Absoluter Pfad der Schlüsseldatei';
  }
  if (!isRemoteFilePath(form.path))
    errors.path = 'Absoluter Pfad einer Datei, z. B. /var/log/app.log';
  const startMb = form.whole ? null : intIn(form.startMb, 1, MAX_START_MB);
  if (!form.whole && startMb === null)
    errors.startMb = `1 bis ${MAX_START_MB.toLocaleString('de-DE')} MB`;
  const pollMs = intIn(form.pollMs, MIN_POLL_MS, MAX_POLL_MS);
  if (pollMs === null)
    errors.pollMs = `${MIN_POLL_MS} bis ${MAX_POLL_MS.toLocaleString('de-DE')} ms`;
  if (Object.keys(errors).length) return { config: null, errors };
  return {
    config: {
      kind: 'sftp',
      host: form.host.trim(),
      port: port ?? 0,
      user: form.user.trim(),
      auth: form.auth,
      keyFile: form.auth === 'key' && keyFile ? keyFile : null,
      path: form.path,
      startMb,
      pollMs: pollMs ?? DEFAULT_POLL_MS,
    },
    errors,
  };
}

/** What the folder browser and „Vergessen“ need: the target without path and start. */
export function targetOf(form: RemoteForm): RemoteTarget | null {
  if (!isHostName(form.host) || !isUserName(form.user)) return null;
  const port = form.port.trim() === '' ? 0 : intIn(form.port, 1, 65535);
  if (port === null) return null;
  const keyFile = form.keyFile.trim();
  return {
    host: form.host.trim(),
    port,
    user: form.user.trim(),
    auth: form.auth,
    keyFile: form.auth === 'key' && keyFile ? keyFile : null,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A configuration from the settings or from a workspace (which may come from someone else): every field checked,
 * null if anything does not fit. `withKeyFile: false` drops a key file (workspaces keep host, user, port, path,
 * the kind of login and the start only).
 */
export function parseSftpConfig(v: unknown, withKeyFile = true): SftpConfig | null {
  if (!isObj(v) || v['kind'] !== 'sftp') return null;
  const { host, port, user, auth, path } = v;
  const keyFile = v['keyFile'] ?? null;
  const startMb = v['startMb'] === undefined ? DEFAULT_START_MB : v['startMb'];
  const pollMs = v['pollMs'] ?? DEFAULT_POLL_MS;
  if (typeof host !== 'string' || !isHostName(host)) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (typeof user !== 'string' || !isUserName(user)) return null;
  if (!AUTHS.includes(auth as RemoteAuth)) return null;
  if (typeof path !== 'string' || !isRemoteFilePath(path)) return null;
  if (
    keyFile !== null &&
    (typeof keyFile !== 'string' || keyFile.length > MAX_PATH || hasControl(keyFile))
  )
    return null;
  if (
    startMb !== null &&
    (typeof startMb !== 'number' ||
      !Number.isInteger(startMb) ||
      startMb < 1 ||
      startMb > MAX_START_MB)
  )
    return null;
  if (
    typeof pollMs !== 'number' ||
    !Number.isInteger(pollMs) ||
    pollMs < MIN_POLL_MS ||
    pollMs > MAX_POLL_MS
  )
    return null;
  return {
    kind: 'sftp',
    host: host.trim(),
    port,
    user: user.trim(),
    auth: auth as RemoteAuth,
    keyFile: withKeyFile && auth === 'key' ? (keyFile as string | null) : null,
    path,
    startMb: startMb as number | null,
    pollMs,
  };
}

/** Like the backend's label: `host:/var/log/app.log`. */
export function sftpLabel(config: SftpConfig): string {
  return `${config.host}:${config.path}`;
}

/** `user@host:port` as typed (empty parts: from `~/.ssh/config`). */
export function sftpAddress(config: SftpConfig | RemoteTarget): string {
  const user = config.user ? `${config.user}@` : '';
  const port = config.port && config.port !== 22 ? `:${config.port}` : '';
  return `${user}${config.host}${port}`;
}

/** Same server, user and file: the same tab. */
export function sftpKey(config: SftpConfig): string {
  return `sftp|${config.user}@${config.host.toLowerCase()}:${config.port}|${config.path}`;
}

/** Takes user and port from `~/.ssh/config` where the form leaves them empty. */
export function applyHost(form: RemoteForm, host: RemoteHost | undefined): RemoteForm {
  if (!host) return form;
  return {
    ...form,
    user: form.user || host.user || '',
    port: form.port || (host.port ? String(host.port) : ''),
  };
}

/** What the dialog does after a failed connect. */
export type RemoteStep =
  | { kind: 'trust'; keyType: string; fingerprint: string }
  | { kind: 'secret'; secret: 'password' | 'passphrase'; wrong: boolean }
  | { kind: 'changed'; message: string }
  | { kind: 'error'; message: string };

export function nextStep(error: AppError): RemoteStep {
  const detail = error.remote;
  switch (error.code) {
    case 'host_key_unknown':
      if (detail?.fingerprint)
        return { kind: 'trust', keyType: detail.keyType ?? '', fingerprint: detail.fingerprint };
      break;
    case 'host_key_changed':
      return { kind: 'changed', message: describeError(error) };
    case 'secret_required':
      return {
        kind: 'secret',
        secret: detail?.secret ?? 'password',
        wrong: detail?.wrong ?? false,
      };
  }
  return { kind: 'error', message: describeError(error) };
}

/** The folder above `path` (`/` stays `/`). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

export function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** The folder to browse first: the one of the typed path, else the home folder (empty). */
export function browseStart(path: string): string {
  return path.startsWith('/') ? (path.endsWith('/') ? path : parentPath(path)) : '';
}

/** „1.234 Zeilen · 12,3 MB · 4 ms · lädt noch 30 MB“ for the status bar. */
export function remoteCounters(status: SourceStatus): string {
  const parts = [`${formatCount(status.received)} Zeilen`, formatBytes(status.bytes)];
  if (status.latencyMs !== null) parts.push(`${status.latencyMs} ms`);
  if (status.pendingBytes > 0) parts.push(`lädt noch ${formatBytes(status.pendingBytes)}`);
  if (status.truncated) parts.push(`${formatCount(status.truncated)} gekürzt`);
  return parts.join(' · ');
}

export const REMOTE_COUNTER_TITLE =
  'Zeilen: aus der Datei auf dem Server · Bytes: übertragen · ms: Antwortzeit der letzten Prüfung · ' +
  'gekürzt: Zeilen über 1 MB';
