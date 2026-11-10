import { describe, expect, it } from 'vitest';
import { serial } from './serial';

describe('serial', () => {
  it('starts a job only when the one before has ended, so each sees the state the last one left', async () => {
    const inOrder = serial();
    let stored = ['a', 'b', 'c'];
    const answers: (() => void)[] = [];
    // Like deleting a profile: read the list, store it without one entry (the store answers later).
    const remove = (id: string) =>
      inOrder(async () => {
        const next = stored.filter((p) => p !== id);
        await new Promise<void>((resolve) => answers.push(resolve));
        stored = next;
      });
    const first = remove('a');
    const second = remove('b');
    await Promise.resolve();
    expect(answers.length).toBe(1);
    answers[0]();
    await first;
    await Promise.resolve();
    answers[1]();
    await second;
    // Without the order both would have started from ['a','b','c'] and 'a' would be back.
    expect(stored).toEqual(['c']);
  });

  it('goes on after a failed job and hands results and errors to their caller', async () => {
    const inOrder = serial();
    const failed = inOrder(async () => {
      throw new Error('no');
    });
    const fine = inOrder(async () => 7);
    await expect(failed).rejects.toThrow('no');
    expect(await fine).toBe(7);
  });
});
