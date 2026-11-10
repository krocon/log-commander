/** Mirrors `AppError` in src-tauri/src/error.rs. */
export type ErrorCode =
  | 'not_found'
  | 'permission_denied'
  | 'is_a_directory'
  | 'io'
  | 'unknown_session'
  | 'unknown_profile'
  | 'invalid_profile'
  | 'invalid_search'
  | 'too_large'
  | 'no_timestamps'
  | 'invalid_merge'
  | 'invalid_rule'
  | 'invalid_query'
  | 'unknown_view'
  | 'too_many_views'
  | 'invalid_export'
  | 'file_changed'
  | 'invalid_workspace'
  | 'invalid_source'
  | 'port_in_use'
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'auth_failed'
  | 'secret_required'
  | 'connection_failed'
  | 'unsupported'
  /** A newer call of the same kind ran first (prompt 023): nothing to show, the newer one did the work. */
  | 'superseded'
  | 'backend_unavailable'
  | 'unknown';

export interface AppError {
  code: ErrorCode;
  message: string;
  path?: string;
  /** The node of a filter expression (prompt 010) or the extraction rule (prompt 011) the error is about. */
  nodeId?: string;
  /** SSH details (prompt 017); never a secret. */
  remote?: RemoteDetail;
}

/** Mirrors `RemoteDetail` in error.rs. */
export interface RemoteDetail {
  keyType?: string;
  /** `SHA256:…` */
  fingerprint?: string;
  /** Where the other key is recorded (changed host key). */
  knownHosts?: string;
  knownHostsLine?: number;
  /** Which secret is needed. */
  secret?: 'password' | 'passphrase';
  /** The secret given was not accepted. */
  wrong: boolean;
  /** Why a host key is refused: other_key, revoked, unusable, cert_authority, unknown_marker, unreadable. */
  reason?: string;
}

/** The refusal of a host key in words (security review 017 M1). */
function hostKeyRefusal(error: AppError): string {
  const r = error.remote;
  const where = `${r?.knownHosts ?? 'known_hosts'}${r?.knownHostsLine ? `, Zeile ${r.knownHostsLine}` : ''}`;
  const shown = r?.fingerprint ?? '?';
  switch (r?.reason) {
    case 'revoked':
      return `Host-Schlüssel ist gesperrt (@revoked in ${where}), Verbindung abgebrochen (${shown})`;
    case 'unusable':
      return `Für diesen Server steht ein unlesbarer Eintrag in ${where}, Verbindung abgebrochen (${shown})`;
    case 'cert_authority':
      return `Für diesen Server gilt eine Zertifizierungsstelle (@cert-authority in ${where}); Host-Zertifikate werden nicht unterstützt, Verbindung abgebrochen`;
    case 'unknown_marker':
      return `Für diesen Server steht ein Eintrag mit unbekannter Markierung in ${where}, Verbindung abgebrochen`;
    case 'unreadable':
      return `${r?.knownHosts ?? 'known_hosts'} lässt sich nicht lesen, der Host-Schlüssel kann nicht geprüft werden`;
    default:
      return `Host-Schlüssel hat sich geändert (${shown}), Verbindung abgebrochen. Eingetragen ist ein anderer in ${where}`;
  }
}

export function toAppError(e: unknown): AppError {
  if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
    return e as AppError;
  }
  return { code: 'unknown', message: String(e) };
}

export function describeError(error: AppError): string {
  const where = error.path ? `: ${error.path}` : '';
  switch (error.code) {
    case 'not_found':
      return `Datei nicht gefunden${where}`;
    case 'permission_denied':
      return `Keine Leserechte${where}`;
    case 'is_a_directory':
      return `Das ist ein Ordner, keine Datei${where}`;
    case 'no_timestamps':
      return `Keine Zeitstempel in den ersten 200 Zeilen, Zusammenführen nicht möglich${where}`;
    case 'invalid_merge':
      return `Zusammenführen nicht möglich: ${error.message}${where}`;
    case 'invalid_rule':
      return `Regel ungültig: ${error.message}`;
    case 'invalid_query':
      return `Abfrage nicht ausführbar: ${error.message}`;
    case 'unknown_view':
      return 'Dieser Filter-Tab ist nicht mehr offen';
    case 'too_many_views':
      return 'Höchstens 8 Tabs je Datei, zuerst einen Filter-Tab schließen';
    case 'invalid_export':
      return `Export nicht möglich: ${error.message}${where}`;
    case 'file_changed':
      return 'Die Datei wurde während des Exports geleert oder neu begonnen, Export abgebrochen';
    case 'invalid_workspace':
      return `Kein gültiger Arbeitsstand: ${error.message}${where}`;
    case 'invalid_source':
      return `Quelle nicht möglich: ${error.message}`;
    case 'port_in_use':
      return `Port belegt: ${error.message}. Anderen Port wählen oder das andere Programm beenden`;
    case 'host_key_unknown':
      return `Unbekannter Host-Schlüssel: ${error.remote?.keyType ?? ''} ${error.remote?.fingerprint ?? ''}`;
    case 'host_key_changed':
      return hostKeyRefusal(error);
    case 'auth_failed':
      return `Anmeldung abgelehnt: ${error.message}`;
    case 'secret_required':
      if (error.remote?.secret === 'passphrase')
        return error.remote.wrong
          ? 'Falsche Passphrase'
          : 'Die Schlüsseldatei braucht eine Passphrase';
      return error.remote?.wrong ? 'Passwort nicht angenommen' : 'Passwort nötig';
    case 'connection_failed':
      return `Verbindung fehlgeschlagen: ${error.message}`;
    case 'unsupported':
      return `Nicht unterstützt: ${error.message}`;
    case 'backend_unavailable':
      return 'Desktop-Backend nicht verfügbar (läuft die App im Browser?)';
    default:
      return `${error.message}${where}`;
  }
}

/** A call the backend dropped because a newer one of its kind came first: not an error for the user. */
export function isSuperseded(error: unknown): boolean {
  return toAppError(error).code === 'superseded';
}
