import { describe, expect, it } from 'vitest';
import { SourceStatus, WinEventConfig } from '../../core/log/log.models';
import { resolveColumns } from '../log-table/columns-logic';
import { rowMenuItems } from '../log-table/row-menu';
import {
  mergeSavedSources,
  parseSourceConfig,
  sourceCounters,
  sourceKey,
  sourceLabel,
  sourcePill,
} from '../sources/source-logic';
import { parseWorkspace } from '../workspace/workspace-model';
import {
  MAX_CHANNELS,
  checkWinEventForm,
  defaultColumnLayout,
  defaultWinEventForm,
  describeWinEventError,
  filterChannels,
  formOfConfig,
  isComputerName,
  isWinUser,
  parseWinEventConfig,
  wineventCounters,
  wineventLabel,
  wineventWhere,
} from './winevent-logic';

const local: WinEventConfig = {
  kind: 'winevent',
  channel: 'Application',
  computer: '',
  auth: 'current',
  user: '',
  hours: 24,
  xml: true,
};

const remote: WinEventConfig = {
  ...local,
  computer: 'srv01.corp.example',
  auth: 'password',
  user: 'CORP\\ops',
};

describe('Windows events dialog', () => {
  it('builds one configuration per channel, without a password', () => {
    const form = { ...defaultWinEventForm(), channels: ['Application', 'System'] };
    const check = checkWinEventForm(form);
    expect(check.errors).toEqual({});
    expect(check.target).toEqual({ computer: '', auth: 'current', user: '' });
    expect(check.configs.map((c) => c.channel)).toEqual(['Application', 'System']);
    expect(check.configs[0]).toEqual(local);
    expect(JSON.stringify(check.configs)).not.toMatch(/secret|password"/);
  });

  it('this computer is always read with the logged-on identity', () => {
    const check = checkWinEventForm({
      ...defaultWinEventForm(),
      auth: 'password',
      user: 'x',
      channels: ['System'],
    });
    expect(check.target).toEqual({ computer: '', auth: 'current', user: '' });
  });

  it('checks computer, user and the number of channels', () => {
    const base = { ...defaultWinEventForm(), channels: ['System'] };
    expect(checkWinEventForm({ ...base, computer: 'srv 01' }).errors.computer).toBeTruthy();
    expect(checkWinEventForm({ ...base, computer: '-oX' }).target).toBeNull();
    const pw = { ...base, computer: '\\\\srv01', auth: 'password' as const };
    expect(checkWinEventForm(pw).errors.user).toBeTruthy();
    expect(checkWinEventForm({ ...pw, user: 'CORP\\ops' }).target).toEqual({
      computer: 'srv01',
      auth: 'password',
      user: 'CORP\\ops',
    });
    expect(checkWinEventForm({ ...base, channels: [] }).errors.channels).toBeTruthy();
    const many = Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => `C${i}`);
    expect(checkWinEventForm({ ...base, channels: many }).configs).toEqual([]);
    expect(isComputerName('')).toBe(true);
    expect(isComputerName('fe80::1')).toBe(true);
    expect(isComputerName('a/b')).toBe(false);
    expect(isWinUser('ops@corp.example')).toBe(true);
    expect(isWinUser('a\\b\\c')).toBe(false);
    expect(isWinUser('a"b')).toBe(false);
  });

  it('filters channels and keeps the chosen ones', () => {
    const all = ['Application', 'System', 'Microsoft-Windows-PowerShell/Operational', 'Security'];
    expect(filterChannels(all, 'power oper')).toEqual(['Microsoft-Windows-PowerShell/Operational']);
    expect(filterChannels(all, 'power', ['System'])).toEqual([
      'System',
      'Microsoft-Windows-PowerShell/Operational',
    ]);
    expect(filterChannels(all, '')).toEqual(all);
  });

  it('a stored configuration opens the dialog prefilled', () => {
    expect(formOfConfig(remote)).toMatchObject({
      computer: 'srv01.corp.example',
      auth: 'password',
      user: 'CORP\\ops',
      channels: ['Application'],
      hours: 24,
    });
  });
});

describe('Windows events from settings and workspaces', () => {
  it('parses field by field and never keeps a secret', () => {
    expect(parseWinEventConfig({ kind: 'winevent', channel: 'System' })).toEqual({
      ...local,
      channel: 'System',
    });
    expect(parseWinEventConfig({ ...remote, password: 'hunter2', secret: 'hunter2' })).toEqual(
      remote,
    );
    expect(parseSourceConfig({ ...remote, password: 'x' })).toEqual(remote);
    expect(parseWinEventConfig({ ...local, hours: null })?.hours).toBeNull();
    for (const bad of [
      { ...local, channel: '' },
      { ...local, channel: ' System' },
      { ...local, channel: 'a\nb' },
      { ...local, computer: 'a b' },
      { ...local, auth: 'kerberos' },
      { ...local, auth: 'password', user: 'x' },
      { ...remote, user: '' },
      { ...local, hours: 0 },
      { ...local, hours: 1.5 },
      { ...local, xml: 'yes' },
      { ...local, kind: 'syslog' },
    ]) {
      expect(parseWinEventConfig(bad)).toBeNull();
    }
    // The current identity keeps no user name.
    expect(parseWinEventConfig({ ...local, computer: 'srv', user: 'x' })?.user).toBe('');
  });

  it('remembered sources: one per computer and channel', () => {
    const saved = mergeSavedSources([
      { config: local, keep: false },
      { config: { ...local, hours: 1 }, keep: true },
      { config: remote, keep: false },
    ]);
    expect(saved.length).toBe(2);
    expect(sourceKey(local)).not.toBe(sourceKey(remote));
    expect(sourceKey(remote)).toBe(sourceKey({ ...remote, computer: 'SRV01.corp.example' }));
  });

  it('a workspace never carries a password', () => {
    const doc = {
      format: 'log-commander-workspace',
      version: 2,
      files: [
        {
          kind: 'source',
          sources: [],
          source: { ...remote, password: 'hunter2' },
          profileId: null,
          tabs: [],
        },
      ],
    };
    const parsed = parseWorkspace(JSON.stringify(doc));
    const ws = 'doc' in parsed ? parsed.doc : null;
    expect(ws?.files[0]?.source).toEqual(remote);
    expect(JSON.stringify(ws)).not.toContain('hunter2');
  });
});

describe('Windows events in tab, status bar and table', () => {
  const status: SourceStatus = {
    state: { kind: 'loading' },
    received: 12345,
    dropped: 0,
    truncated: 2,
    rejected: 0,
    connections: 0,
    spooled: 12345,
    spoolError: null,
    bytes: 0,
    latencyMs: null,
    pendingBytes: 0,
    gaps: 1,
  };

  it('labels, places and counters', () => {
    expect(wineventLabel(local)).toBe('Ereignisse: Application');
    expect(sourceLabel(remote)).toBe('Ereignisse srv01.corp.example: Application');
    expect(wineventWhere(local)).toBe('dieser Rechner');
    expect(wineventWhere(remote)).toBe('srv01.corp.example als CORP\\ops');
    expect(sourcePill({ kind: 'loading' })).toEqual({ label: 'Lädt Bestand …', cls: 'loading' });
    expect(wineventCounters(status)).toBe('12.345 Ereignisse · 2 gekürzt · 1 Lücke');
    expect(wineventCounters({ ...status, rejected: 3 })).toBe(
      '12.345 Ereignisse · 2 gekürzt · 3 nicht lesbar · 1 Lücke',
    );
    expect(sourceCounters({ ...status, gaps: 0, truncated: 0 }, 'winevent')).toBe(
      '12.345 Ereignisse',
    );
  });

  it('errors keep the hint of the backend', () => {
    const hint = 'Kein Zugriff auf „Security“. „Security“ braucht Administratorrechte …';
    expect(describeWinEventError({ code: 'permission_denied', message: hint })).toBe(hint);
    expect(
      describeWinEventError({
        code: 'secret_required',
        message: '',
        remote: { secret: 'password', wrong: true },
      }),
    ).toBe('Passwort nicht angenommen');
  });

  it('shows time, level, provider, event ID and message first', () => {
    const columns = [
      'timestamp',
      'level',
      'message',
      'provider',
      'eventId',
      'channel',
      'computer',
      'task',
      'user',
      'recordId',
      'xml',
    ].map((id) => ({ id, label: id, kind: 'text' as const }));
    expect(defaultColumnLayout('jsonl')).toBeUndefined();
    const view = resolveColumns(columns, defaultColumnLayout('winevent'), 7);
    expect(view.filter((c) => !c.hidden).map((c) => c.id)).toEqual([
      'timestamp',
      'level',
      'provider',
      'eventId',
      'message',
    ]);
  });

  it('the context menu offers the same event ID', () => {
    const items = rowMenuItems({ selectedText: '', cell: null, hasLine: true, eventId: '4625' });
    expect(items[0]).toEqual({ id: 'same-event-id', label: 'Gleiche Event-ID (4625)' });
    expect(
      rowMenuItems({ selectedText: '', cell: null, hasLine: true }).map((i) => i.id),
    ).not.toContain('same-event-id');
  });
});
