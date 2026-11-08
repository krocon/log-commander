import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../settings/settings.service';
import { ActionService, MenuAccelerator } from './action.service';

describe('ActionService', () => {
  let actions: ActionService;
  let settings: SettingsService;
  let menus: MenuAccelerator[][];

  beforeEach(async () => {
    TestBed.configureTestingModule({});
    settings = TestBed.inject(SettingsService);
    actions = TestBed.inject(ActionService);
    menus = [];
    actions.sendMenu = (items) => {
      menus.push(items);
      return Promise.resolve();
    };
    await actions.load();
    settings.loaded.set(true);
    TestBed.tick();
  });

  it('runs registered handlers, not disabled or removed ones', () => {
    const run = vi.fn();
    let on = true;
    const off = actions.register('TOGGLE_FREEZE', run, () => on);
    expect(actions.isRegistered('TOGGLE_FREEZE')).toBe(true);
    expect(actions.run('TOGGLE_FREEZE')).toBe(true);
    on = false;
    expect(actions.run('TOGGLE_FREEZE')).toBe(false);
    off();
    on = true;
    expect(actions.run('TOGGLE_FREEZE')).toBe(false);
    expect(actions.isRegistered('TOGGLE_FREEZE')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a key and its menu event for one press run the action once', () => {
    const run = vi.fn();
    actions.register('OPEN_FILE', run);
    expect(actions.run('OPEN_FILE', 'key')).toBe(true);
    expect(actions.run('OPEN_FILE', 'menu')).toBe(false);
    expect(actions.run('OPEN_FILE', 'key')).toBe(true); // a second press
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('nothing runs while recording; failures go to the error banner', async () => {
    const errors: string[] = [];
    actions.reportError = (m) => errors.push(m);
    actions.register('EXPORT', () => Promise.reject(new Error('kaputt')));
    actions.recording.set(true);
    expect(actions.run('EXPORT')).toBe(false);
    actions.recording.set(false);
    expect(actions.run('EXPORT')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual(['EXPORT: kaputt']);
  });

  it('the override comes from the settings; the menu follows, off while recording', () => {
    actions.platform.set('macos');
    TestBed.tick();
    const open = () => menus.at(-1)!.find((m) => m.id === 'OPEN_FILE')!.shortcut;
    expect(open()).toBe('Mod+O');
    expect(menus.at(-1)!.map((m) => m.id)).toContain('OPEN_SHORTCUTS');
    actions.setOverride({ OPEN_FILE: ['Mod+Shift+P'], TOGGLE_FREEZE: ['K'] });
    TestBed.tick();
    expect(settings.settings().keymap).toEqual({
      version: 1,
      bindings: { OPEN_FILE: ['Mod+Shift+P'], TOGGLE_FREEZE: ['K'] },
    });
    expect(actions.shortcuts('TOGGLE_FREEZE')).toEqual(['K']);
    expect(open()).toBe('Mod+Shift+P');
    expect(actions.hint('OPEN_FILE')).toBe(' (⇧⌘P)');
    actions.recording.set(true);
    TestBed.tick();
    expect(menus.at(-1)!.every((m) => m.shortcut === null)).toBe(true);
  });

  it('a start notice only for own shortcuts with problems or an unreadable store', () => {
    expect(actions.startNotice()).toBeNull();
    actions.setOverride({ NOPE: ['K'] });
    expect(actions.startNotice()).toContain('1 Hinweis');
    settings.keymapNotice.set('kaputt.');
    expect(actions.startNotice()).toBe(
      'kaputt. Tastenkürzel: 1 Hinweis(e), siehe Hilfe ▸ Tastenkürzel.',
    );
  });

  it('attach dispatches keydown in the capture phase', () => {
    const run = vi.fn();
    actions.register('TOGGLE_FREEZE', run);
    actions.platform.set('linux');
    const detach = actions.attach(document);
    const stopped = vi.fn();
    document.body.addEventListener('keydown', stopped);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    detach();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    document.body.removeEventListener('keydown', stopped);
    expect(run).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1); // the first was stopped, the second not handled
  });
});
