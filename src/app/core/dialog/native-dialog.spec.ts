import { describe, expect, it } from 'vitest';
import { takeScripted } from './native-dialog';

describe('scripted dialog answers', () => {
  it('are ignored unless the backend runs an end-to-end scenario', () => {
    const queue = ['/tmp/evil.lcw'];
    expect(takeScripted(queue, false)).toBeNull();
    expect(queue).toEqual(['/tmp/evil.lcw']);
  });

  it('are taken in order in a scenario', () => {
    const queue: (string | null)[] = ['/tmp/a.csv', null];
    expect(takeScripted(queue, true)).toEqual({ path: '/tmp/a.csv' });
    expect(takeScripted(queue, true)).toEqual({ path: null });
    expect(takeScripted(queue, true)).toBeNull();
    expect(takeScripted('nonsense', true)).toBeNull();
  });
});
