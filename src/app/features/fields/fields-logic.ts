import {
  Column,
  ColumnSet,
  ExtractRule,
  FieldSuggestion,
  ValueKind,
} from '../../core/log/log.models';
import { MAX_EXTRACT_RULES } from '../../core/settings/settings.models';

export const MAX_RULE_NAME = 40;

export const VALUE_KINDS: readonly { kind: ValueKind; label: string }[] = [
  { kind: 'text', label: 'Text' },
  { kind: 'number', label: 'Zahl' },
  { kind: 'percent', label: 'Prozent' },
  { kind: 'duration', label: 'Dauer' },
  { kind: 'size', label: 'Größe' },
];

export function kindLabel(kind: ValueKind): string {
  return VALUE_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

/** Columns that are numbers (prompt 011): right-aligned with `tabular-nums`. */
export function isNumericKind(kind: string): boolean {
  return kind === 'number' || kind === 'percent' || kind === 'duration' || kind === 'size';
}

/** The columns of the format itself, without extracted ones: names of rules must not be one of them. */
export function formatColumns(set: ColumnSet | null | undefined): Column[] {
  return (set?.columns ?? []).filter((c) => !c.rule);
}

/** What is wrong with each rule, by rule id; the backend checks the patterns. Empty when all is fine. */
export function ruleIssues(
  rules: readonly ExtractRule[],
  columns: readonly Column[],
): Map<string, string> {
  const issues = new Map<string, string>();
  const names = new Map<string, string>();
  rules.forEach((rule, i) => {
    const name = rule.name.trim();
    const lower = name.toLowerCase();
    const column = columns.find(
      (c) => c.id.toLowerCase() === lower || c.label.toLowerCase() === lower,
    );
    let issue: string | null = null;
    if (i >= MAX_EXTRACT_RULES) issue = `Höchstens ${MAX_EXTRACT_RULES} Regeln je Format`;
    else if (!name) issue = 'Name fehlt';
    else if (name.length > MAX_RULE_NAME)
      issue = `Name zu lang (höchstens ${MAX_RULE_NAME} Zeichen)`;
    else if (column) issue = `„${name}“ ist schon eine Spalte (${column.label})`;
    else if (names.has(lower)) issue = `Name „${name}“ doppelt`;
    else if (!rule.pattern) issue = 'Muster fehlt';
    else if (!rule.column) issue = 'Quellspalte fehlt';
    if (issue) issues.set(rule.id, issue);
    if (name) names.set(lower, rule.id);
  });
  return issues;
}

/** An id no rule in `rules` has. */
export function newRuleId(rules: readonly { id: string }[], seed = Date.now()): string {
  const taken = new Set(rules.map((r) => r.id));
  let n = seed % 1_000_000;
  while (taken.has(`r-${n.toString(36)}`)) n++;
  return `r-${n.toString(36)}`;
}

/** A name not used by a rule or column yet: `cpu`, else `cpu_2`, `cpu_3` … */
export function freeName(
  name: string,
  rules: readonly ExtractRule[],
  columns: readonly Column[],
): string {
  const used = new Set([
    ...rules.map((r) => r.name.toLowerCase()),
    ...columns.flatMap((c) => [c.id.toLowerCase(), c.label.toLowerCase()]),
  ]);
  const base = name.trim().slice(0, MAX_RULE_NAME - 4) || 'feld';
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** A suggestion as the dialog edits it: picked or not, name and kind changeable. */
export interface SuggestionPick {
  suggestion: FieldSuggestion;
  picked: boolean;
  name: string;
  kind: ValueKind;
}

export function picksOf(
  suggestions: readonly FieldSuggestion[],
  rules: readonly ExtractRule[] = [],
): SuggestionPick[] {
  return suggestions
    .filter((s) => !rules.some((r) => r.name.toLowerCase() === s.rule.name.toLowerCase()))
    .map((suggestion) => ({
      suggestion,
      picked: true,
      name: suggestion.rule.name,
      kind: suggestion.rule.kind,
    }));
}

/** The rules with the picked suggestions behind them; ids stay unique. */
export function acceptSuggestions(
  rules: readonly ExtractRule[],
  picks: readonly SuggestionPick[],
): ExtractRule[] {
  const out = [...rules];
  for (const pick of picks) {
    if (!pick.picked) continue;
    const id = out.some((r) => r.id === pick.suggestion.rule.id)
      ? newRuleId(out, out.length)
      : pick.suggestion.rule.id;
    out.push({
      ...pick.suggestion.rule,
      id,
      name: pick.name.trim(),
      kind: pick.kind,
      // A unit only means something for numbers with a unit.
      unit:
        pick.kind === 'duration' || pick.kind === 'size' || pick.kind === 'percent'
          ? pick.suggestion.rule.unit
          : null,
    });
  }
  return out;
}

export function formatShare(share: number): string {
  const percent = share * 100;
  return `${percent >= 10 || percent === 0 ? Math.round(percent) : percent.toFixed(1)} %`;
}

/** A value in the base unit of its kind, short, for the preview. */
export function formatValue(value: number | null, kind: ValueKind): string {
  if (value === null) return '–';
  const n = (x: number): string => String(Number(x.toPrecision(6)));
  switch (kind) {
    case 'percent':
      return `${n(value)} %`;
    case 'duration':
      return `${n(value)} s`;
    case 'size':
      return `${n(value)} B`;
    default:
      return n(value);
  }
}

/** The status bar's hint: „1 Feld erkannt“, „4 Felder erkannt“. */
export function hintText(count: number): string {
  return count === 1 ? '1 Feld erkannt' : `${count} Felder erkannt`;
}
