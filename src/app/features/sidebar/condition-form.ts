/**
 * The form of a filter condition (prompt 010) as plain data: one flat state for all kinds, so switching the
 * kind keeps what was typed. `toCond` gives the condition, or why it is not complete yet; the backend checks
 * the rest (regex, time, numbers) and names the node.
 */
import { FieldOp, FilterCond, FilterCondType, Level } from '../../core/log/log.models';

export interface ConditionForm {
  type: FilterCondType;
  negate: boolean;
  text: string;
  isRegex: boolean;
  caseSensitive: boolean;
  levels: Level[];
  column: string;
  op: FieldOp;
  value: string;
  value2: string;
  from: string;
  to: string;
  end: string;
  inclusive: boolean;
  /** Line numbers as the user sees them, from 1; empty = open. */
  firstLine: string;
  lastLine: string;
}

export function emptyForm(column = 'message'): ConditionForm {
  return {
    type: 'text',
    negate: false,
    text: '',
    isRegex: false,
    caseSensitive: false,
    levels: ['WARN', 'ERROR', 'FATAL'],
    column,
    op: 'contains',
    value: '',
    value2: '',
    from: '',
    to: '',
    end: '',
    inclusive: true,
    firstLine: '',
    lastLine: '',
  };
}

export function formOf(cond: FilterCond, negate: boolean, column = 'message'): ConditionForm {
  const form = { ...emptyForm(column), type: cond.type, negate };
  switch (cond.type) {
    case 'text':
      return { ...form, text: cond.text, isRegex: cond.isRegex, caseSensitive: cond.caseSensitive };
    case 'level':
      return { ...form, levels: [...cond.levels] };
    case 'field':
      return {
        ...form,
        column: cond.column,
        op: cond.op,
        value: cond.value,
        value2: cond.value2 ?? '',
        caseSensitive: cond.caseSensitive ?? false,
      };
    case 'time':
      return { ...form, from: cond.from ?? '', to: cond.to ?? '' };
    case 'range':
      return {
        ...form,
        text: cond.start.text,
        isRegex: cond.start.isRegex,
        caseSensitive: cond.start.caseSensitive,
        end: cond.end?.text ?? '',
        inclusive: cond.inclusive,
      };
    case 'lines':
      return {
        ...form,
        firstLine: cond.first === null || cond.first === undefined ? '' : String(cond.first + 1),
        lastLine: cond.last === null || cond.last === undefined ? '' : String(cond.last + 1),
      };
  }
}

/** A line number typed from 1, as the index counts it from 0; `undefined` when it is no number. */
function lineOf(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 0x100000000 ? n - 1 : undefined;
}

export type FormResult = { cond: FilterCond } | { missing: string };

export function toCond(form: ConditionForm): FormResult {
  const flags = { isRegex: form.isRegex, caseSensitive: form.caseSensitive };
  switch (form.type) {
    case 'text':
      if (!form.text) return { missing: 'Text fehlt' };
      return { cond: { type: 'text', text: form.text, ...flags } };
    case 'level':
      if (!form.levels.length) return { missing: 'Mindestens ein Level wählen' };
      return { cond: { type: 'level', levels: [...form.levels] } };
    case 'field':
      if (!form.column) return { missing: 'Spalte fehlt' };
      if (form.op === 'between' && (!form.value || !form.value2)) {
        return { missing: 'Beide Grenzen angeben' };
      }
      if (!form.value && form.op !== 'eq') return { missing: 'Wert fehlt' };
      return {
        cond: {
          type: 'field',
          column: form.column,
          op: form.op,
          value: form.value,
          value2: form.op === 'between' ? form.value2 : null,
          caseSensitive: form.caseSensitive,
        },
      };
    case 'time':
      if (!form.from.trim() && !form.to.trim()) return { missing: 'Beginn oder Ende angeben' };
      return { cond: { type: 'time', from: form.from.trim() || null, to: form.to.trim() || null } };
    case 'range':
      if (!form.text) return { missing: 'Startmuster fehlt' };
      return {
        cond: {
          type: 'range',
          start: { text: form.text, ...flags },
          end: form.end ? { text: form.end, ...flags } : null,
          inclusive: form.inclusive,
        },
      };
    case 'lines': {
      const first = lineOf(form.firstLine);
      const last = lineOf(form.lastLine);
      if (first === undefined || last === undefined) return { missing: 'Zeilennummern ab 1' };
      if (first === null && last === null) return { missing: 'Erste oder letzte Zeile angeben' };
      if (first !== null && last !== null && first > last) {
        return { missing: 'Die erste Zeile liegt nach der letzten' };
      }
      return { cond: { type: 'lines', first, last } };
    }
  }
}
