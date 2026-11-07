import { describe, expect, it } from 'vitest';
import {
  isNetworkPath,
  dirName,
  isAbsolutePath,
  normalizePath,
  relativePath,
  resolveRelative,
} from './workspace-paths';

describe('workspace paths', () => {
  it('knows absolute POSIX, drive and UNC paths', () => {
    expect(isAbsolutePath('/var/log/a.log')).toBe(true);
    expect(isAbsolutePath('C:\\logs\\a.log')).toBe(true);
    expect(isAbsolutePath('c:/logs/a.log')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share\\a.log')).toBe(true);
    expect(isAbsolutePath('logs/a.log')).toBe(false);
    expect(isAbsolutePath('C:a.log')).toBe(false);
  });

  it('knows network paths, which a workspace never touches', () => {
    expect(isNetworkPath('\\\\attacker\\s\\a.log')).toBe(true);
    expect(isNetworkPath('\\\\?\\UNC\\host\\s\\a.log')).toBe(true);
    expect(isNetworkPath('//host/share/a.log')).toBe(true);
    expect(isNetworkPath('/net/host/a.log')).toBe(true);
    expect(isNetworkPath('/Network/Servers/a.log')).toBe(true);
    expect(isNetworkPath('/var/log/a.log')).toBe(false);
    expect(isNetworkPath('C:\\logs\\a.log')).toBe(false);
    expect(isNetworkPath('/Volumes/Data/a.log')).toBe(false);
  });

  it('normalises dots and separators', () => {
    expect(normalizePath('/a/./b//c/../d.log')).toBe('/a/b/d.log');
    expect(normalizePath('/../../etc')).toBe('/etc');
    expect(normalizePath('c:/x\\y\\..\\z.log')).toBe('C:\\x\\z.log');
    expect(normalizePath('rel/a')).toBeNull();
    expect(dirName('/home/me/ws.lcw')).toBe('/home/me');
    expect(dirName('C:\\Users\\me\\ws.lcw')).toBe('C:\\Users\\me');
  });

  it('makes paths relative to the workspace folder', () => {
    expect(relativePath('/home/me/work', '/home/me/work/logs/app.log')).toBe('logs/app.log');
    expect(relativePath('/home/me/work', '/home/me/other/app.log')).toBe('../other/app.log');
    expect(relativePath('/home/me', '/home/me')).toBe('.');
    expect(relativePath('C:\\Work', 'c:\\work\\Logs\\a.log')).toBe('Logs/a.log');
    expect(relativePath('C:\\Work', 'D:\\a.log')).toBeNull();
    expect(relativePath('/home', 'C:\\a.log')).toBeNull();
    expect(relativePath('\\\\srv\\share\\ws', '\\\\srv\\share\\logs\\a.log')).toBe('../logs/a.log');
  });

  it('resolves relative paths against another folder, special characters included', () => {
    expect(resolveRelative('/tmp/moved', 'logs/app.log')).toBe('/tmp/moved/logs/app.log');
    expect(resolveRelative('/tmp/moved', '../x/Grüße [1] #2.log')).toBe('/tmp/x/Grüße [1] #2.log');
    expect(resolveRelative('D:\\ws', 'logs/a.log')).toBe('D:\\ws\\logs\\a.log');
    expect(resolveRelative('/tmp', '/etc/passwd')).toBeNull();
    expect(resolveRelative('/tmp', 'C:\\x')).toBeNull();
    expect(resolveRelative('/tmp', '\\x')).toBeNull();
    expect(resolveRelative('/tmp', 'a\0b')).toBeNull();
    // Round trip.
    const ws = '/Users/me/cases/4711';
    const log = '/Users/me/logs/app.log';
    expect(resolveRelative(ws, relativePath(ws, log) as string)).toBe(log);
  });
});
