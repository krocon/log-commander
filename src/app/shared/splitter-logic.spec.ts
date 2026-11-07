import { describe, expect, it } from 'vitest';
import { clampSize, dragSize, keySize } from './splitter-logic';

describe('splitter logic', () => {
  it('clamps to the bounds, the minimum wins over a smaller maximum', () => {
    expect(clampSize(50, 80, 400)).toBe(80);
    expect(clampSize(500, 80, 400)).toBe(400);
    expect(clampSize(200.4, 80, 400)).toBe(200);
    expect(clampSize(200, 80, 40)).toBe(80);
    expect(clampSize(Number.NaN, 80, 400)).toBe(80);
  });

  it('grows a pane after the splitter when dragged towards the start', () => {
    expect(dragSize(200, 500, 450, 'after', 80, 400)).toBe(250);
    expect(dragSize(200, 500, 560, 'after', 80, 400)).toBe(140);
    expect(dragSize(200, 500, 0, 'after', 80, 400)).toBe(400);
    expect(dragSize(200, 500, 900, 'after', 80, 400)).toBe(80);
  });

  it('grows a pane before the splitter when dragged towards the end', () => {
    expect(dragSize(200, 100, 160, 'before', 80, 400)).toBe(260);
    expect(dragSize(200, 100, 0, 'before', 80, 400)).toBe(100);
  });

  it('moves by keys: arrows, Shift for big steps, Home and End to the bounds', () => {
    expect(keySize(200, 'ArrowUp', false, 'horizontal', 'after', 80, 400)).toBe(210);
    expect(keySize(200, 'ArrowDown', false, 'horizontal', 'after', 80, 400)).toBe(190);
    expect(keySize(200, 'ArrowUp', true, 'horizontal', 'after', 80, 400)).toBe(300);
    expect(keySize(395, 'ArrowUp', false, 'horizontal', 'after', 80, 400)).toBe(400);
    expect(keySize(200, 'ArrowRight', false, 'vertical', 'before', 80, 400)).toBe(210);
    expect(keySize(200, 'Home', false, 'horizontal', 'after', 80, 400)).toBe(80);
    expect(keySize(200, 'End', false, 'horizontal', 'after', 80, 400)).toBe(400);
    expect(keySize(200, 'ArrowLeft', false, 'horizontal', 'after', 80, 400)).toBeNull();
    expect(keySize(200, 'x', false, 'vertical', 'after', 80, 400)).toBeNull();
  });
});
