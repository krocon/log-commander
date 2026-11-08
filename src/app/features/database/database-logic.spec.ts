import { describe, expect, it } from 'vitest';
import { DbConfig, SourceStatus } from '../../core/log/log.models';
import {
  checkDbForm,
  databaseCounters,
  dbKey,
  dbLabel,
  dbWhere,
  defaultDbForm,
  describeDbError,
  formOfDbConfig,
  guessColumns,
  parseDbConfig,
  previewTable,
  quoteIdent,
  tableOf,
  tableQuery,
  tlsWarning,
  workspaceQuery,
} from './database-logic';

const pg: DbConfig = {
  kind: 'database',
  engine: 'postgres',
  host: 'db.example',
  port: 0,
  database: 'app',
  user: 'reader',
  auth: 'password',
  tls: 'verify',
  caFile: '/etc/ssl/ca.pem',
  path: '',
  query: 'SELECT * FROM "app"."logs"',
  keyColumn: 'id',
  timeColumn: 'ts',
  levelColumn: 'level',
  intervalMs: 2000,
  startLast: 1000,
};

describe('checkDbForm', () => {
  it('turns a form into a config and back', () => {
    const check = checkDbForm(formOfDbConfig(pg));
    expect(check.errors).toEqual({});
    expect(check.config).toEqual(pg);
    expect(check.connection?.host).toBe('db.example');
    expect(check.connection?.query).toBe('');
  });

  it('has defaults that need a user and a query', () => {
    const check = checkDbForm(defaultDbForm());
    expect(check.config).toBeNull();
    expect(check.errors.user).toBeTruthy();
    expect(check.errors.query).toBeTruthy();
    expect(check.connection).toBeNull();
  });

  it('checks fields', () => {
    const bad = (change: Partial<ReturnType<typeof formOfDbConfig>>) =>
      checkDbForm({ ...formOfDbConfig(pg), ...change }).errors;
    expect(bad({ host: 'db host' }).host).toBeTruthy();
    expect(bad({ host: '-oProxy' }).host).toBeTruthy();
    expect(bad({ port: '70000' }).port).toBeTruthy();
    expect(bad({ query: 'DELETE FROM logs' }).query).toBeTruthy();
    expect(bad({ query: '  ' }).query).toBeTruthy();
    expect(bad({ keyColumn: '' }).keyColumn).toBeTruthy();
    expect(bad({ interval: '0.1' }).interval).toBeTruthy();
    expect(bad({ interval: '0,5' }).interval).toBeUndefined();
    expect(bad({ startLast: '0' }).startLast).toBeTruthy();
    expect(bad({ startAll: true, startLast: '0' }).startLast).toBeUndefined();
    expect(bad({ caFile: 'ca.pem' }).caFile).toBeTruthy();
  });

  it('keeps only what an engine needs', () => {
    const lite = checkDbForm({
      ...formOfDbConfig(pg),
      engine: 'sqlite',
      path: '/var/log/app.db',
      auth: 'password',
    }).config!;
    expect(lite).toMatchObject({
      host: '',
      user: '',
      auth: 'none',
      path: '/var/log/app.db',
      caFile: '',
    });
    expect(
      checkDbForm({ ...formOfDbConfig(pg), engine: 'sqlite', path: 'app.db' }).errors.path,
    ).toBeTruthy();
    const ms = checkDbForm({ ...formOfDbConfig(pg), engine: 'mssql', auth: 'none' }).config!;
    expect(ms.auth).toBe('password');
    const insecure = checkDbForm({ ...formOfDbConfig(pg), tls: 'noVerify' }).config!;
    expect(insecure.caFile).toBe('');
  });
});

describe('parseDbConfig', () => {
  it('accepts a stored config and refuses odd ones', () => {
    expect(parseDbConfig(pg)).toEqual(pg);
    expect(parseDbConfig({ ...pg, password: 'x' })).toEqual(pg);
    expect(parseDbConfig({ ...pg, engine: 'oracle' })).toBeNull();
    expect(parseDbConfig({ ...pg, tls: 'maybe' })).toBeNull();
    expect(parseDbConfig({ ...pg, host: 'a\nb' })).toBeNull();
    expect(parseDbConfig({ ...pg, query: 'DROP TABLE logs' })).toBeNull();
    expect(parseDbConfig({ ...pg, port: -1 })).toBeNull();
    expect(parseDbConfig({ ...pg, kind: 'sftp' })).toBeNull();
    expect(parseDbConfig('x')).toBeNull();
  });

  it('drops the CA file of a workspace', () => {
    expect(parseDbConfig(pg, true)?.caFile).toBe('');
  });

  it('fills defaults', () => {
    const minimal = {
      kind: 'database',
      engine: 'mysql',
      host: 'h',
      user: 'u',
      query: 'SELECT 1 AS id',
      keyColumn: 'id',
    };
    expect(parseDbConfig(minimal)).toMatchObject({
      port: 0,
      tls: 'verify',
      auth: 'password',
      intervalMs: 2000,
      startLast: 1000,
    });
  });
});

describe('labels and keys', () => {
  it('names a tab after the table', () => {
    expect(dbLabel(pg)).toBe('db:app.logs');
    expect(dbLabel({ ...pg, query: "select * from logs where msg = 'from x'" })).toBe('db:logs');
    expect(dbLabel({ ...pg, query: 'SELECT (SELECT 1 FROM a) FROM [dbo].[Log]' })).toBe(
      'db:dbo.Log',
    );
    expect(dbLabel({ ...pg, query: 'SELECT 1 AS id' })).toBe('db:app');
    expect(tableOf('SELECT * FROM `app`.`events`')).toBe('app.events');
    expect(dbWhere(pg)).toBe('db.example:5432/app');
    expect(dbWhere({ ...pg, engine: 'sqlite', path: '/x/y/app.db' })).toBe('app.db');
  });

  it('tells sources apart by server and query', () => {
    expect(dbKey(pg)).toBe(dbKey({ ...pg, host: 'DB.example', port: 5432 }));
    expect(dbKey(pg)).not.toBe(dbKey({ ...pg, query: 'SELECT * FROM other' }));
  });

  it('quotes names for the table template', () => {
    expect(quoteIdent('a"b', 'postgres')).toBe('"a""b"');
    expect(quoteIdent('a`b', 'mysql')).toBe('`a``b`');
    expect(quoteIdent('a]b', 'mssql')).toBe('[a]]b]');
    expect(tableQuery({ schema: 'dbo', name: 'Log' }, 'mssql')).toBe('SELECT * FROM [dbo].[Log]');
    expect(tableQuery({ schema: null, name: 'logs' }, 'sqlite')).toBe('SELECT * FROM "logs"');
  });

  it('guesses the usual columns', () => {
    expect(guessColumns(['ID', 'Timestamp', 'Level', 'Message'])).toEqual({
      key: 'ID',
      time: 'Timestamp',
      level: 'Level',
    });
    expect(guessColumns(['created_at', 'msg'])).toEqual({
      key: 'created_at',
      time: 'created_at',
      level: undefined,
    });
  });
});

describe('texts', () => {
  it('warns about TLS without checks', () => {
    expect(tlsWarning(pg)).toBeNull();
    expect(tlsWarning({ engine: 'mysql', tls: 'noVerify' })).toContain('Zertifikatsprüfung');
    expect(tlsWarning({ engine: 'mssql', tls: 'off' })).toContain('unverschlüsselt');
    expect(tlsWarning({ engine: 'sqlite', tls: 'off' })).toBeNull();
  });

  it('counts rows and shows the last query', () => {
    const status = {
      state: { kind: 'connected' },
      received: 1234,
      dropped: 0,
      truncated: 2,
      rejected: 0,
      connections: 0,
      spooled: 1234,
      spoolError: null,
      bytes: 0,
      latencyMs: 12,
      pendingBytes: 0,
      gaps: 1,
      polledAtMs: Date.UTC(2026, 10, 8, 9, 15, 30),
    } as SourceStatus;
    const text = databaseCounters(status);
    expect(text).toMatch(
      /^1\.234 Zeilen · letzte Abfrage \d\d:\d\d:\d\d \(12 ms\) · 2 gekürzt · 1 Lücke$/,
    );
    expect(databaseCounters({ ...status, polledAtMs: null, truncated: 0, gaps: 0 })).toBe(
      '1.234 Zeilen',
    );
  });

  it('describes errors', () => {
    expect(
      describeDbError({ code: 'secret_required', message: 'x', remote: { wrong: true } }),
    ).toBe('Passwort nicht angenommen');
    expect(describeDbError({ code: 'invalid_query', message: 'ORDER BY weglassen' })).toBe(
      'ORDER BY weglassen',
    );
  });
});

describe('workspaceQuery', () => {
  it('shows the whole query on one line, long ones cut', () => {
    expect(workspaceQuery('SELECT *\n  FROM logs')).toBe('SELECT * FROM logs');
    expect(workspaceQuery(`SELECT '${'x'.repeat(600)}'`)).toHaveLength(502);
  });
});

describe('previewTable', () => {
  it('builds rows from the lines, values as text', () => {
    const table = previewTable({
      columns: [],
      keyType: 'INT8',
      lines: [
        '{"timestamp":"2026-11-08T10:00:00","level":"INFO","id":1,"msg":"<b>x</b>"}',
        '{"timestamp":null,"level":"ERROR","id":2,"msg":"y","extra":true}',
        'not json',
      ],
    });
    expect(table.columns).toEqual(['timestamp', 'level', 'id', 'msg', 'extra']);
    expect(table.rows[0]).toEqual(['2026-11-08T10:00:00', 'INFO', '1', '<b>x</b>', '']);
    expect(table.rows[1]).toEqual(['', 'ERROR', '2', 'y', 'true']);
    expect(table.rows[2]).toEqual(['', '', '', '', '']);
  });
});
