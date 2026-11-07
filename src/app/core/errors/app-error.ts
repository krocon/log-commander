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
  | 'backend_unavailable'
  | 'unknown';

export interface AppError {
  code: ErrorCode;
  message: string;
  path?: string;
  /** The node of a filter expression (prompt 010) or the extraction rule (prompt 011) the error is about. */
  nodeId?: string;
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
    case 'backend_unavailable':
      return 'Desktop-Backend nicht verfügbar (läuft die App im Browser?)';
    default:
      return `${error.message}${where}`;
  }
}
