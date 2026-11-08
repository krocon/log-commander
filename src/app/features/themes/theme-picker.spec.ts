import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogApi } from '../../core/log/log-api';
import { SettingsService } from '../../core/settings/settings.service';
import { ThemeService } from '../../core/theme/theme.service';
import { ThemePickerComponent } from './theme-picker';

describe('ThemePickerComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.removeAttribute('style');
    (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto['showModal'] = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto['close'] = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  async function open() {
    TestBed.configureTestingModule({
      imports: [ThemePickerComponent],
      providers: [
        { provide: LogApi, useValue: { setWindowChrome: vi.fn(() => Promise.resolve()) } },
      ],
    });
    const theme = TestBed.inject(ThemeService);
    const settings = TestBed.inject(SettingsService);
    const fixture = TestBed.createComponent(ThemePickerComponent);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    await theme.loadCatalog();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const key = (target: Element, k: string) => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      fixture.detectChanges();
    };
    return { fixture, theme, settings, el, closed, key };
  }

  it('shows all schemes, „System folgen“ chosen, and filters with a count', async () => {
    const { el, fixture } = await open();
    expect(el.querySelectorAll('.card').length).toBe(18);
    expect(el.querySelector('.card.chosen')?.getAttribute('data-id')).toBe('system');
    expect(el.querySelector('.count')?.textContent).toContain('17 von 17');
    const input = el.querySelector<HTMLInputElement>('#theme-filter')!;
    input.value = 'hell';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect([...el.querySelectorAll('.card')].map((c) => c.getAttribute('data-id'))).toEqual([
      'system',
      'light',
      'true-light',
      'solarized-light',
    ]);
    expect(el.querySelector('.count')?.textContent).toContain('3 von 17');
    expect(el.querySelector('.count')?.getAttribute('role')).toBe('status');
  });

  it('arrow keys preview a scheme, Enter keeps it', async () => {
    const { el, theme, settings, key, closed } = await open();
    const grid = el.querySelector('[role=listbox]')!;
    key(grid, 'ArrowRight');
    key(grid, 'ArrowRight');
    expect(theme.preview()?.id).toBe('one-dark');
    expect(grid.getAttribute('aria-activedescendant')).toBe('theme-option-one-dark');
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--bg-app')).not.toBe('');
    key(grid, 'Enter');
    expect(settings.settings().themeSelection).toMatchObject({ mode: 'fixed', theme: 'one-dark' });
    expect(theme.preview()).toBeNull();
    expect(closed).toHaveBeenCalled();
  });

  it('Esc goes back to the scheme from before', async () => {
    const { el, theme, settings, key } = await open();
    const grid = el.querySelector('[role=listbox]')!;
    key(grid, 'End');
    expect(theme.preview()?.id).toBe('solarized-light');
    el.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(theme.preview()).toBeNull();
    expect(settings.settings().themeSelection.mode).toBe('system');
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('');
  });

  it('offers the light and dark scheme of „System folgen“', async () => {
    const { el, theme, settings, fixture } = await open();
    const dark = el.querySelector<HTMLSelectElement>('#theme-pair-dark')!;
    expect(dark.options.length).toBe(14);
    dark.value = 'amber';
    dark.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(theme.preview()?.id).toBe('amber');
    el.querySelector<HTMLButtonElement>('button.primary')!.click();
    expect(settings.settings().themeSelection).toMatchObject({ mode: 'system', dark: 'amber' });
  });
});
