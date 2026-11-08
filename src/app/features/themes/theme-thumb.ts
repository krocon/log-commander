import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DARK, LIGHT } from '../../core/theme/builtin-themes';
import { Theme } from '../../core/theme/theme.models';
import { thumbStyle } from './theme-picker-logic';

/**
 * A small picture of a colour scheme (prompt 020), drawn from its own tokens without image files: toolbar
 * strip, the gutter, five log rows (TRACE, INFO with time and number, WARN, ERROR with its edge, FATAL), a
 * selected row with a search hit, the status line.
 */
@Component({
  selector: 'app-theme-thumb',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[style]': 'vars()' },
  template: `
    <div class="bar"><i class="dot"></i><span class="w30"></span></div>
    <div class="log">
      <div class="row trace"><span class="w55"></span></div>
      <div class="row info">
        <span class="time w15"></span><span class="w35"></span><span class="num w10"></span>
      </div>
      <div class="row selected">
        <span class="w20"></span><span class="hit w15"></span><span class="w25"></span>
      </div>
      <div class="row warn"><span class="w60"></span></div>
      <div class="row error"><span class="w50"></span></div>
      <div class="row debug"><span class="w40"></span></div>
      <div class="row fatal"><span class="w45"></span></div>
    </div>
    <div class="bar status"><span class="w40"></span></div>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-rows: 9px 1fr 8px;
      overflow: hidden;
      height: 74px;
      border: 1px solid var(--thumb-border);
      border-radius: 4px;
      background: var(--thumb-bg-app);
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 0 4px;
      background: var(--thumb-bg-panel);
      color: var(--thumb-text);
      border-bottom: 1px solid var(--thumb-border);
    }
    .status {
      color: var(--thumb-text-dim);
      border-bottom: 0;
      border-top: 1px solid var(--thumb-border);
    }
    .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--thumb-accent);
    }
    .log {
      display: flex;
      flex-direction: column;
      justify-content: space-evenly;
      border-left: 9px solid var(--thumb-bg-gutter);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 3px;
      height: 6px;
      padding: 0 4px;
      border-left: 2px solid transparent;
      color: var(--thumb-lv-info-fg);
    }
    span {
      height: 2px;
      border-radius: 1px;
      background: currentColor;
    }
    .trace {
      color: var(--thumb-lv-trace-fg);
    }
    .debug {
      color: var(--thumb-lv-debug-fg);
    }
    .time {
      color: var(--thumb-tok-time);
    }
    .num {
      color: var(--thumb-tok-number);
    }
    .selected {
      background: var(--thumb-row-selected);
      color: var(--thumb-text);
    }
    .hit {
      height: 5px;
      background: var(--thumb-hit-bg);
    }
    .warn {
      background: var(--thumb-lv-warn-bg);
      color: var(--thumb-lv-warn-fg);
    }
    .error {
      background: var(--thumb-lv-error-bg);
      color: var(--thumb-lv-error-fg);
      border-left-color: var(--thumb-lv-error-edge);
    }
    .fatal {
      background: var(--thumb-lv-fatal-bg);
      color: var(--thumb-lv-fatal-fg);
    }
    .w10 {
      width: 10%;
    }
    .w15 {
      width: 15%;
    }
    .w20 {
      width: 20%;
    }
    .w25 {
      width: 25%;
    }
    .w30 {
      width: 30%;
    }
    .w35 {
      width: 35%;
    }
    .w40 {
      width: 40%;
    }
    .w45 {
      width: 45%;
    }
    .w50 {
      width: 50%;
    }
    .w55 {
      width: 55%;
    }
    .w60 {
      width: 60%;
    }
  `,
})
export class ThemeThumb {
  readonly theme = input.required<Pick<Theme, 'tokens' | 'dark'>>();
  protected readonly vars = computed(() => thumbStyle(this.theme(), LIGHT, DARK));
}
