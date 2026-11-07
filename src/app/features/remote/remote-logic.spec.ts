import { describe, expect, it } from 'vitest';
import { SourceStatus } from '../../core/log/log.models';
import { parseSourceConfig, sourceKey, sourceLabel, sourcePill } from '../sources/source-logic';
import { parseWorkspace } from '../workspace/workspace-model';
import {
  applyHost,
  browseStart,
  checkRemoteForm,
  defaultSftpConfig,
  isHostName,
  joinRemote,
  nextStep,
  parentPath,
  parseSftpConfig,
  remoteCounters,
  remoteFormOf,
  sftpAddress,
  sftpLabel,
  targetOf,
} from './remote-logic';

const form = () => ({
  ...remoteFormOf(defaultSftpConfig()),
  host: 'logs.example.com',
  user: 'ops',
  path: '/var/log/app.log',
});

describe('remote form', () => {
  it('checks every field and builds a configuration without secrets', () => {
    const check = checkRemoteForm(form());
    expect(check.errors).toEqual({});
    expect(check.config).toEqual({
      kind: 'sftp',
      host: 'logs.example.com',
      port: 22,
      user: 'ops',
      auth: 'agent',
      keyFile: null,
      path: '/var/log/app.log',
      startMb: 50,
      pollMs: 500,
    });
    expect(Object.keys(check.config!)).not.toContain('password');
    expect(checkRemoteForm({ ...form(), port: '' }).config?.port).toBe(0);
    expect(checkRemoteForm({ ...form(), whole: true }).config?.startMb).toBeNull();
    const bad = checkRemoteForm({
      ...form(),
      host: '-oProxyCommand=x',
      port: '70000',
      user: 'a@b',
      path: 'var/log',
      startMb: '0',
      pollMs: '10',
    });
    expect(bad.config).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual([
      'host',
      'path',
      'pollMs',
      'port',
      'startMb',
      'user',
    ]);
    expect(
      checkRemoteForm({ ...form(), auth: 'key', keyFile: 'id_rsa' }).errors.keyFile,
    ).toBeTruthy();
    expect(checkRemoteForm({ ...form(), auth: 'key', keyFile: '/k/id' }).config?.keyFile).toBe(
      '/k/id',
    );
    // A key file only counts for the key login.
    expect(checkRemoteForm({ ...form(), keyFile: '/k/id' }).config?.keyFile).toBeNull();
    expect(isHostName('a b')).toBe(false);
    expect(isHostName('user@host')).toBe(false);
    expect(isHostName('[::1]')).toBe(true);
  });

  it('takes user and port from ~/.ssh/config where empty', () => {
    const host = {
      alias: 'web',
      hostName: '10.0.0.5',
      user: 'deploy',
      port: 2222,
      identityFiles: [],
      proxy: false,
    };
    expect(applyHost({ ...form(), user: '', port: '' }, host)).toMatchObject({
      user: 'deploy',
      port: '2222',
    });
    expect(applyHost(form(), host)).toMatchObject({ user: 'ops', port: '22' });
    expect(targetOf(form())).toEqual({
      host: 'logs.example.com',
      port: 22,
      user: 'ops',
      auth: 'agent',
      keyFile: null,
    });
    expect(targetOf({ ...form(), host: '' })).toBeNull();
  });
});

describe('stored and shared configurations', () => {
  const stored = {
    kind: 'sftp',
    host: 'h',
    port: 0,
    user: '',
    auth: 'key',
    keyFile: '/Users/me/.ssh/id',
    path: '/x.log',
    startMb: null,
    pollMs: 1000,
  };

  it('are checked field by field', () => {
    expect(parseSftpConfig(stored)).toEqual(stored);
    // A workspace keeps no key file.
    expect(parseSftpConfig(stored, false)?.keyFile).toBeNull();
    expect(parseSourceConfig(stored, true)).toMatchObject({ kind: 'sftp', keyFile: null });
    for (const change of [
      { host: 'a b' },
      { port: -1 },
      { auth: 'shell' },
      { path: 'relative' },
      { path: '/a\nb' },
      { pollMs: 1 },
      { startMb: 0 },
      { keyFile: 7 },
    ]) {
      expect(parseSftpConfig({ ...stored, ...change }), JSON.stringify(change)).toBeNull();
    }
    // Defaults for what an older file leaves out; a password in it is not taken over.
    const parsed = parseSftpConfig({
      kind: 'sftp',
      host: 'h',
      port: 22,
      user: 'u',
      auth: 'password',
      path: '/a',
      password: 'x',
    });
    expect(parsed).toMatchObject({ startMb: 50, pollMs: 500 });
    expect(JSON.stringify(parsed)).not.toContain('password":');
  });

  it('a workspace with a remote file never carries a secret or a key file', () => {
    const doc = {
      format: 'log-commander-workspace',
      version: 2,
      files: [
        {
          kind: 'source',
          sources: [],
          source: { ...stored, secret: 'hunter2' },
          profileId: null,
          tabs: [],
        },
      ],
    };
    const parsed = parseWorkspace(JSON.stringify(doc));
    const ws = 'doc' in parsed ? parsed.doc : null;
    const source = ws?.files[0]?.source;
    expect(source).toMatchObject({ kind: 'sftp', host: 'h', keyFile: null });
    expect(JSON.stringify(source)).not.toContain('hunter2');
  });

  it('labels and keys', () => {
    const c = { ...defaultSftpConfig(), host: 'h', user: 'u', path: '/var/log/a.log' };
    expect(sftpLabel(c)).toBe('h:/var/log/a.log');
    expect(sourceLabel(c)).toBe('h:/var/log/a.log');
    expect(sftpAddress(c)).toBe('u@h');
    expect(sftpAddress({ ...c, port: 2222, user: '' })).toBe('h:2222');
    expect(sourceKey(c)).not.toBe(sourceKey({ ...c, path: '/var/log/b.log' }));
    expect(sourceKey(c)).toBe(sourceKey({ ...c, host: 'H' }));
  });
});

describe('after a failed connect', () => {
  it('asks for trust, a secret, or ends at a changed key', () => {
    expect(
      nextStep({
        code: 'host_key_unknown',
        message: '',
        remote: { keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc', wrong: false },
      }),
    ).toEqual({ kind: 'trust', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' });
    expect(
      nextStep({
        code: 'secret_required',
        message: '',
        remote: { secret: 'passphrase', wrong: true },
      }),
    ).toEqual({ kind: 'secret', secret: 'passphrase', wrong: true });
    const changed = nextStep({
      code: 'host_key_changed',
      message: '',
      remote: { fingerprint: 'SHA256:new', knownHosts: '/k', knownHostsLine: 3, wrong: false },
    });
    expect(changed.kind).toBe('changed');
    expect(changed.kind === 'changed' && changed.message).toContain('Zeile 3');
    const revoked = nextStep({
      code: 'host_key_changed',
      message: '',
      remote: {
        fingerprint: 'SHA256:x',
        knownHosts: '/k',
        knownHostsLine: 2,
        reason: 'revoked',
        wrong: false,
      },
    });
    expect(revoked.kind === 'changed' && revoked.message).toContain('@revoked');
    expect(nextStep({ code: 'connection_failed', message: 'timeout' })).toEqual({
      kind: 'error',
      message: 'Verbindung fehlgeschlagen: timeout',
    });
  });
});

describe('paths and status', () => {
  it('walks folders', () => {
    expect(parentPath('/var/log')).toBe('/var');
    expect(parentPath('/var')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(joinRemote('/', 'a')).toBe('/a');
    expect(joinRemote('/var', 'a')).toBe('/var/a');
    expect(browseStart('/var/log/app.log')).toBe('/var/log');
    expect(browseStart('')).toBe('');
  });

  it('counts and states', () => {
    const status: SourceStatus = {
      state: { kind: 'reconnecting', message: 'x', retryInS: 4 },
      received: 1234,
      dropped: 0,
      truncated: 0,
      rejected: 0,
      connections: 0,
      spooled: 1234,
      spoolError: null,
      bytes: 2048,
      latencyMs: 5,
      pendingBytes: 1024 * 1024,
    };
    expect(remoteCounters(status)).toMatch(
      /^1\.234 Zeilen · 2(,0)? KB · 5 ms · lädt noch 1(,0)? MB$/,
    );
    expect(sourcePill(status.state)).toEqual({
      label: 'Getrennt, neuer Versuch in 4 s',
      cls: 'warn',
    });
  });
});
