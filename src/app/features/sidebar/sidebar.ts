import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { SplitterComponent } from '../../shared/splitter';
import { SessionState } from '../sessions/session-state';
import { LogTreeComponent } from './log-tree';
import { TREE_MIN, treeHeight, treeMax, treeShare } from './sidebar-logic';
import { StatsPanelComponent } from './stats-panel';

/** Left of the log (prompt 005): the tree above, the statistics below, split by a splitter. */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LogTreeComponent, SplitterComponent, StatsPanelComponent],
  host: { role: 'complementary', 'aria-label': 'Seitenleiste' },
  template: `
    <app-log-tree id="sidebar-tree" [style.height.px]="treeH()" />
    <app-splitter
      orientation="horizontal"
      pane="before"
      label="Höhe des Baums"
      title="Höhe ziehen, Pfeiltasten verschieben, Doppelklick: Standard"
      controls="sidebar-tree"
      [size]="treeH()"
      [min]="treeMin"
      [max]="treeMaxH()"
      [defaultSize]="defaultTreeH()"
      (sizeChange)="dragTree.set($event)"
      (sizeCommit)="commitTree($event)"
    />
    <app-stats-panel [session]="session()" />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-panel);
      overflow: hidden;
    }
    app-log-tree {
      flex: none;
      min-height: 0;
    }
    app-stats-panel {
      flex: 1 1 0;
      min-height: 0;
    }
  `,
})
export class SidebarComponent implements OnInit, OnDestroy {
  private readonly settingsService = inject(SettingsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly session = input.required<SessionState>();

  protected readonly treeMin = TREE_MIN;
  private readonly height = signal(0);
  protected readonly dragTree = signal<number | null>(null);
  protected readonly treeH = computed(
    () =>
      this.dragTree() ??
      treeHeight(this.settingsService.settings().sidebarTreeShare, this.height()),
  );
  protected readonly treeMaxH = computed(() => treeMax(this.height()));
  protected readonly defaultTreeH = computed(() =>
    treeHeight(DEFAULT_SETTINGS.sidebarTreeShare, this.height()),
  );
  private observer: ResizeObserver | null = null;

  ngOnInit(): void {
    const element = this.host.nativeElement;
    this.height.set(element.clientHeight);
    this.observer = new ResizeObserver(() => this.height.set(element.clientHeight));
    this.observer.observe(element);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  protected commitTree(height: number): void {
    this.dragTree.set(null);
    this.settingsService.update({ sidebarTreeShare: treeShare(height, this.height()) });
  }
}
