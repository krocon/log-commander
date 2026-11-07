import { describe, expect, it } from 'vitest';
import { describeError } from '../../core/errors/app-error';
import { SourceStatus } from '../../core/log/log.models';
import {
  MAX_SAVED_SOURCES,
  addSavedSource,
  checkSyslogForm,
  defaultSyslogConfig,
  formOf,
  isIpAddress,
  isLoopbackAddress,
  isNetEntry,
  isRemoteSource,
  mergeSavedSources,
  parseSourceConfig,
  portNeedsPrivileges,
  sourceCounters,
  sourceKey,
  sourceLabel,
  sourcePill,
} from './source-logic';

describe('source logic', () => {
  it('listens on this computer only by default', () => {
    const config = defaultSyslogConfig();
    expect(config).toEqual({
      kind: 'syslog',
      protocol: 'udp',
      address: '127.0.0.1',
      port: 5514,
      allow: [],
      allowRemote: false,
    });
    expect(isRemoteSource(config)).toBe(false);
    expect(sourceLabel(config)).toBe('Syslog :5514');
  });

  it('knows IP addresses, loopback and networks', () => {
    for (const ok of ['127.0.0.1', '0.0.0.0', '::', '::1', '[::1]', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isIpAddress(ok), ok).toBe(true);
    for (const bad of [
      'localhost',
      '256.0.0.1',
      '1.2.3',
      ':::',
      '1::2::3',
      'a.b.c.d',
      '',
      ':1::',
      '1::2:',
      '1:2:3:4:5:6:7',
    ])
      expect(isIpAddress(bad), bad).toBe(false);
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
    for (const ok of ['10.0.0.0/8', '192.168.1.5', 'fd00::/8', '0.0.0.0/0'])
      expect(isNetEntry(ok), ok).toBe(true);
    for (const bad of ['10.0.0.0/33', '10.0.0.0/', 'x/8', '::/129', '1.2.3.4/8/9', '[::1]'])
      expect(isNetEntry(bad), bad).toBe(false);
    expect(portNeedsPrivileges(514)).toBe(true);
    expect(portNeedsPrivileges(5514)).toBe(false);
  });

  it('checks the dialog and asks for the explicit choice before listening beyond this computer', () => {
    const form = formOf(defaultSyslogConfig());
    expect(checkSyslogForm(form).config).toEqual(defaultSyslogConfig());
    const remote = checkSyslogForm({ ...form, address: '0.0.0.0' });
    expect(remote.config).toBeNull();
    expect(remote.errors.remote).toBeTruthy();
    const allowed = checkSyslogForm({ ...form, address: '0.0.0.0', allowRemote: true });
    expect(allowed.config?.allowRemote).toBe(true);
    // The choice does not stick to a local address.
    expect(checkSyslogForm({ ...form, allowRemote: true }).config?.allowRemote).toBe(false);
    expect(checkSyslogForm({ ...form, port: '0' }).errors.port).toBeTruthy();
    expect(checkSyslogForm({ ...form, port: '70000' }).errors.port).toBeTruthy();
    expect(checkSyslogForm({ ...form, port: '5x' }).errors.port).toBeTruthy();
    expect(checkSyslogForm({ ...form, address: 'localhost' }).errors.address).toBeTruthy();
    const filter = checkSyslogForm({
      ...form,
      allowText: '10.0.0.0/8\n 192.168.1.5 ,fd00::/8\n\n',
    });
    expect(filter.config?.allow).toEqual(['10.0.0.0/8', '192.168.1.5', 'fd00::/8']);
    expect(checkSyslogForm({ ...form, allowText: 'host.example' }).errors.allow).toContain(
      'host.example',
    );
  });

  it('takes stored or shared configurations only when every field fits', () => {
    const good = { ...defaultSyslogConfig(), protocol: 'both' };
    expect(parseSourceConfig(good)).toEqual(good);
    expect(parseSourceConfig({ ...good, kind: 'sftp' })).toBeNull();
    expect(parseSourceConfig({ ...good, protocol: 'tls' })).toBeNull();
    expect(parseSourceConfig({ ...good, port: 0 })).toBeNull();
    expect(parseSourceConfig({ ...good, port: 1.5 })).toBeNull();
    expect(parseSourceConfig({ ...good, address: 'evil.example' })).toBeNull();
    expect(parseSourceConfig({ ...good, allow: ['x'] })).toBeNull();
    expect(parseSourceConfig({ ...good, allow: 'x' })).toBeNull();
    // A remote address without the explicit choice is refused, with it kept (a workspace asks first).
    expect(parseSourceConfig({ ...good, address: '0.0.0.0' })).toBeNull();
    const remote = parseSourceConfig({ ...good, address: '0.0.0.0', allowRemote: true });
    expect(remote?.kind === 'syslog' && remote.allowRemote).toBe(true);
    expect(parseSourceConfig(null)).toBeNull();
    expect(parseSourceConfig('syslog')).toBeNull();
  });

  it('remembers sources without duplicates, newest first', () => {
    const a = defaultSyslogConfig();
    const b = { ...a, port: 6000 };
    let saved = addSavedSource([], { config: a, keep: false });
    saved = addSavedSource(saved, { config: b, keep: true });
    saved = addSavedSource(saved, { config: { ...a }, keep: true });
    expect(saved.map((s) => s.config.port)).toEqual([5514, 6000]);
    expect(saved[0].keep).toBe(true);
    expect(sourceKey(a)).toBe(sourceKey({ ...a, allow: ['10.0.0.1'] }));
    const many = Array.from({ length: 30 }, (_, i) => ({ config: { ...a, port: 7000 + i } }));
    expect(mergeSavedSources(many)).toHaveLength(MAX_SAVED_SOURCES);
    expect(mergeSavedSources([{ config: { kind: 'x' } }, 'junk', null, { config: a }])).toEqual([
      { config: a, keep: false },
    ]);
    expect(mergeSavedSources('junk')).toEqual([]);
  });

  it('labels like the backend', () => {
    const a = defaultSyslogConfig();
    expect(sourceLabel({ ...a, protocol: 'tcp' })).toBe('Syslog TCP :5514');
    expect(sourceLabel({ ...a, protocol: 'both', address: '0.0.0.0', port: 514 })).toBe(
      'Syslog UDP+TCP 0.0.0.0:514',
    );
    expect(sourceLabel({ ...a, address: '::' })).toBe('Syslog [::]:5514');
  });

  it('tells state and counters in words, not only by colour', () => {
    expect(sourcePill({ kind: 'listening' })).toEqual({ label: 'Lauscht', cls: 'live' });
    expect(sourcePill({ kind: 'error', message: 'x' }).cls).toBe('bad');
    expect(sourcePill({ kind: 'stopped' }).label).toBe('Gestoppt');
    const status: SourceStatus = {
      state: { kind: 'listening' },
      received: 12345,
      dropped: 0,
      truncated: 0,
      rejected: 0,
      connections: 0,
      spooled: 12345,
      spoolError: null,
      bytes: 0,
      latencyMs: null,
      pendingBytes: 0,
    };
    expect(sourceCounters(status)).toBe('12.345 empfangen');
    expect(
      sourceCounters({ ...status, dropped: 3, truncated: 1, rejected: 2, connections: 2 }),
    ).toBe('12.345 empfangen · 3 verworfen · 1 gekürzt · 2 abgewiesen · 2 Verbindungen');
  });

  it('describes port and source errors in German', () => {
    expect(describeError({ code: 'port_in_use', message: 'port 5514 is in use' })).toContain(
      'Port belegt: port 5514',
    );
    expect(describeError({ code: 'invalid_source', message: 'x' })).toContain('Quelle');
  });
});
