import { describe, expect, it } from 'vitest';
import { cleanPathInput, expandHome, usesHome } from './open-path-logic';

describe('cleanPathInput', () => {
  it('trims whitespace and one pair of quotes', () => {
    expect(cleanPathInput('  /tmp/app.log\n')).toBe('/tmp/app.log');
    expect(cleanPathInput('"C:\\logs\\my app.log"')).toBe('C:\\logs\\my app.log');
    expect(cleanPathInput(" '/tmp/my app.log' ")).toBe('/tmp/my app.log');
  });

  it('keeps quotes that are not a pair around the path', () => {
    expect(cleanPathInput('"/tmp/app.log')).toBe('"/tmp/app.log');
    expect(cleanPathInput("/tmp/it's.log")).toBe("/tmp/it's.log");
  });

  it('leaves nothing of blank input', () => {
    expect(cleanPathInput('   ')).toBe('');
    expect(cleanPathInput('""')).toBe('');
  });
});

describe('home directory', () => {
  it('recognises only a leading ~ of its own', () => {
    expect(usesHome('~')).toBe(true);
    expect(usesHome('~/app.log')).toBe(true);
    expect(usesHome('~\\app.log')).toBe(true);
    expect(usesHome('~other/app.log')).toBe(false);
    expect(usesHome('/tmp/~/app.log')).toBe(false);
  });

  it('expands to a path below home', () => {
    expect(expandHome('~/logs/app.log', '/Users/me')).toBe('/Users/me/logs/app.log');
    expect(expandHome('~/app.log', '/Users/me/')).toBe('/Users/me/app.log');
    expect(expandHome('~\\app.log', 'C:\\Users\\me')).toBe('C:\\Users\\me\\app.log');
    expect(expandHome('~', '/Users/me')).toBe('/Users/me');
  });

  it('takes the home path literally', () => {
    expect(expandHome('~/a.log', '/Users/$&')).toBe('/Users/$&/a.log');
  });
});
