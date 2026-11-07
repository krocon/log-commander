import { Status } from '../../core/log/log.models';

export interface StatusPill {
  label: string;
  cls: string;
}

/** What the status bar says. Trouble goes before a freeze, a freeze before everything else. */
export function statusPill(status: Status, frozen: boolean, follow: boolean): StatusPill {
  switch (status.kind) {
    case 'file_missing':
      return { label: 'Datei fehlt', cls: 'bad' };
    case 'error':
      return { label: `Fehler: ${status.message}`, cls: 'bad' };
  }
  if (frozen) return { label: 'Eingefroren', cls: 'frozen' };
  switch (status.kind) {
    case 'loading':
      return { label: `Lade … ${Math.round(status.progress * 100)} %`, cls: 'loading' };
    case 'truncated':
      return { label: 'Datei geleert', cls: 'warn' };
    case 'rotated':
      return { label: 'Datei rotiert', cls: 'warn' };
    case 'live':
      return follow ? { label: 'Live', cls: 'live' } : { label: 'Pausiert', cls: 'paused' };
  }
}
