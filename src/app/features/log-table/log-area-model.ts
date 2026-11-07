import {
  AreaIdent,
  AreaModel,
  AreaModelIf,
  CellRendererIf,
  RendererCleanupFnType,
} from '@guiexpert/table';
import { LogLine } from '../../core/log/log.models';
import { lineSegments } from './highlight';
import { SessionState } from '../sessions/session-state';
import { rowClasses } from './table-logic';

export const COL_NUMBER = 0;
export const COL_TEXT = 1;

/**
 * Renders a log cell. Log lines are foreign data: only `textContent`, never `innerHTML`.
 */
class LogCellRenderer implements CellRendererIf {
  render(
    cellDiv: HTMLDivElement,
    _rowIndex: number,
    columnIndex: number,
    _areaIdent: AreaIdent,
    _areaModel: AreaModelIf,
    cellValue: LogLine | null,
  ): RendererCleanupFnType | undefined {
    if (!cellValue) return undefined;
    cellDiv.dataset['line'] = String(cellValue.line);
    if (columnIndex === COL_NUMBER) {
      cellDiv.textContent = String(cellValue.line + 1);
      return undefined;
    }
    const text = document.createElement('span');
    text.className = 'lt-text';
    for (const seg of lineSegments(cellValue)) {
      const span = document.createElement('span');
      if (seg.cls) span.className = seg.cls;
      span.textContent = seg.text;
      text.appendChild(span);
    }
    if (cellValue.truncated) {
      const cut = document.createElement('span');
      cut.className = 'cut';
      cut.textContent = ' … (gekürzt)';
      text.appendChild(cut);
    }
    cellDiv.appendChild(text);
    return undefined;
  }
}

const RENDERER = new LogCellRenderer();

/**
 * Body of the table: the rows the view draws (`displayedLines`), the text from the `PageCache`.
 * Only visible cells are asked for; a line not loaded yet is a placeholder row.
 */
export class LogAreaModel extends AreaModel {
  constructor(
    private readonly session: () => SessionState,
    private readonly rowHeight: () => number,
  ) {
    super();
    this.areaIdent = 'body';
  }

  override getRowCount(): number {
    return this.session().displayedLines();
  }

  override getRowHeight(): number {
    return this.rowHeight();
  }

  override getConstantRowHeight(): number {
    return this.rowHeight();
  }

  override getValueAt(rowIndex: number): LogLine | null {
    return this.session().cache.line(rowIndex);
  }

  override getTextValueAt(rowIndex: number, columnIndex: number): string {
    const line = this.session().cache.line(rowIndex);
    if (!line) return '';
    return columnIndex === COL_NUMBER ? String(line.line + 1) : line.text;
  }

  override getCustomClassesAt(rowIndex: number, columnIndex: number): string[] {
    const session = this.session();
    const classes = rowClasses(
      session.cache.line(rowIndex),
      session.selection(),
      session.currentHitLine(),
    );
    classes.push(columnIndex === COL_NUMBER ? 'lt-gutter' : 'lt-cell');
    return classes;
  }

  override getCellRenderer(): CellRendererIf {
    return RENDERER;
  }

  override isEditable(): boolean {
    return false;
  }

  override isSelectable(): boolean {
    return false;
  }
}
