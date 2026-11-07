import { Injectable, computed, inject, signal } from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { NARROW_BELOW, sidebarShown, toggleSidebar } from './sidebar-logic';

/** Whether the sidebar shows (prompt 005): the setting, and a narrow window hides it for a while. */
@Injectable({ providedIn: 'root' })
export class SidebarState {
  private readonly settings = inject(SettingsService);
  readonly narrow = signal(false);
  /** Shown in a narrow window anyway (Cmd/Ctrl+B there); forgotten once the window is wide again. */
  private readonly override = signal(false);

  readonly shown = computed(() =>
    sidebarShown({
      visible: this.settings.settings().sidebarVisible,
      narrow: this.narrow(),
      override: this.override(),
    }),
  );

  /** The width of the window area below the toolbar. */
  setWidth(width: number): void {
    const narrow = width > 0 && width < NARROW_BELOW;
    if (narrow === this.narrow()) return;
    this.narrow.set(narrow);
    if (!narrow) this.override.set(false);
  }

  toggle(): void {
    const next = toggleSidebar({
      visible: this.settings.settings().sidebarVisible,
      narrow: this.narrow(),
      override: this.override(),
    });
    this.override.set(next.override);
    if (next.visible !== this.settings.settings().sidebarVisible) {
      this.settings.update({ sidebarVisible: next.visible });
    }
  }
}
