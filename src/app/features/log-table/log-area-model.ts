import {
  AreaIdent,
  AreaModel,
  AreaModelIf,
  CellRendererIf,
  RendererCleanupFnType,
} from '@guiexpert/table';
import { LogLine } from '../../core/log/log.models';
import { cellSegments, lineSegments, TextSegment } from './highlight';
import { SessionState } from '../sessions/session-state';
import { rowClasses } from './table-logic';
import { spansRow } from './columns-logic';
import { gutterText, labelWidth, sourceColor } from '../merge/merge-logic';

export const COL_NUMBER = 0;
export const COL_TEXT = 1;
/** Column ids of the table besides the fields: the gutter and the raw line. */
export const ID_NUMBER = 'number';
export const ID_TEXT = 'text';

/** What a table column shows: the raw line (`field` -1) or one field of the column view. */
export interface TableColumn {
  id: string;
  field: number;
}

function appendSegments(parent: HTMLElement, segments: readonly TextSegment[]): void {
  // Plain text needs no span of its own: fewer nodes per cell (a column view has many cells).
  if (segments.length === 1 && !segments[0].cls) {
    parent.textContent = segments[0].text;
    return;
  }
  for (const seg of segments) {
    const span = document.createElement('span');
    if (seg.cls) span.className = seg.cls;
    span.textContent = seg.text;
    parent.appendChild(span);
  }
}

function appendCut(parent: HTMLElement): void {
  const cut = document.createElement('span');
  cut.className = 'cut';
  cut.textContent = ' … (gekürzt)';
  parent.appendChild(cut);
}

/**
 * Renders a log cell. Log lines are foreign data: only `textContent`, never `innerHTML`.
 */
class LogCellRenderer implements CellRendererIf {
  render(
    cellDiv: HTMLDivElement,
    _rowIndex: number,
    columnIndex: number,
    _areaIdent: AreaIdent,
    areaModel: AreaModelIf,
    cellValue: LogLine | null,
  ): RendererCleanupFnType | undefined {
    if (!cellValue) return undefined;
    cellDiv.dataset['line'] = String(cellValue.line);
    const model = areaModel as LogAreaModel;
    if (columnIndex === COL_NUMBER) {
      cellDiv.textContent = model.gutterText(cellValue);
      return undefined;
    }
    const column = model.columnAt(columnIndex);
    const text = document.createElement('span');
    text.className = 'lt-text';
    if (column.field < 0) {
      appendSegments(text, lineSegments(cellValue));
      if (cellValue.truncated) appendCut(text);
    } else {
      cellDiv.dataset['col'] = column.id;
      if (model.spans(cellValue)) {
        // Only the cell the span starts in shows the line; it moves left to begin at the first column.
        if (columnIndex !== model.spanFrom) return undefined;
        appendSegments(text, lineSegments(cellValue));
        if (cellValue.truncated) appendCut(text);
        if (model.spanOffset > 0) text.style.marginLeft = `-${model.spanOffset}px`;
      } else {
        appendSegments(text, cellSegments(cellValue, column.field, model.messageField));
        if (cellValue.truncated && column.field === model.messageField) appendCut(text);
      }
    }
    cellDiv.appendChild(text);
    return undefined;
  }
}

const RENDERER = new LogCellRenderer();

/**
 * Body of the table: the rows the view draws (`displayedLines`), the text from the `PageCache`.
 * Only visible cells are asked for; a line not loaded yet is a placeholder row.
 *
 * Raw view: gutter + one column with the line. Column view (prompt 009): gutter + one column per field. The
 * table moves columns (drag, `applyState`) through `changeColumnOrder`, so the model keeps its own order.
 * A line that is not split (continuation, no match) spans from `spanFrom` to the last column: the table
 * renders a colspan only from a cell it renders, so `spanFrom` is the first data column in view.
 */
export class LogAreaModel extends AreaModel {
  private columns: TableColumn[];
  /** Field of `message`, where an unsplit line goes; -1 in the raw view. */
  messageField = -1;
  /** Table column a spanning row starts in, and by how many px its text moves left. */
  spanFrom = COL_TEXT;
  spanOffset = 0;
  /** First shown data column: it carries the level mark. */
  leadColumn = COL_TEXT;
  /** Line numbers in the gutter (a merge shows it for the source name also without them). */
  showNumbers: () => boolean = () => true;

  constructor(
    private readonly session: () => SessionState,
    private readonly rowHeight: () => number,
    columns: TableColumn[] = [
      { id: ID_NUMBER, field: -1 },
      { id: ID_TEXT, field: -1 },
    ],
  ) {
    super();
    this.areaIdent = 'body';
    this.columns = columns;
  }

  get columnView(): boolean {
    return this.messageField >= 0;
  }

  columnAt(index: number): TableColumn {
    return this.columns[index] ?? { id: ID_TEXT, field: -1 };
  }

  columnIds(): string[] {
    return this.columns.map((c) => c.id);
  }

  /** The gutter: the line number, in a merge the short file name in front of it. */
  gutterText(line: LogLine): string {
    const session = this.session();
    const number = this.showNumbers() ? line.line : null;
    if (!session.isMerge) return number === null ? '' : String(number + 1);
    const labels = session.sourceLabels;
    return gutterText(labels[line.source] ?? '?', labelWidth(labels), number);
  }

  spans(line: LogLine): boolean {
    return this.columnView && spansRow(line, this.messageField);
  }

  override changeColumnOrder(sourceColumnIndex: number, targetColumnIndex: number): void {
    const [moved] = this.columns.splice(sourceColumnIndex, 1);
    this.columns.splice(targetColumnIndex, 0, moved);
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
    if (columnIndex === COL_NUMBER) return this.gutterText(line);
    const column = this.columnAt(columnIndex);
    if (column.field < 0) return line.text;
    if (this.spans(line)) return columnIndex === this.spanFrom ? line.text : '';
    const [start, end] = line.fields[column.field] ?? [0, 0];
    return line.text.slice(start, end);
  }

  override getColspanAt(rowIndex: number, columnIndex: number): number {
    if (!this.columnView || columnIndex !== this.spanFrom) return 1;
    const line = this.session().cache.line(rowIndex);
    return line && this.spans(line) ? this.columns.length - this.spanFrom : 1;
  }

  override getCustomClassesAt(rowIndex: number, columnIndex: number): string[] {
    const session = this.session();
    const line = session.cache.line(rowIndex);
    const classes = rowClasses(line, session.selection(), session.currentHitLine());
    if (columnIndex === COL_NUMBER) {
      classes.push('lt-gutter');
      if (line && session.bookmarks().has(line.line)) classes.push('bookmark');
      if (line && session.isMerge) classes.push('lt-src', `src-${sourceColor(line.source)}`);
      return classes;
    }
    classes.push('lt-cell');
    if (this.columnView) {
      classes.push('lt-col');
      if (columnIndex === this.leadColumn) classes.push('lt-lead');
      if (line && this.spans(line)) {
        classes.push(columnIndex === this.spanFrom ? 'lt-span' : 'lt-spanned');
      }
    }
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
