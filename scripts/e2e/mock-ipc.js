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
  // Received syslog (prompt 016): time of receipt, sender, RFC 3164 behind the priority.
  const RECEIVED =
    /^(?<timestamp>\S+) (?<sender>\S+) <(?<pri>\d+)>(?<sent>[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d) (?<host>\S+) (?<logger>[^\s:[]+)(?:\[(?<pid>\d+)\])?: ?(?<message>.*)$/d;
  const RECEIVED_COLUMNS = [
    { id: 'timestamp', label: 'Zeit', kind: 'timestamp' },
    { id: 'sender', label: 'Absender', kind: 'text' },
    { id: 'pri', label: 'pri', kind: 'number' },
    { id: 'sent', label: 'Gesendet', kind: 'text' },
    { id: 'host', label: 'host', kind: 'text' },
    { id: 'logger', label: 'Logger', kind: 'text' },
    { id: 'message', label: 'Nachricht', kind: 'text' },
  ];
  const SEVERITY = ['FATAL', 'FATAL', 'FATAL', 'ERROR', 'WARN', 'INFO', 'INFO', 'DEBUG'];

  // Windows events (prompt 018), MOCK ONLY: the real source exists only on Windows. These lines imitate what
  // sources/winevent/line.rs writes, so that the dialog and the tab can be photographed on macOS. Enabled with
  // `setup({ windows: true })`; without it `winevent_supported` is false as on macOS and Linux.
  const WINEVENT_KEYS = ['timestamp', 'level', 'provider', 'eventId', 'message', 'channel', 'computer', 'task', 'user', 'recordId'];
  const WINEVENT_LABELS = {
    timestamp: 'Zeit',
    level: 'Level',
    provider: 'Provider',
    eventId: 'Event-ID',
    message: 'Nachricht',
    channel: 'Kanal',
    computer: 'Computer',
    task: 'Aufgabe',
    user: 'Benutzer',
    recordId: 'Datensatz',
  };
  const WINEVENT_COLUMNS = WINEVENT_KEYS.map((id) => ({
    id,
    label: WINEVENT_LABELS[id],
    kind: id === 'timestamp' ? 'timestamp' : id === 'level' ? 'level' : id === 'eventId' || id === 'recordId' ? 'number' : 'text',
  }));
  const WINEVENT_SAMPLES = [
    ['info', 'Service Control Manager', 7036, 'Der Dienst „Windows Update“ befindet sich jetzt im Status „Ausgeführt“.', 'System', 'None', 'SYSTEM'],
    ['info', 'Microsoft-Windows-Security-Auditing', 4624, 'Ein Konto wurde erfolgreich angemeldet. Antragsteller: WS01$ Anmeldetyp: 5', 'Security', 'Logon', 'SYSTEM'],
    ['warn', 'Microsoft-Windows-Time-Service', 129, 'NtpClient konnte keine Domänenpeers als Zeitquelle festlegen. Neuer Versuch in 15 Minuten.', 'System', 'None', 'LOCAL SERVICE'],
    ['error', 'Application Error', 1000, 'Name der fehlerhaften Anwendung: backup-agent.exe, Version: 4.2.1.0, Ausnahmecode: 0xc0000005', 'Application', '100', ''],
    ['error', 'Microsoft-Windows-Security-Auditing', 4625, 'Fehler beim Anmelden eines Kontos. Kontoname: admin Fehlerursache: Unbekannter Benutzername oder falsches Kennwort.', 'Security', 'Logon', 'SYSTEM'],
    ['info', 'MsiInstaller', 11707, 'Produkt: Log Commander -- Installation erfolgreich abgeschlossen.', 'Application', 'None', 'S-1-5-21-3623811015-3361044348-30300820-1013'],
    ['fatal', 'Microsoft-Windows-Kernel-Power', 41, 'Das System wurde neu gestartet, ohne dass es zuvor ordnungsgemäß heruntergefahren wurde.', 'System', '63', 'SYSTEM'],
    ['warn', 'Microsoft-Windows-DNS-Client', 1014, 'Timeout bei der Namensauflösung für den Namen updates.example.com, nachdem keiner der konfigurierten DNS-Server geantwortet hat.', 'System', '1014', 'NETWORK SERVICE'],
    ['debug', 'Microsoft-Windows-PowerShell', 4104, 'Remotebefehl wird erstellt: Get-WinEvent -LogName Application -MaxEvents 10', 'Microsoft-Windows-PowerShell/Operational', 'Ausführen eines Remotebefehls', 'S-1-5-21-3623811015-3361044348-30300820-1013'],
  ];
  const WINEVENT_LEVEL = { fatal: 'FATAL', error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' };

  // Databases (prompt 019), mock for the screenshots: rows of a log table as the JSON lines that
  // sources/database/value.rs writes (time and level renamed, then the other columns).
  const DB_KEYS = ['timestamp', 'level', 'id', 'logger', 'msg', 'user_id'];
  const DB_COLUMNS = DB_KEYS.map((id) => ({
    id,
    label: id,
    kind: id === 'timestamp' ? 'timestamp' : id === 'level' ? 'level' : id === 'id' || id === 'user_id' ? 'number' : 'text',
  }));
  const DB_SAMPLES = [
    ['INFO', 'app.orders', 'Bestellung 48211 angelegt (3 Positionen)', 1042],
    ['INFO', 'app.auth', 'Anmeldung erfolgreich', 1042],
    ['WARN', 'app.payment', 'Zahlungsanbieter antwortet langsam: 2.4 s', null],
    ['ERROR', 'app.payment', 'Zahlung 48211 abgelehnt: Karte abgelaufen', 1042],
    ['DEBUG', 'app.cache', 'Cache-Treffer für Produktliste (812 Einträge)', null],
    ['INFO', 'app.mail', 'Versandbestätigung an kunde@example.com gesendet', 2077],
    ['ERROR', 'app.db', 'Deadlock beim Buchen erkannt, Wiederholung 1 von 3', null],
    ['INFO', 'app.orders', 'Bestellung 48212 angelegt (1 Position)', 2077],
  ];

  function dbLines(count = 140) {
    const lines = [];
    const start = Date.UTC(2026, 10, 8, 8, 0, 0);
    for (let i = 0; i < count; i++) {
      const [level, logger, msg, user] = DB_SAMPLES[(i * 5 + (i >> 3)) % DB_SAMPLES.length];
      const values = {
        timestamp: new Date(start + i * 7_310).toISOString().replace('Z', '+00:00'),
        level,
        id: 73_400 + i,
        logger,
        msg,
        user_id: user,
      };
      let text = '{';
      const fields = [];
      DB_KEYS.forEach((key, k) => {
        text += `${k ? ',' : ''}"${key}":`;
        const value = values[key];
        const raw = typeof value === 'number' || value === null ? String(value) : JSON.stringify(value);
        const quoted = typeof value === 'string';
        const from = text.length + (quoted ? 1 : 0);
        text += raw;
        fields.push([from, text.length - (quoted ? 1 : 0)]);
      });
      text += '}';
      lines.push({ line: i, level, source: 0, text, isContinuation: false, truncated: false, matches: [], fields });
    }
    return lines;
  }

  function dbLabel(config) {
    const m = /\bfrom\s+([\w."`[\]]+)/i.exec(config.query);
    return m ? `db:${m[1].replace(/["`[\]]/g, '')}` : `db:${config.database || config.host}`;
  }

  function wineventLines(channel) {
    const lines = [];
    const start = Date.UTC(2026, 10, 8, 7, 30, 0);
    for (let i = 0; i < 160; i++) {
      const [level, provider, eventId, message, own, task, user] = WINEVENT_SAMPLES[(i * 7 + (i >> 2)) % WINEVENT_SAMPLES.length];
      const values = {
        timestamp: new Date(start + i * 23_417).toISOString().replace('Z', '+00:00'),
        level,
        provider,
        eventId,
        message,
        channel: channel === 'Application' ? own : channel,
        computer: 'WS01.corp.example',
        task,
        user,
        recordId: 884_200 + i,
      };
      let text = '{';
      const fields = [];
      WINEVENT_KEYS.forEach((key, k) => {
        text += `${k ? ',' : ''}"${key}":`;
        const value = values[key];
        const raw = typeof value === 'number' ? String(value) : JSON.stringify(value);
        const quoted = typeof value !== 'number';
        const from = text.length + (quoted ? 1 : 0);
        text += raw;
        fields.push([from, text.length - (quoted ? 1 : 0)]);
      });
      text += '}';
      lines.push({
        line: i,
        level: WINEVENT_LEVEL[level],
        source: 0,
        text,
        isContinuation: false,
        truncated: false,
        matches: [],
        fields,
      });
    }
    return lines;
  }

  function fieldsOf(line, columns, isContinuation) {
    const whole = columns.map((c) => (c.id === 'message' ? [0, line.length] : [0, 0]));
    if (columns.length === 1 || isContinuation) return whole;
    if (columns === RECEIVED_COLUMNS) {
      const match = line.match(RECEIVED);
      if (!match) return whole;
      return columns.map((c) => match.indices.groups[c.id] ?? [0, 0]);
    }
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
      else if (c.type === 'lines')
        value = line.line >= (c.first ?? 0) && line.line <= (c.last ?? Infinity);
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
    for (const v of root.views.values())
      if (out.includes(v.parentView) && !out.includes(v)) out.push(v);
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
      profileId: session.profileId ?? 'log4j',
      encoding: 'utf8',
      frozen: session.frozen ?? false,
      pendingBytes: 0,
      frozenStale: false,
      sourceStatus: session.sourceStatus ?? null,
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
  const profileOf = (session) =>
    session.profileId ?? ((session.baseColumns ?? session.columns).length > 1 ? 'log4j' : 'python');
  function jsRegex(pattern) {
    const insensitive = pattern.includes('(?i');
    return new RegExp(
      pattern.replace(/\(\?i:/g, '(?:').replace(/\(\?i\)/g, ''),
      insensitive ? 'i' : '',
    );
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
      ...rules.map((r) => ({
        id: r.name,
        label: r.name,
        kind: r.kind,
        unit: r.unit ?? undefined,
        rule: r.id,
      })),
    ];
    const message = base.findIndex((c) => c.id === 'message');
    for (const line of session.lines) {
      const fields = line.fields.slice(0, base.length);
      const [s, e] = fields[message] ?? [0, 0];
      for (const rule of rules) {
        const span = line.isContinuation
          ? null
          : firstGroup(jsRegex(rule.pattern), line.text.slice(s, e), s);
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
      for (const m of line.text.matchAll(
        /\b([A-Za-z_]\w*)(=| )(\d+(?:\.\d+)?)(%|ms|s|GB|MB|KB)?(?![\w.:-])/g,
      )) {
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
      unit === '%'
        ? 'percent'
        : unit === 'ms' || unit === 's'
          ? 'duration'
          : unit
            ? 'size'
            : 'number';
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
    { id: 'syslog-received', name: 'Syslog (empfangen)', builtin: true, patterns: [] },
    { id: 'winevent', name: 'Windows-Ereignisse', builtin: true, patterns: [] },
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
    open_source({ config, keep, onUpdate, credentials }) {
      const id = sessions.size + 1;
      if (config.kind === 'winevent') {
        if (!setupData.windows) throw { code: 'unsupported', message: 'Windows-Ereignisprotokolle gibt es nur unter Windows' };
        const label = config.computer ? `Ereignisse ${config.computer}: ${config.channel}` : `Ereignisse: ${config.channel}`;
        const lines = wineventLines(config.channel);
        const session = {
          id,
          columns: WINEVENT_COLUMNS,
          lines,
          size: lines.reduce((sum, l) => sum + l.text.length + 1, 0),
          generation: 0,
          filter: { levels: LEVELS, search: '', mode: 'filter' },
          channel: onUpdate.id,
          sent: 0,
          views: new Map(),
          profileId: 'winevent',
          sourceStatus: {
            state: { kind: 'listening' },
            received: lines.length,
            dropped: 0,
            truncated: 0,
            rejected: 0,
            connections: 0,
            spooled: lines.length,
            spoolError: null,
            bytes: 0,
            latencyMs: null,
            pendingBytes: 0,
            gaps: 0,
          },
        };
        sessions.set(id, session);
        const spoolPath = `C:\\Users\\me\\AppData\\Local\\io.github.krocon.logcommander\\spool\\4711\\source-${id}\\spool.log`;
        return {
          sessionId: id,
          path: spoolPath,
          fileName: label,
          suggestedProfileId: 'winevent',
          update: update(session),
          sources: [],
          source: { kind: 'winevent', label, spoolPath, keep: !!keep, config },
        };
      }
      if (config.kind === 'database') {
        const label = dbLabel(config);
        const lines = dbLines();
        const session = {
          id,
          columns: DB_COLUMNS,
          lines,
          size: lines.reduce((sum, l) => sum + l.text.length + 1, 0),
          generation: 0,
          filter: { levels: LEVELS, search: '', mode: 'filter' },
          channel: onUpdate.id,
          sent: 0,
          views: new Map(),
          profileId: 'jsonl',
          sourceStatus: {
            state: { kind: 'connected' },
            received: lines.length,
            dropped: 0,
            truncated: 0,
            rejected: 0,
            connections: 0,
            spooled: lines.length,
            spoolError: null,
            bytes: 0,
            latencyMs: 14,
            pendingBytes: 0,
            gaps: 0,
            polledAtMs: Date.UTC(2026, 10, 8, 8, 17, 4),
          },
        };
        sessions.set(id, session);
        const spoolPath = `/Users/me/Library/Caches/io.github.krocon.logcommander/spool/4711/source-${id}/spool.log`;
        return {
          sessionId: id,
          path: spoolPath,
          fileName: label,
          suggestedProfileId: 'jsonl',
          update: update(session),
          sources: [],
          source: { kind: 'database', label, spoolPath, keep: !!keep, config },
        };
      }
      if (config.kind === 'sftp') {
        // Prompt 017: the first connect shows the host-key confirmation, the next one opens.
        if (!credentials?.trustFingerprint && setupData.remoteTrust !== true) {
          throw {
            code: 'host_key_unknown',
            message: 'unknown host key',
            remote: {
              keyType: 'ssh-ed25519',
              fingerprint: 'SHA256:q3m8V0kD5mZ0x7Q2b9sYwq1n2Lr6s4cJ0g8hX2Yf3aE',
              wrong: false,
            },
          };
        }
        const name = config.path.split('/').pop();
        const text = setupData.remoteFiles?.[name] ?? setupData.files[name] ?? '';
        const label = `${config.host}:${config.path}`;
        const session = {
          id,
          columns: SPRING_COLUMNS,
          lines: classify(text, SPRING_COLUMNS),
          size: text.length,
          generation: 0,
          filter: { levels: LEVELS, search: '', mode: 'filter' },
          channel: onUpdate.id,
          sent: 0,
          views: new Map(),
          sourceStatus: {
            state: { kind: 'connected' },
            received: 48213,
            dropped: 0,
            truncated: 0,
            rejected: 0,
            connections: 0,
            spooled: 48213,
            spoolError: null,
            bytes: 9_437_184,
            latencyMs: 23,
            pendingBytes: 0,
          },
        };
        sessions.set(id, session);
        const spoolPath = `/Users/me/Library/Caches/io.github.krocon.logcommander/spool/4711/source-${id}/spool.log`;
        return {
          sessionId: id,
          path: spoolPath,
          fileName: label,
          suggestedProfileId: 'log4j',
          update: update(session),
          sources: [],
          source: { kind: 'sftp', label, spoolPath, keep: !!keep, config },
        };
      }
      const text = setupData.spool ?? '';
      const lines = classify(text, RECEIVED_COLUMNS).map((line) => {
        const pri = line.text.match(/^\S+ \S+ <(\d+)>/);
        return pri
          ? {
              ...line,
              level: SEVERITY[Number(pri[1]) % 8],
              isContinuation: false,
              fields: fieldsOf(line.text, RECEIVED_COLUMNS, false),
            }
          : line;
      });
      const label = `Syslog${config.protocol === 'tcp' ? ' TCP' : config.protocol === 'both' ? ' UDP+TCP' : ''} :${config.port}`;
      const session = {
        id,
        columns: RECEIVED_COLUMNS,
        lines,
        size: text.length,
        generation: 0,
        filter: { levels: LEVELS, search: '', mode: 'filter' },
        channel: onUpdate.id,
        sent: 0,
        views: new Map(),
        profileId: 'syslog-received',
        sourceStatus: {
          state: { kind: 'listening' },
          received: 12873,
          dropped: 0,
          truncated: 2,
          rejected: 0,
          connections: 0,
          spooled: 12873,
          spoolError: null,
          bytes: 0,
          latencyMs: null,
          pendingBytes: 0,
        },
      };
      sessions.set(id, session);
      const spoolPath = `/Users/me/Library/Caches/io.github.krocon.logcommander/spool/4711/source-${id}/spool.log`;
      return {
        sessionId: id,
        path: spoolPath,
        fileName: label,
        suggestedProfileId: 'syslog-received',
        update: update(session),
        sources: [],
        source: { kind: 'syslog', label, spoolPath, keep: !!keep, config },
      };
    },
    remote_hosts: () => [
      { alias: 'web-prod', hostName: '10.20.0.5', user: 'deploy', port: 22, identityFiles: [], proxy: false },
      { alias: 'db', hostName: 'db.internal', user: null, port: 2222, identityFiles: [], proxy: false },
    ],
    remote_list_dir: ({ path }) => ({
      path: path || '/var/log',
      entries: [
        { name: 'nginx', dir: true, size: null, modifiedMs: null },
        { name: 'app.log', dir: false, size: 9_437_184, modifiedMs: Date.UTC(2026, 0, 15, 10) },
        { name: 'app.log.1', dir: false, size: 52_428_800, modifiedMs: Date.UTC(2026, 0, 14, 23) },
        { name: 'syslog', dir: false, size: 1_048_576, modifiedMs: Date.UTC(2026, 0, 15, 10) },
      ],
      truncated: false,
    }),
    forget_remote_secret: () => null,
    // Prompt 018 (mock only, see WINEVENT_KEYS).
    winevent_supported: () => setupData.windows === true,
    winevent_channels: () => {
      if (!setupData.windows) throw { code: 'unsupported', message: 'Windows-Ereignisprotokolle gibt es nur unter Windows' };
      return [
        'Application',
        'System',
        'Security',
        'Setup',
        'ForwardedEvents',
        'HardwareEvents',
        'Microsoft-Windows-PowerShell/Operational',
        'Microsoft-Windows-TaskScheduler/Operational',
        'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational',
        'Microsoft-Windows-Windows Defender/Operational',
        'Windows PowerShell',
      ];
    },
    forget_winevent_secret: () => null,
    db_tables: () => [
      { schema: 'app', name: 'audit_log' },
      { schema: 'app', name: 'logs' },
      { schema: 'app', name: 'orders' },
    ],
    db_preview: ({ config }) => ({
      columns: [
        { name: 'id', typeName: 'INT8', kind: 'int' },
        { name: 'created_at', typeName: 'TIMESTAMPTZ', kind: 'timestampTz' },
        { name: 'level', typeName: 'TEXT', kind: 'text' },
        { name: 'logger', typeName: 'TEXT', kind: 'text' },
        { name: 'msg', typeName: 'TEXT', kind: 'text' },
        { name: 'user_id', typeName: 'INT4', kind: 'int' },
      ],
      lines: dbLines(20).map((l) => l.text),
      keyType: config.keyColumn === 'created_at' ? 'TIMESTAMPTZ' : 'INT8',
    }),
    forget_db_secret: () => null,
    set_spool_keep: () => null,
    set_spool_limit: () => null,
    kept_spools: () => ({ count: 1, bytes: 3_145_728 }),
    delete_kept_spools: () => 1,
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
            expr:
              above.expr && own.expr
                ? { kind: 'group', op: 'and', children: [above.expr, own.expr] }
                : (above.expr ?? own.expr),
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
        (l) => l.line > (fromLine ?? -1) && l.text.toLowerCase().includes(query.text.toLowerCase()),
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
        const position = Math.max(
          0,
          shown.findIndex((l) => l.line >= line),
        );
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
    // Timeline (prompt 014): exact over the heads with an ISO time (the backend spreads chunks evenly).
    get_timeline({ sessionId, from, to, buckets }) {
      const session = sessions.get(sessionId);
      const heads = reportHeads(session).map((h) => ({
        ...h,
        us: h.ts === null ? null : h.ts * 1000,
      }));
      const timed = heads.filter((h) => h.us !== null);
      const base = {
        epoch: 0,
        totalLines: session.lines.length,
        entries: heads.length,
        hasTimes: timed.length > 0,
        buckets: [],
        gaps: [],
        min: null,
        max: null,
        before: 0,
        after: 0,
        untimed: heads.length - timed.length,
        anchors: [],
        from: 0,
        to: 0,
      };
      if (!timed.length) return base;
      const times = timed.map((h) => h.us);
      const min = Math.min(...times);
      const max = Math.max(...times);
      const lo = from ?? min;
      const hi = to ?? (max > min ? max : min + 60_000_000);
      const width = (hi - lo) / buckets;
      const out = Array.from({ length: buckets }, () => ({ all: 0, warn: 0, error: 0, fatal: 0 }));
      let before = 0;
      let after = 0;
      for (const h of timed) {
        if (h.us < lo) before++;
        else if (h.us > hi) after++;
        else {
          const b = out[Math.min(buckets - 1, Math.floor((h.us - lo) / width))];
          b.all++;
          if (h.level === 'WARN') b.warn++;
          if (h.level === 'ERROR') b.error++;
          if (h.level === 'FATAL') b.fatal++;
        }
      }
      const sorted = [...times].sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        const [a, b] = [Math.max(sorted[i - 1], lo), Math.min(sorted[i], hi)];
        if (b - a >= width) gaps.push({ from: a, to: b });
      }
      const step = Math.max(1, Math.ceil(timed.length / 1024));
      const anchors = timed
        .filter((_, i) => i % step === 0)
        .map((h) => ({ line: h.line - 1, ts: h.us }));
      return { ...base, from: lo, to: hi, buckets: out, gaps, min, max, before, after, anchors };
    },
    position_at_time({ sessionId, ts, viewId }) {
      const session = target(sessionId, viewId);
      const shown = visible(session);
      const head = reportHeads(sessions.get(sessionId)).find(
        (h) => h.ts !== null && h.ts * 1000 >= ts,
      );
      if (!head || !shown.length) return null;
      const position = Math.max(
        0,
        shown.findIndex((l) => l.line >= head.line - 1),
      );
      return { line: shown[position].line, position, exact: true };
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
      session.report = {
        state: 'ready',
        progress: 1,
        rows: 0,
        lines: session.lines.length,
        generation: 1,
        reason: null,
        message: null,
        lowSpace: false,
        size: 0,
      };
      session.report.rows = reportHeads(session).length;
      session.report.size = session.report.rows * 44;
      callbacks.get(session.channel)?.({ message: update(session), index: session.sent++ });
      return reportSchema(session);
    },
    close_report: () => null,
    get_report_schema: ({ sessionId }) => reportSchema(sessions.get(sessionId)),
    // Prompt 015: export, anchors and workspaces. The screenshots only open dialogs; nothing is written.
    export_view: () => 1,
    cancel_export: () => true,
    line_anchors: ({ lines }) =>
      lines.map((line) => ({
        line,
        source: 0,
        offset: line * 100,
        len: 99,
        hash: '0000000000000000',
      })),
    resolve_anchors: ({ anchors }) => anchors.map((a) => a.line),
    read_workspace: () => {
      throw { code: 'not_found', message: 'no files in the screenshot mock' };
    },
    write_workspace: () => null,
    probe_paths: ({ paths }) => paths.map((path) => ({ path, exists: true })),
    scripted_dialogs: () => false,
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
        return result(
          ['line'],
          [[inRange.length ? Math.min(...inRange.map((h) => h.line)) : null]],
        );
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
            Math.round(
              (10000 * list.filter((h) => h.level === 'ERROR' || h.level === 'FATAL').length) /
                list.length,
            ) / 100,
          ]),
        );
      }
      if (/avg\("?took"?\)/.test(sql)) {
        return result(
          ['t', 'mittel', 'maximum'],
          groups((h) => minute(h.ts))
            .map(([t, list]) => [t, list.map((h) => h.took).filter((v) => v !== null)])
            .filter(([, values]) => values.length)
            .map(([t, values]) => [
              t,
              values.reduce((a, b) => a + b, 0) / values.length,
              Math.max(...values),
            ]),
        );
      }
      if (/GROUP BY level/.test(sql)) {
        const counts = {};
        for (const h of heads) counts[h.level] = (counts[h.level] ?? 0) + 1;
        return result(
          ['level', 'n'],
          Object.entries(counts).sort((a, b) => b[1] - a[1]),
        );
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
      return result(
        ['t', 'n'],
        groups((h) => minute(h.ts)).map(([t, list]) => [t, list.length]),
      );
    },
    list_profiles: () => PROFILES.filter((p) => p.id !== 'winevent' || setupData.windows === true),
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
    // Prompt 020: the native window frame.
    set_window_chrome: () => null,
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
