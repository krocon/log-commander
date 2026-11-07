import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { App } from './app';

describe('App', () => {
  it('shows the start screen without a session', async () => {
    (globalThis as unknown as { matchMedia: unknown }).matchMedia ??= () => ({
      matches: false,
      addEventListener: () => undefined,
    });
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Datei öffnen');
  });
});
