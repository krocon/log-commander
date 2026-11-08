import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionId } from './action-catalog';
import { DispatchEvent, DispatchHost, KeyboardDispatcher, placeOf } from './keyboard-dispatcher';
import { RawBindings, resolveKeymap } from './keymap';

function host(override: RawBindings = {}) {
  const ran: ActionId[] = [];
  const disabled = new Set<ActionId>();
  const recording = signal(false);
  const h: DispatchHost & { ran: ActionId[]; disabled: Set<ActionId>; rec: typeof recording } = {
    ran,
    disabled,
    rec: recording,
    recording: () => recording(),
    platform: () => 'macos',
    keymap: () => resolveKeymap('macos', override),
    canRun: (id) => !disabled.has(id),
    run: (id) => {
      ran.push(id);
      return true;
    },
  };
  return h;
}

function key(
  k: string,
  target: EventTarget | null = document.body,
  mods: Partial<DispatchEvent> = {},
): DispatchEvent & { prevented: boolean; stopped: boolean } {
  const e = {
    key: k,
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target,
    prevented: false,
    stopped: false,
    preventDefault() {
      e.prevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
    ...mods,
  };
  return e;
}

function el(html: string, selector: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.append(wrap);
  return wrap.querySelector<HTMLElement>(selector)!;
}

describe('KeyboardDispatcher', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('runs view keys in the log and stops the event', () => {
    const h = host();
    const d = new KeyboardDispatcher(h);
    const e = key('p');
    expect(d.handle(e)).toBe('TOGGLE_FREEZE');
    expect(e.prevented && e.stopped).toBe(true);
    expect(d.handle(key('E', document.body, { shiftKey: true }))).toBe('PREV_ERROR');
    expect(d.handle(key('>', document.body, { shiftKey: true }))).toBe('SECTION_FROM');
    expect(d.handle(key('?', document.body, { shiftKey: true }))).toBe('SHOW_SHORTCUTS');
  });

  it('keys nobody owns pass untouched', () => {
    const d = new KeyboardDispatcher(host());
    const e = key('q');
    expect(d.handle(e)).toBeNull();
    expect(e.prevented).toBe(false);
  });

  it('text fields keep plain keys; global shortcuts with Mod act there', () => {
    const d = new KeyboardDispatcher(host());
    const input = el('<input type="text">', 'input');
    expect(d.handle(key('p', input))).toBeNull();
    expect(d.handle(key('c', input, { metaKey: true }))).toBeNull(); // Mod+C is the field's
    expect(d.handle(key('o', input, { metaKey: true }))).toBe('OPEN_FILE');
    expect(d.handle(key('Enter', input))).toBeNull();
    expect(d.handle(key('?', el('<textarea></textarea>', 'textarea')))).toBeNull();
  });

  it('field actions act only in the search field', () => {
    const d = new KeyboardDispatcher(host());
    const search = el('<input type="search" data-action-field="search">', 'input');
    expect(d.handle(key('Enter', search))).toBe('FIND_NEXT');
    expect(d.handle(key('Enter', search, { shiftKey: true }))).toBe('FIND_PREV');
    expect(d.handle(key('Escape', search))).toBe('CLEAR_SEARCH');
    expect(d.handle(key('p', search))).toBeNull();
    expect(d.handle(key('f', search, { metaKey: true }))).toBe('FOCUS_SEARCH');
    // Esc in the log is the selection's
    expect(d.handle(key('Escape'))).toBe('CLEAR_SELECTION');
    expect(d.handle(key('Enter'))).toBeNull();
  });

  it('a dialog owns all its keys, global ones too', () => {
    const d = new KeyboardDispatcher(host());
    const button = el('<dialog open><button>x</button></dialog>', 'button');
    expect(d.handle(key('p', button))).toBeNull();
    expect(d.handle(key('w', button, { metaKey: true }))).toBeNull();
    expect(d.handle(key(' ', button))).toBeNull();
  });

  it('tree, panels and timeline keep their keys; D and Mod shortcuts still act', () => {
    const d = new KeyboardDispatcher(host());
    const item = el(
      '<div role="tree"><div role="treeitem" tabindex="0">x</div></div>',
      '[role=treeitem]',
    );
    expect(d.handle(key('t', item))).toBeNull();
    expect(d.handle(key('ArrowDown', item))).toBeNull();
    expect(d.handle(key('d', item))).toBe('TOGGLE_DETAIL');
    expect(d.handle(key('b', item, { metaKey: true }))).toBe('TOGGLE_SIDEBAR');
    const panel = el('<div class="detail"><pre tabindex="0">x</pre></div>', 'pre');
    expect(d.handle(key('ArrowUp', panel))).toBeNull();
    expect(d.handle(key('c', panel, { metaKey: true }))).toBeNull();
    expect(
      d.handle(key('Home', el('<div class="timeline" tabindex="0"></div>', '.timeline'))),
    ).toBeNull();
    expect(
      d.handle(key('Escape', el('<div class="lt-colmenu"><button>a</button></div>', 'button'))),
    ).toBeNull();
  });

  it('Space and Enter on a button are the button’s, other keys act', () => {
    const d = new KeyboardDispatcher(host());
    const button = el('<button>x</button>', 'button');
    expect(d.handle(key(' ', button))).toBeNull();
    expect(d.handle(key('p', button))).toBe('TOGGLE_FREEZE');
  });

  it('a disabled action lets the key pass (Mod+C with marked text copies the text)', () => {
    const h = host();
    h.disabled.add('COPY_SELECTION');
    const d = new KeyboardDispatcher(h);
    const e = key('c', document.body, { metaKey: true });
    expect(d.handle(e)).toBeNull();
    expect(e.prevented).toBe(false);
  });

  it('a held key repeats only repeatable actions', () => {
    const h = host();
    const d = new KeyboardDispatcher(h);
    expect(d.handle(key('ArrowDown', document.body, { repeat: true }))).toBe('SCROLL_LINE_DOWN');
    const held = key('p', document.body, { repeat: true });
    expect(d.handle(held)).toBeNull();
    expect(held.prevented).toBe(true); // and nothing else gets it either
    expect(h.ran).toEqual(['SCROLL_LINE_DOWN']);
  });

  it('nothing acts while a shortcut is recorded or text is composed', () => {
    const h = host();
    const d = new KeyboardDispatcher(h);
    h.rec.set(true);
    expect(d.handle(key('p'))).toBeNull();
    h.rec.set(false);
    expect(d.handle(key('p', document.body, { isComposing: true }))).toBeNull();
  });

  it('follows the override: K freezes, P does nothing', () => {
    const d = new KeyboardDispatcher(host({ TOGGLE_FREEZE: ['K'] }));
    expect(d.handle(key('k'))).toBe('TOGGLE_FREEZE');
    expect(d.handle(key('p'))).toBeNull();
  });

  describe('chords', () => {
    beforeEach(() => vi.useFakeTimers());

    it('waits 1.5 s for the second stroke', () => {
      const d = new KeyboardDispatcher(host({ OPEN_SETTINGS: ['Mod+K S'] }));
      const first = key('k', document.body, { metaKey: true });
      expect(d.handle(first)).toBeNull();
      expect(first.prevented).toBe(true);
      expect(d.handle(key('s'))).toBe('OPEN_SETTINGS');
      d.handle(key('k', document.body, { metaKey: true }));
      vi.advanceTimersByTime(1600);
      expect(d.handle(key('s'))).toBeNull();
    });
  });

  it('places', () => {
    expect(placeOf(null)).toBe('view');
    expect(placeOf(el('<input type="checkbox">', 'input'))).toBe('control');
    expect(placeOf(el('<input type="range">', 'input'))).toBe('input');
  });
});
