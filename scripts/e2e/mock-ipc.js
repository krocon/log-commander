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
          text: line,
          isContinuation,
          truncated: false,
          matches: [],
          fields: fieldsOf(line, columns, isContinuation),
        };
      });
  }

  function visible(session) {
    const { levels, search, mode } = session.filter;
    return session.lines.filter(
      (l) =>
        levels.includes(l.level) &&
        (mode !== 'filter' || !search || l.text.toLowerCase().includes(search.toLowerCase())),
    );
  }

  function update(session) {
    const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
    for (const line of session.lines) counts[line.level]++;
    return {
      totalLines: session.lines.length,
      filteredLines: visible(session).length,
      counts,
      status: { kind: 'live' },
      fileSize: session.size,
      epoch: 0,
      viewGeneration: session.generation,
      columnsRevision: 1,
      filterPending: false,
      filterProgress: 1,
      profileId: 'log4j',
      encoding: 'utf8',
      frozen: session.frozen ?? false,
      pendingBytes: 0,
      frozenStale: false,
    };
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
    };
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
      };
      sessions.set(id, session);
      return {
        sessionId: id,
        path,
        fileName: name,
        suggestedProfileId: 'log4j',
        update: update(session),
      };
    },
    get_lines({ sessionId, start, count }) {
      const session = sessions.get(sessionId);
      const search = session.filter.search;
      return visible(session)
        .slice(start, start + count)
        .map((line) => withMatches(line, search));
    },
    set_filter({ sessionId, levels, search, mode }) {
      const session = sessions.get(sessionId);
      session.filter = { levels, search, mode };
      session.generation++;
      callbacks.get(session.channel)?.({ message: update(session), index: session.sent++ });
      return { viewGeneration: session.generation, pending: false, filteredLines: 0 };
    },
    set_frozen({ sessionId, frozen }) {
      const session = sessions.get(sessionId);
      session.frozen = frozen;
      callbacks.get(session.channel)?.({ message: update(session), index: session.sent++ });
      return null;
    },
    find_next({ sessionId, fromLine, query }) {
      const session = sessions.get(sessionId);
      const all = visible(session);
      const hit = all.findIndex(
        (l) =>
          l.line > (fromLine ?? -1) && l.text.toLowerCase().includes(query.text.toLowerCase()),
      );
      return hit < 0 ? null : { line: all[hit].line, position: hit, wrapped: false };
    },
    get_columns: ({ sessionId }) => {
      const columns = sessions.get(sessionId).columns;
      return {
        revision: 1,
        confidence: columns.length > 1 ? 1 : 0,
        profileId: columns.length > 1 ? 'log4j' : 'python',
        inferredLayout: null,
        columns,
      };
    },
    preview_fields: ({ line }) => ({
      columns: [{ id: 'message', label: 'Nachricht', kind: 'text' }],
      fields: [[0, line.length]],
      matched: false,
    }),
    get_position: ({ line }) => line,
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
    list_profiles: () => PROFILES,
    set_custom_profiles: () => null,
    'plugin:store|load': () => 1,
    'plugin:store|get_store': () => 1,
    'plugin:store|get': () => [
      { recentFiles: setupData.recent, ...(setupData.settings ?? {}) },
      true,
    ],
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
