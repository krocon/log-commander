// Browser stand-in for the Tauri IPC, only for scripts/screenshots.mjs. The real behaviour is tested
// against the real backend by scripts/e2e/run.mjs; this just has to produce plausible views.
(() => {
  const LEVELS = ['UNKNOWN', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
  const WORD = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|CRITICAL|FATAL)\b/;
  const callbacks = new Map();
  let nextCallback = 1;
  let setupData = { files: {}, recent: [] };
  const sessions = new Map();

  // The Spring Boot layout of the log4j profile (prompt 008), enough for the column view in the screenshots.
  const SPRING =
    /^(?<timestamp>\S+)\s+(?<level>[A-Z]+)\s+(?<pid>\d+)\s+---\s+\[\s*(?<thread>[^\]]*?)\]\s+(?<logger>\S+)\s+:\s(?<message>.*)$/d;
  const SPRING_COLUMNS = [
    { id: 'timestamp', label: 'Zeit', kind: 'timestamp' },
    { id: 'level', label: 'Level', kind: 'level' },
    { id: 'pid', label: 'pid', kind: 'text' },
    { id: 'thread', label: 'Thread', kind: 'text' },
    { id: 'logger', label: 'Logger', kind: 'text' },
    { id: 'message', label: 'Nachricht', kind: 'text' },
  ];
  const MESSAGE_ONLY = [{ id: 'message', label: 'Nachricht', kind: 'text' }];

  function fieldsOf(line, columns, isContinuation) {
    const whole = columns.map((c) => (c.id === 'message' ? [0, line.length] : [0, 0]));
    if (columns.length === 1 || isContinuation) return whole;
    const match = line.match(SPRING);
    if (!match) return whole;
    return columns.map((c) => match.indices.groups[c.id] ?? [0, 0]);
  }

  function classify(text, columns) {
    let level = 'UNKNOWN';
    return text
      .split('\n')
      .filter((line, i, all) => line || i < all.length - 1)
      .map((line, index) => {
        const match = /^\s/.test(line) ? null : line.slice(0, 200).match(WORD);
        const isContinuation = !match && index > 0;
        if (match) {
          const word = match[1];
          level = word === 'WARNING' ? 'WARN' : word === 'CRITICAL' ? 'FATAL' : word;
        }
        return {
          line: index,
          level,
          source: 0,
          text: line,
          isContinuation,
          truncated: false,
          matches: [],
          fields: fieldsOf(line, columns, isContinuation),
        };
      });
  }

  // Filter tree (prompt 010), simplified for the screenshots: per line, not per entry; text, level and
  // line numbers, everything else counts as fulfilled.
  function holds(expr, line) {
    if (!expr) return true;
    let value;
    if (expr.kind === 'group') {
      value =
        expr.op === 'and'
          ? expr.children.every((c) => holds(c, line))
          : expr.children.some((c) => holds(c, line));
    } else {
      const c = expr.cond;
      if (c.type === 'text') value = line.text.toLowerCase().includes(c.text.toLowerCase());
      else if (c.type === 'level') value = c.levels.includes(line.level);
      else if (c.type === 'lines') value = line.line >= (c.first ?? 0) && line.line <= (c.last ?? Infinity);
      else value = true;
    }
    return value !== !!expr.negate;
  }

  // Filter tabs (prompt 013): a view inherits everything of its session (prototype) and shows the lines of its
  // parent view that its own filter lets through.
  function target(sessionId, viewId) {
    const session = sessions.get(sessionId);
    return viewId ? session.views.get(viewId) : session;
  }

  function send(view) {
    callbacks.get(view.channel)?.({ message: update(view), index: view.sent++ });
  }

  /** The view and every open view below it. */
  function below(view) {
    const root = view.root ?? view;
    const out = [view];
    for (const v of root.views.values()) if (out.includes(v.parentView) && !out.includes(v)) out.push(v);
    return out;
  }

  function visible(session) {
    const { levels, search, mode, expr } = session.filter;
    const base = session.parentView ? visible(session.parentView) : session.lines;
    return base.filter(
      (l) =>
        levels.includes(l.level) &&
        (mode !== 'filter' || !search || l.text.toLowerCase().includes(search.toLowerCase())) &&
        holds(expr, l),
    );
  }

  function update(session) {
    const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
    for (const line of session.lines) counts[line.level]++;
    const shown = visible(session);
    const viewCounts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
    for (const line of shown) viewCounts[line.level]++;
    return {
      totalLines: session.lines.length,
      filteredLines: shown.length,
      counts,
      viewCounts,
      status: { kind: 'live' },
      fileSize: session.size,
      epoch: 0,
      viewGeneration: session.generation,
      report: session.report ?? null,
      columnsRevision: session.columnsRevision ?? 1,
      filterPending: false,
      filterProgress: 1,
      profileId: 'log4j',
      encoding: 'utf8',
      frozen: session.frozen ?? false,
      pendingBytes: 0,
      frozenStale: false,
      sources: (session.sources ?? []).map((s) => ({
        status: { kind: 'live' },
        fileSize: s.size,
        lines: session.lines.filter((l) => l.source === s.index).length,
        lateLines: 0,
      })),
    };
  }

  // Extracted fields (prompt 011), simplified: rules are Rust regexes, `(?i:…)` becomes a case-insensitive JS one.
  const extractRules = new Map();
  const profileOf = (session) => (session.baseColumns ?? session.columns).length > 1 ? 'log4j' : 'python';
  function jsRegex(pattern) {
    const insensitive = pattern.includes('(?i');
    return new RegExp(pattern.replace(/\(\?i:/g, '(?:').replace(/\(\?i\)/g, ''), insensitive ? 'i' : '');
  }
  function firstGroup(regex, text, offset = 0) {
    const m = regex.exec(text);
    if (!m || m[1] === undefined || m[1] === '') return null;
    const start = m.index + m[0].indexOf(m[1]);
    return [offset + start, offset + start + m[1].length];
  }
  function applyRules(session) {
    session.baseColumns ??= session.columns;
    const base = session.baseColumns;
    const rules = extractRules.get(profileOf(session)) ?? [];
    session.columns = [
      ...base,
      ...rules.map((r) => ({ id: r.name, label: r.name, kind: r.kind, unit: r.unit ?? undefined, rule: r.id })),
    ];
    const message = base.findIndex((c) => c.id === 'message');
    for (const line of session.lines) {
      const fields = line.fields.slice(0, base.length);
      const [s, e] = fields[message] ?? [0, 0];
      for (const rule of rules) {
        const span = line.isContinuation ? null : firstGroup(jsRegex(rule.pattern), line.text.slice(s, e), s);
        fields.push(span ?? [0, 0]);
      }
      line.fields = fields;
    }
    session.columnsRevision = (session.columnsRevision ?? 1) + 1;
    session.generation++;
    callbacks.get(session.channel)?.({ message: update(session), index: session.sent++ });
  }
  function suggest(session) {
    const found = new Map();
    const heads = session.lines.filter((l) => !l.isContinuation);
    for (const line of heads) {
      const seen = new Set();
      for (const m of line.text.matchAll(/\b([A-Za-z_]\w*)(=| )(\d+(?:\.\d+)?)(%|ms|s|GB|MB|KB)?(?![\w.:-])/g)) {
        const [, name, sep, , unit] = m;
        if ((sep === ' ' && !unit) || seen.has(name) || /^(id|in|at|port|v)$/i.test(name)) continue;
        seen.add(name);
        const entry = found.get(name) ?? { name, sep, unit, count: 0, examples: [] };
        entry.count++;
        if (entry.examples.length < 3) entry.examples.push(m[0].slice(name.length + 1));
        found.set(name, entry);
      }
    }
    const kindOf = (unit) =>
      unit === '%' ? 'percent' : unit === 'ms' || unit === 's' ? 'duration' : unit ? 'size' : 'number';
    return [...found.values()]
      .filter((f) => f.count / heads.length >= 0.05 && new Set(f.examples).size > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((f) => ({
        rule: {
          id: `s-${f.name.toLowerCase()}`,
          name: f.name,
          column: 'message',
          pattern: `(?i:\\b${f.name})${f.sep === '=' ? '=' : '[ \\t]+'}([-+]?\\d+(?:[.,]\\d+)*${f.unit ? `[ \\t]?(?:${f.unit === '%' ? '%' : f.unit === 'ms' || f.unit === 's' ? 'ms|s' : f.unit})` : ''})`,
          kind: kindOf(f.unit),
          unit: f.unit ?? null,
        },
        examples: f.examples,
        share: f.count / heads.length,
        distinct: new Set(f.examples).size,
      }));
  }

  /** Sort key of a line's time: the first 19 characters with `T` as a space. */
  const timeKey = (text) => text.slice(0, 19).replace('T', ' ');

  /** Entries (head + continuations) of several files mixed by time, stable. */
  function mergeLines(perFile) {
    const entries = [];
    perFile.forEach((lines, source) => {
      let key = '';
      for (const line of lines) {
        if (!line.isContinuation) {
          key = /^\d{4}-\d{2}-\d{2}/.test(line.text) ? timeKey(line.text) : key;
          entries.push({ key, source, seq: entries.length, lines: [] });
        }
        entries.at(-1)?.lines.push({ ...line, source });
      }
    });
    entries.sort((a, b) => a.key.localeCompare(b.key) || a.source - b.source || a.seq - b.seq);
    return entries.flatMap((e) => e.lines).map((line, i) => ({ ...line, line: i }));
  }

  function withMatches(line, search) {
    const matches = [];
    if (search) {
      const lower = line.text.toLowerCase();
      const needle = search.toLowerCase();
      for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
        matches.push([i, i + needle.length]);
      }
    }
    return { ...line, matches };
  }

  // Head line and continuations around a line, from all lines (the detail panel ignores the filter).
  function entryOf(session, line) {
    const lines = session.lines;
    let first = Math.min(line, lines.length - 1);
    while (first > 0 && lines[first].isContinuation) first--;
    let last = first;
    while (last + 1 < lines.length && lines[last + 1].isContinuation) last++;
    const text = lines
      .slice(first, last + 1)
      .map((l) => l.text)
      .join('\n');
    return {
      first,
      last,
      level: lines[first].level,
      lineCount: last - first + 1,
      totalBytes: new TextEncoder().encode(text).length - (last - first),
      text,
      truncated: false,
      source: lines[first].source ?? 0,
      byteOffset: 0,
    };
  }


  // Dashboard (prompt 012): heads with time and `took` in seconds.
  function reportHeads(session) {
    return session.lines
      .filter((l) => !l.isContinuation)
      .map((l) => {
        const iso = l.text.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})/);
        const took = l.text.match(/took (\d+(?:\.\d+)?)(ms|s)\b/);
        return {
          line: l.line + 1,
          ts: iso ? Date.parse(iso[0]) : null,
          level: l.level,
          took: took ? Number(took[1]) / (took[2] === 'ms' ? 1000 : 1) : null,
        };
      });
  }

  function reportSchema(session) {
    const column = (name, sqlType, description, extra = {}) => ({
      name,
      sqlType,
      description,
      column: null,
      kind: null,
      unit: null,
      included: true,
      ...extra,
    });
    const columns = [
      column('line', 'INTEGER', 'Zeilennummer des Eintrags (wie in der Ansicht)'),
      column('ts', 'INTEGER', 'Zeit in ms seit 1970 (UTC), NULL ohne Zeit'),
      column('level', 'TEXT', "Level, z. B. 'ERROR'"),
      column('source', 'INTEGER', 'Quelle (0 bei einer Datei), Namen in sources'),
    ];
    if (reportHeads(session).some((h) => h.took !== null)) {
      columns.push(column('took', 'REAL', 'took', { column: 'took', kind: 'duration' }));
    }
    for (const id of ['thread', 'logger']) {
      if (session.columns.some((c) => c.id === id)) {
        columns.push(column(id, 'TEXT', id, { column: id, kind: 'text', included: false }));
      }
    }
    return { table: 'log', columns, sources: ['app.log'], status: session.report ?? null };
  }

  const PROFILES = [
    { id: 'generic', name: 'Generic (keywords, JSON)', builtin: true, patterns: [] },
    { id: 'log4j', name: 'Log4j / Logback / Spring Boot', builtin: true, patterns: [] },
    { id: 'python', name: 'Python logging', builtin: true, patterns: [] },
  ];

  const handlers = {
    open_log({ path, onUpdate }) {
      const name = path.split('/').pop();
      const id = sessions.size + 1;
      const text = setupData.files[name];
      const columns = SPRING.test(text.slice(0, text.indexOf('\n')))
        ? SPRING_COLUMNS
        : MESSAGE_ONLY;
      const session = {
        id,
        columns,
        lines: classify(text, columns),
        size: setupData.files[name].length,
        generation: 0,
        filter: { levels: LEVELS, search: '', mode: 'filter' },
        channel: onUpdate.id,
        sent: 0,
        views: new Map(),
      };
      sessions.set(id, session);
      return {
        sessionId: id,
        path,
        fileName: name,
        suggestedProfileId: 'log4j',
        update: update(session),
        sources: [],
      };
    },
    open_merged({ sources, onUpdate }) {
      const id = sessions.size + 1;
      const infos = sources.map(({ path }, index) => {
        const name = path.split('/').pop();
        return { index, path, fileName: name, profileId: 'log4j', encoding: 'utf8' };
      });
      const texts = infos.map((info) => setupData.files[info.fileName]);
      const session = {
        id,
        columns: SPRING_COLUMNS,
        lines: mergeLines(texts.map((text) => classify(text, SPRING_COLUMNS))),
        size: texts.reduce((sum, t) => sum + t.length, 0),
        generation: 0,
        filter: { levels: LEVELS, search: '', mode: 'filter' },
        channel: onUpdate.id,
        sent: 0,
        sources: infos.map((info, i) => ({ index: i, size: texts[i].length })),
        views: new Map(),
      };
      sessions.set(id, session);
      return {
        sessionId: id,
        path: '',
        fileName: infos.map((i) => i.fileName).join(' + '),
        suggestedProfileId: 'log4j',
        update: update(session),
        sources: infos,
      };
    },
    inspect_merge_source({ path }) {
      const name = path.split('/').pop();
      const text = setupData.files[name] ?? '';
      const lines = text.split('\n').filter((l) => /^\d{4}-/.test(l));
      const micros = (line) =>
        line ? new Date(timeKey(line).replace(' ', 'T')).getTime() * 1000 : null;
      return {
        path,
        fileName: name,
        suggestedProfileId: name === 'worker.log' ? 'python' : 'log4j',
        encoding: 'utf8',
        firstTime: micros(lines[0]),
        lastTime: micros(lines.at(-1)),
        fileSize: text.length,
      };
    },
    resort: () => null,
    get_lines({ sessionId, start, count, viewId }) {
      const session = target(sessionId, viewId);
      const search = session.filter.search;
      return visible(session)
        .slice(start, start + count)
        .map((line) => withMatches(line, search));
    },
    set_filter({ sessionId, levels, search, mode, expr, viewId }) {
      const session = target(sessionId, viewId);
      session.filter = { levels, search, mode, expr: expr ?? null };
      // The views below follow (prompt 013).
      for (const view of below(session)) {
        view.generation++;
        send(view);
      }
      return { viewGeneration: session.generation, pending: false, filteredLines: 0 };
    },
    open_view({ sessionId, parentViewId, levels, search, mode, expr, onUpdate }) {
      const root = sessions.get(sessionId);
      const view = Object.create(root);
      Object.assign(view, {
        root,
        viewId: (root.nextView = (root.nextView ?? 0) + 1),
        parentView: target(sessionId, parentViewId),
        filter: { levels, search, mode, expr: expr ?? null },
        generation: 0,
        channel: onUpdate.id,
        sent: 0,
      });
      root.views.set(view.viewId, view);
      return { viewId: view.viewId, parentViewId, update: update(view) };
    },
    close_view({ sessionId, viewId }) {
      const root = sessions.get(sessionId);
      const closing = target(sessionId, viewId);
      // Simplified: the children take the closing view's parent and keep its filter on top of their own.
      for (const view of root.views.values()) {
        if (view.parentView === closing) {
          const own = view.filter;
          const above = closing.filter;
          view.parentView = closing.parentView;
          view.filter = {
            ...own,
            levels: own.levels.filter((l) => above.levels.includes(l)),
            expr: above.expr && own.expr ? { kind: 'group', op: 'and', children: [above.expr, own.expr] } : (above.expr ?? own.expr),
          };
        }
      }
      if (viewId) root.views.delete(viewId);
      return null;
    },
    set_frozen({ sessionId, frozen }) {
      const session = sessions.get(sessionId);
      session.frozen = frozen;
      send(session);
      for (const view of session.views.values()) send(view);
      return null;
    },
    find_next({ sessionId, fromLine, query, viewId }) {
      const session = target(sessionId, viewId);
      const all = visible(session);
      const hit = all.findIndex(
        (l) =>
          l.line > (fromLine ?? -1) && l.text.toLowerCase().includes(query.text.toLowerCase()),
      );
      return hit < 0 ? null : { line: all[hit].line, position: hit, wrapped: false };
    },
    get_columns: ({ sessionId }) => {
      const session = sessions.get(sessionId);
      const columns = session.columns;
      return {
        revision: session.columnsRevision ?? 1,
        confidence: (session.baseColumns ?? columns).length > 1 ? 1 : 0,
        profileId: profileOf(session),
        inferredLayout: null,
        columns,
      };
    },
    set_extract_rules({ sessionId, rules }) {
      const session = sessions.get(sessionId);
      extractRules.set(profileOf(session), rules);
      for (const other of sessions.values()) {
        if (profileOf(other) === profileOf(session)) applyRules(other);
      }
      return handlers.get_columns({ sessionId });
    },
    load_extract_rules({ rules }) {
      extractRules.clear();
      for (const [profile, list] of Object.entries(rules ?? {})) extractRules.set(profile, list);
      return null;
    },
    suggest_fields: ({ sessionId }) => suggest(sessions.get(sessionId)),
    preview_extract_rule({ rule, lines }) {
      const regex = jsRegex(rule.pattern);
      const spans = lines.map((line) => firstGroup(regex, line));
      return {
        spans,
        values: spans.map((span, i) => {
          if (!span || rule.kind === 'text') return null;
          const value = Number.parseFloat(lines[i].slice(span[0], span[1]).replace(',', '.'));
          return Number.isFinite(value) ? value : null;
        }),
      };
    },
    preview_fields: ({ line }) => ({
      columns: [{ id: 'message', label: 'Nachricht', kind: 'text' }],
      fields: [[0, line.length]],
      matched: false,
    }),
    get_position: ({ line }) => line,
    get_overview({ sessionId, buckets, lines, viewId }) {
      const session = target(sessionId, viewId);
      const shown = visible(session);
      const out = new Array(buckets).fill(0);
      // Densities FATAL, ERROR, WARN per bucket like the backend with one line per chunk: the share of the
      // bucket's lines, 0–255.
      const covered = new Array(buckets * 3).fill(0);
      const n = shown.length;
      shown.forEach((l, p) => {
        const first = Math.floor((p * buckets) / n);
        const last = Math.max(first + 1, Math.ceil(((p + 1) * buckets) / n));
        const k = ['FATAL', 'ERROR', 'WARN'].indexOf(l.level);
        for (let b = first; b < Math.min(last, buckets); b++) {
          out[b] |= 1 << LEVELS.indexOf(l.level);
          if (k < 0) continue;
          const overlap = Math.min((p + 1) * buckets, (b + 1) * n) - Math.max(p * buckets, b * n);
          covered[b * 3 + k] += Math.max(0, overlap);
        }
      });
      const density = covered.map((c) => (n ? Math.min(255, Math.ceil((c * 255) / n)) : 0));
      const marks = lines.map((line) => {
        const position = Math.max(0, shown.findIndex((l) => l.line >= line));
        return { line, position, visible: shown[position]?.line === line };
      });
      return {
        viewGeneration: session.generation,
        epoch: 0,
        count: shown.length,
        buckets: out,
        density,
        marks,
      };
    },
    find_level({ sessionId, fromPosition, forward, levels, viewId }) {
      const shown = visible(target(sessionId, viewId));
      const heads = shown
        .map((l, position) => ({ l, position }))
        .filter(({ l }) => !l.isContinuation && levels.includes(l.level));
      const from = fromPosition ?? (forward ? -1 : shown.length);
      const hit = forward
        ? heads.find((h) => h.position > from)
        : heads.findLast((h) => h.position < from);
      return hit ? { line: hit.l.line, position: hit.position, wrapped: false } : null;
    },
    get_entry_range: ({ sessionId, line }) => {
      const { first, last } = entryOf(sessions.get(sessionId), line);
      return { first, last };
    },
    get_entry: ({ sessionId, line }) => entryOf(sessions.get(sessionId), line),
    copy_lines: ({ sessionId, first, last }) =>
      sessions
        .get(sessionId)
        .lines.slice(first, last + 1)
        .map((l) => `${l.text}\n`)
        .join(''),
    // Dashboard (prompt 012), enough for the screenshot: the templates' SQL recognised by pattern, over the
    // entry heads of the mock session (time from the ISO prefix, `took` from the message).
    open_report({ sessionId }) {
      const session = sessions.get(sessionId);
      session.report = { state: 'ready', progress: 1, rows: 0, lines: session.lines.length, generation: 1, reason: null, message: null, lowSpace: false, size: 0 };
      session.report.rows = reportHeads(session).length;
      session.report.size = session.report.rows * 44;
      callbacks.get(session.channel)?.({ message: update(session), index: session.sent++ });
      return reportSchema(session);
    },
    close_report: () => null,
    get_report_schema: ({ sessionId }) => reportSchema(sessions.get(sessionId)),
    run_report({ sessionId, sql }) {
      const heads = reportHeads(sessions.get(sessionId));
      const minute = (ts) => Math.floor(ts / 60000) * 60000;
      const timed = heads.filter((h) => h.ts !== null);
      const groups = (key) => {
        const map = new Map();
        for (const h of timed) {
          const k = key(h);
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(h);
        }
        return [...map.entries()];
      };
      const result = (columns, rows) => ({ columns, rows, truncated: false, elapsedMs: 3 });
      const range = sql.match(/ts >= (\d+) AND ts < (\d+)/);
      if (range) {
        const inRange = timed.filter((h) => h.ts >= Number(range[1]) && h.ts < Number(range[2]));
        return result(['line'], [[inRange.length ? Math.min(...inRange.map((h) => h.line)) : null]]);
      }
      if (/GROUP BY t, level/.test(sql)) {
        return result(
          ['t', 'level', 'n'],
          groups((h) => `${minute(h.ts)}|${h.level}`).map(([k, list]) => {
            const [t, level] = k.split('|');
            return [Number(t), level, list.length];
          }),
        );
      }
      if (/fehlerrate/.test(sql)) {
        return result(
          ['t', 'fehlerrate'],
          groups((h) => minute(h.ts)).map(([t, list]) => [
            t,
            Math.round((10000 * list.filter((h) => h.level === 'ERROR' || h.level === 'FATAL').length) / list.length) / 100,
          ]),
        );
      }
      if (/avg\("?took"?\)/.test(sql)) {
        return result(
          ['t', 'mittel', 'maximum'],
          groups((h) => minute(h.ts))
            .map(([t, list]) => [t, list.map((h) => h.took).filter((v) => v !== null)])
            .filter(([, values]) => values.length)
            .map(([t, values]) => [t, values.reduce((a, b) => a + b, 0) / values.length, Math.max(...values)]),
        );
      }
      if (/GROUP BY level/.test(sql)) {
        const counts = {};
        for (const h of heads) counts[h.level] = (counts[h.level] ?? 0) + 1;
        return result(['level', 'n'], Object.entries(counts).sort((a, b) => b[1] - a[1]));
      }
      if (/LIMIT 100/.test(sql)) {
        const pad = (n) => String(n).padStart(2, '0');
        const local = (ts) => {
          const d = new Date(ts);
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        };
        return result(
          ['line', 'zeit', 'level'],
          heads
            .filter((h) => h.level === 'ERROR' || h.level === 'FATAL')
            .reverse()
            .slice(0, 100)
            .map((h) => [h.line, h.ts === null ? null : local(h.ts), h.level]),
        );
      }
      return result(['t', 'n'], groups((h) => minute(h.ts)).map(([t, list]) => [t, list.length]));
    },
    list_profiles: () => PROFILES,
    set_custom_profiles: () => null,
    'plugin:store|load': () => 1,
    'plugin:store|get_store': () => 1,
    'plugin:store|get': ({ key }) =>
      key === 'dashboards'
        ? [setupData.dashboards ?? null, setupData.dashboards !== undefined]
        : [{ recentFiles: setupData.recent, ...(setupData.settings ?? {}) }, true],
    'plugin:store|set': () => null,
    'plugin:store|save': () => null,
    'plugin:cli|cli_matches': () => ({
      args: {
        file: {
          value: Object.keys(setupData.files).map((name) => `/var/log/shop/${name}`),
          occurrences: 1,
        },
      },
      subcommand: null,
    }),
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    'plugin:window|set_title': () => null,
  };

  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(callback) {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    async invoke(command, args) {
      const handler = handlers[command];
      if (!handler) throw new Error(`mock: no handler for ${command}`);
      return handler(args ?? {});
    },
  };
  window.__mock = {
    setup(data) {
      setupData = data;
    },
  };
})();
