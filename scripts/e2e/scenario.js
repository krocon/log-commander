// Runs inside the real webview of a debug build (see src-tauri/src/e2e.rs). It operates the UI like
// a user and asks the harness (scripts/e2e/run.mjs) to change the log file through `act()`.
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const report = (message) => invoke('e2e_report', { message });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const act = (action) => report(`ACTION ${action}`);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  async function waitFor(what, condition, timeoutMs = 15000) {
    const start = Date.now();
    for (;;) {
      let value;
      try {
        value = condition();
      } catch {
        value = false;
      }
      if (value) {
        await report(`PASS ${what}`);
        return value;
      }
      if (Date.now() - start > timeoutMs) {
        const state = document.body.innerText.slice(0, 1500).replace(/\n/g, ' | ');
        await report(`visibility=${document.visibilityState}`);
        const bar = document.querySelector('app-status-bar')?.innerText.replace(/\n/g, ' | ');
        throw new Error(`timeout: ${what} STATUS: ${bar} UI: ${state}`);
      }
      await sleep(30);
    }
  }

  // The table: one text cell (`.lt-cell`) and one gutter cell (`.lt-gutter`) per row, both with the row's classes and
  // `data-line`. The table may keep cells outside the view, so rows are the visible text cells from the top.
  const view = () => $('app-log-table-view');
  const scroller = () => $('app-log-table-view .ge-table-scroll-viewport');
  const inView = (cells) => {
    const box = view().getBoundingClientRect();
    return cells
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0 && r.bottom > box.top + 1 && r.top < box.bottom - 1)
      .sort((a, b) => a.r.top - b.r.top)
      .map(({ c }) => c);
  };
  const rows = () => inView($$('app-log-table-view .lt-cell'));
  const topLine = () => Number(rows()[0]?.dataset.line);
  const rowTexts = () => rows().map((e) => e.textContent);
  const status = () => $('app-status-bar').innerText;
  const chip = (level) => $(`.chip-${level}`);
  const count = (level) => Number(chip(level).querySelector('.count').textContent.replace(/\D/g, ''));
  const click = (el, options = {}) =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...options }));
  const search = (text) => {
    const input = $('input[type=search]');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (text) => $$('button').find((b) => b.textContent.trim().startsWith(text));
  const wheel = (deltaY) =>
    scroller().dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
  const press = (key, options = {}) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));

  // Live tail: a row must never be drawn before its text is there, that is what flickers. An observer,
  // not requestAnimationFrame, because a window in the background gets no frames. A page requested
  // alongside shows how long a round trip takes while the file grows.
  const watchTail = () => {
    const durations = [];
    let probing = true;
    (async () => {
      while (probing) {
        const start = performance.now();
        await invoke('get_lines', { sessionId: 1, view: 'filtered', start: 0, count: 200 }).catch(() => {});
        durations.push(performance.now() - start);
        await sleep(100);
      }
    })();
    let changes = 0;
    let withPlaceholder = 0;
    const observer = new MutationObserver(() => {
      changes++;
      if ($('.lt-cell.loading')) withPlaceholder++;
    });
    observer.observe(view(), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    return {
      async check(name) {
        observer.disconnect();
        probing = false;
        durations.sort((a, b) => a - b);
        const at = (q) => Math.round((durations[Math.floor(q * (durations.length - 1))] ?? 0) * 10) / 10;
        await report(`PASS get_lines during the tail (${name}): ${durations.length} calls, median ${at(0.5)} ms, max ${at(1)} ms`);
        if (withPlaceholder > 0) {
          throw new Error(`${name}: rows without text in ${withPlaceholder} of ${changes} view changes`);
        }
        await report(`PASS tail draws no row without text (${name}): ${changes} view changes`);
      },
    };
  };

  try {
    await report('START');
    // CLI argument opened the file; first lines, colours, counters, profile suggestion.
    await waitFor('file from the command line is open', () => $('.tab .title')?.textContent.includes('e2e.log'));
    await waitFor('every command line file gets a tab', () => $$('.tab .title').length === 3);
    click($$('.tab .title').find((t) => t.textContent.includes('e2e.log')));
    await waitFor('lines rendered', () => rowTexts().some((t) => t.includes('Starting ShopApplication')));
    await waitFor('counters', () => count('ERROR') === 8 && count('FATAL') === 1 && count('WARN') === 1);
    // Format detection (prompt 008): the Spring Boot sample splits into the Log4j columns.
    const columns = await invoke('get_columns', { sessionId: 1 });
    const ids = columns.columns.map((c) => c.id).join(',');
    if (columns.profileId !== 'log4j' || columns.confidence < 0.99) {
      throw new Error(`format: ${columns.profileId} ${columns.confidence}`);
    }
    if (ids !== 'timestamp,level,pid,thread,logger,message') throw new Error(`columns: ${ids}`);
    await report(`PASS format detected: ${columns.profileId} ${Math.round(columns.confidence * 100)} %, columns ${ids}`);
    const [firstLine] = await invoke('get_lines', { sessionId: 1, view: 'all', start: 0, count: 1 });
    const value = (id) => {
      const [start, end] = firstLine.fields[columns.columns.findIndex((c) => c.id === id)];
      return firstLine.text.slice(start, end);
    };
    if (value('thread') !== 'main' || value('message') !== 'Starting ShopApplication v2.4.1 using Java 21') {
      throw new Error(`fields: ${JSON.stringify(firstLine.fields)}`);
    }
    await report('PASS fields of the first line');

    // Column view (prompt 009): the table's header shows the fields, one cell per field. Afterwards the raw
    // view (T), in which every check below runs as before.
    const heads = () =>
      $$('app-log-table-view .ge-table-header .lt-head:not(.lt-head-gutter)').filter(
        (h) => h.getBoundingClientRect().width > 0 && h.getBoundingClientRect().height > 0,
      );
    const headLabels = () => heads().map((h) => h.textContent.trim()).join(',');
    const headOf = (label) => heads().find((h) => h.textContent.trim() === label);
    const fieldCells = (id) => inView($$(`app-log-table-view .lt-cell[data-col="${id}"]:not(.lt-span, .lt-spanned)`));
    const spanCell = () => $$('app-log-table-view .lt-span').find((c) => c.textContent.includes('Caused by'));
    const menu = () => $('app-column-menu');
    const menuRow = (id) => menu()?.querySelector(`li[data-col="${id}"]`);
    const menuButton = (text) => [...menu().querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    const columnsButton = () => button('▦');
    const ALL_COLUMNS = 'Zeit,Level,pid,Thread,Logger,Nachricht';
    await waitFor('column header shows the fields', () => headLabels() === ALL_COLUMNS);
    await waitFor('columns switch is pressed', () => columnsButton().getAttribute('aria-pressed') === 'true');
    await waitFor('header cells are column headers', () => heads().every((h) => h.getAttribute('role') === 'columnheader'));
    await waitFor('cells hold the fields', () =>
      fieldCells('thread')[0]?.textContent === 'main' &&
      fieldCells('level')[0]?.textContent === 'INFO' &&
      fieldCells('message')[0]?.textContent === 'Starting ShopApplication v2.4.1 using Java 21',
    );
    await waitFor('a stack trace spans from the first column', () => {
      const first = fieldCells('timestamp')[0];
      return spanCell() && first && Math.abs(spanCell().getBoundingClientRect().left - first.getBoundingClientRect().left) < 1.5;
    });
    const flush = (label, id) => {
      const head = headOf(label).getBoundingClientRect();
      const cell = fieldCells(id)[0].getBoundingClientRect();
      return Math.abs(head.left - cell.left) < 1.5 && Math.abs(head.width - cell.width) < 1.5;
    };
    await waitFor('header and cells are flush', () => flush('Thread', 'thread') && flush('Logger', 'logger'));
    const loggerLeft = headOf('Logger').getBoundingClientRect().left;
    const spanTextLeft = () => spanCell()?.querySelector('.lt-text').getBoundingClientRect().left;
    const spanText0 = spanTextLeft();
    scroller().scrollLeft = 150;
    await waitFor('scrolled sideways, header and cells stay flush', () =>
      headOf('Logger').getBoundingClientRect().left <= loggerLeft - 140 && flush('Logger', 'logger'),
    );
    await waitFor('a span moves with the columns', () => Math.abs(spanTextLeft() - (spanText0 - 150)) < 1.5);
    scroller().scrollLeft = 0;
    await waitFor('back at the left', () => Math.abs(headOf('Logger').getBoundingClientRect().left - loggerLeft) < 1.5);
    press('F10', { shiftKey: true });
    await waitFor('Shift+F10 opens the column menu with the focus in it', () =>
      menu()?.getAttribute('role') === 'dialog' && menu().contains(document.activeElement),
    );
    const threadWidth = headOf('Thread').getBoundingClientRect().width;
    menuRow('thread').querySelector('button[aria-label="Thread breiter"]').click();
    await waitFor('a column gets wider from the menu', () =>
      headOf('Thread').getBoundingClientRect().width > threadWidth + 10 && flush('Thread', 'thread'),
    );
    const widened = headOf('Thread').getBoundingClientRect().width;
    const threadIndex = headOf('Thread').dataset.colIndex;
    $(`app-log-table-view .ge-table-header [data-ge-action="resize-column"][data-col-index="${threadIndex}"]`).dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
    );
    await waitFor('double click on the edge fits the column to the rows on screen', () => {
      const width = headOf('Thread').getBoundingClientRect().width;
      const widest = Math.max(...fieldCells('thread').map((c) => c.querySelector('.lt-text').offsetWidth));
      return width < widened - 10 && width >= widest && flush('Thread', 'thread');
    });
    menuRow('thread').querySelector('input').click();
    await waitFor('a column can be hidden', () =>
      headLabels() === 'Zeit,Level,pid,Logger,Nachricht' && fieldCells('thread').length === 0,
    );
    await waitFor('the message cannot be hidden', () => menuRow('message').querySelector('input').disabled);
    menuRow('level').querySelector('button[aria-label="Level nach rechts"]').click();
    await waitFor('a column moves to the right', () => headLabels() === 'Zeit,pid,Level,Logger,Nachricht');
    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor('Escape closes the menu', () => !menu());
    search('order');
    await waitFor('matches are marked in the cells', () =>
      $$('app-log-table-view .lt-cell[data-col="message"] .hit').some((h) => /order/i.test(h.textContent)),
    );
    search('');
    await waitFor('search cleared in the column view', () => !$('.hit') && !status().includes(' von '));
    $('app-log-table-view .ge-table-header [data-col-index="1"]').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 120 }),
    );
    await waitFor('right click on the header opens the menu', () => !!menu());
    menuButton('Zurücksetzen').click();
    await waitFor('reset brings the layout of the format back', () => headLabels() === ALL_COLUMNS);
    menuButton('Schließen').click();
    await waitFor('menu closed', () => !menu());
    press('t');
    await waitFor('T switches to the raw view', () =>
      columnsButton().getAttribute('aria-pressed') === 'false' && heads().length === 0 && !$('.lt-col'),
    );
    await waitFor('text keeps its spaces', () => getComputedStyle(rows()[0]).whiteSpace === 'pre');
    await waitFor('text is exact, without added spaces', () =>
      rowTexts()[0] === '2026-01-15T10:00:00.123+01:00  INFO 4711 --- [           main] c.a.shop.ShopApplication                 : Starting ShopApplication v2.4.1 using Java 21',
    );
    await waitFor('long lines scroll sideways', () => scroller().scrollWidth > scroller().clientWidth);
    const textLeft = () => rows()[0].getBoundingClientRect().left;
    const gutterLeft = () => inView($$('app-log-table-view .lt-gutter'))[0].getBoundingClientRect().left;
    const [text0, gutter0] = [textLeft(), gutterLeft()];
    scroller().scrollLeft = 120;
    await waitFor('text moves, line numbers stay', () => textLeft() <= text0 - 100 && gutterLeft() === gutter0);
    scroller().scrollLeft = 0;
    await waitFor('text back at the start', () => textLeft() === text0);
    await waitFor('continuation lines inherit ERROR', () =>
      $$('.lt-cell.lv-ERROR.cont').some((r) => r.textContent.includes('Caused by')),
    );
    const errorRow = $$('.lt-cell.lv-ERROR')[0];
    const [r, g, b] = getComputedStyle(errorRow).color.match(/\d+/g).map(Number);
    await waitFor('ERROR is red', () => r > 150 && r > g * 1.5 && r > b * 1.5);
    await waitFor('profile suggested', () => {
      const select = $('select[aria-label=Profil]');
      return select.options[select.selectedIndex].value === 'log4j';
    });
    await waitFor('status live', () => status().includes('Live'));

    // Live tail with follow.
    await act('append 2026-01-15T10:01:00.000+01:00  INFO 4711 --- [t] a.B : tail line one');
    await waitFor('appended line appears', () => rowTexts().some((t) => t.includes('tail line one')));

    // Follow pauses on scrolling up; the badge counts; End resumes.
    await act('bulk 500');
    await waitFor('bulk arrived while following', () => rowTexts().some((t) => t.includes('bulk line 500')));
    wheel(-4000);
    await waitFor('scroll up pauses', () => status().includes('Pausiert'));
    await act('bulk 237');
    await waitFor('badge counts new lines', () => $('.new-lines')?.textContent.includes('237 neue Zeilen'));
    click($('.new-lines'));
    await waitFor('badge click follows again', () => status().includes('Live') && !$('.new-lines'));
    await waitFor('end is visible', () => rowTexts().some((t) => t.includes('bulk line 237')));
    press(' ');
    await waitFor('space pauses', () => status().includes('Pausiert'));
    press('f');
    await waitFor('F resumes', () => status().includes('Live'));

    // Level filter: toggle, only this, this and worse, presets.
    click(chip('INFO'));
    await waitFor('INFO off', () => chip('INFO').getAttribute('aria-pressed') === 'false' && !$('.lt-cell.lv-INFO'));
    click(button('WARN+'));
    await waitFor('WARN+ shows no INFO', () => rows().length && !$('.lt-cell.lv-INFO') && !!$('.lt-cell.lv-WARN'));
    click(chip('ERROR'), { altKey: true });
    await waitFor('alt-click only ERROR, with its stack trace', () =>
      rows().every((r) => r.classList.contains('lv-ERROR')) && rowTexts().some((t) => t.includes('Caused by')),
    );
    chip('WARN').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor('double click: WARN and worse', () => !!$('.lt-cell.lv-WARN') && !!$('.lt-cell.lv-FATAL') && !$('.lt-cell.lv-INFO'));
    await act('append 2026-01-15T10:02:00.000+01:00 ERROR 4711 --- [t] a.B : after the filter');
    await waitFor('filter grows incrementally', () => rowTexts().some((t) => t.includes('after the filter')));
    click(button('Alle'));
    await waitFor('all levels again', () => status().includes('Zeilen') && !status().includes(' von '));

    // Search: filter mode, regex, invalid regex, highlight mode with navigation.
    search('order');
    await waitFor('search filters', () => status().includes(' von ') && rowTexts().some((t) => t.includes('Could not place order')));
    await waitFor('entry stays together', () => rowTexts().some((t) => t.includes('at com.acme.shop.db.ConnectionPool')));
    await waitFor('match is marked', () => $$('.lt-cell .hit').some((h) => /order/i.test(h.textContent)));
    click(button('.*'));
    search('or+der\\s+\\d+');
    await waitFor('regex search', () => rowTexts().some((t) => t.includes('Order 4242')));
    search('(');
    await waitFor('invalid regex is reported', () => $('input[type=search]').classList.contains('invalid'));
    click(button('.*'));
    search('bulk line 10');
    const mode = $('select[aria-label=Suchmodus]');
    mode.value = 'highlight';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor('highlight mode shows everything', () => !status().includes(' von '));
    click($('button[title^="Nächster"]'));
    await waitFor('next match scrolls to it', () =>
      $$('.lt-cell.current-hit').some((r) => r.textContent.includes('bulk line 10')),
    );
    await waitFor('follow stopped by the jump', () => status().includes('Pausiert'));
    const firstHit = $('.lt-gutter.current-hit').textContent;
    click($('button[title^="Nächster"]'));
    await waitFor('next match moves on', () => $('.lt-gutter.current-hit')?.textContent !== firstHit);
    click($('button[title^="Vorheriger"]'));
    await waitFor('previous match goes back', () => $('.lt-gutter.current-hit')?.textContent === firstHit);
    search('');
    mode.value = 'filter';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor('search cleared', () => !$('.hit'));
    await sleep(400);
    press('End');
    await waitFor('back at the end', () => status().includes('Live'));

    // Selecting a stack trace line selects the entry; copying returns its text.
    press('Home');
    await waitFor('home', () => rowTexts()[0].includes('Starting ShopApplication'));
    const cause = rows().find((r) => r.textContent.includes('Caused by'));
    click(cause);
    await waitFor('entry selected', () => $$('.lt-cell.selected').length === 8);
    const first = Math.min(...$$('.lt-cell.selected').map((c) => Number(c.dataset.line)));
    const text = await invoke('copy_lines', {
      sessionId: 1,
      first,
      last: first + 7,
    });
    await waitFor('copy text is the entry', () => text.startsWith('2026-01-15T10:00:07') && text.includes('... 12 more'));

    // Detail panel (prompt 004): double click opens it with the entry the first click chose, a click changes
    // it, D closes it, the splitter moves by keyboard (synthetic pointers cannot be captured).
    const panel = () => $('app-detail-panel');
    const panelBody = () => panel()?.querySelector('pre.body');
    const panelText = () => panelBody()?.textContent ?? '';
    const panelRange = () => panel()?.querySelector('.range')?.textContent.trim();
    const panelButton = (label) => [...panel().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    const splitter = () => $('app-splitter');
    const panelHeight = () => panel().getBoundingClientRect().height;
    const detailButton = () => button('▤');
    await waitFor('detail panel is closed at first', () => !panel() && detailButton().getAttribute('aria-pressed') === 'false');
    rows()
      .find((r) => r.textContent.includes('Caused by'))
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await waitFor('double click opens the panel with the selected entry', () =>
      panelText().startsWith('2026-01-15T10:00:07') && detailButton().getAttribute('aria-pressed') === 'true',
    );
    await waitFor('the stack trace is complete in the panel', () =>
      panelText().split('\n').length === 8 &&
      panelText().includes('Caused by: java.net.SocketTimeoutException') &&
      panelText().endsWith('... 12 more') &&
      panel().querySelector('.badge')?.textContent.trim() === 'ERROR' &&
      panelRange() === `Zeile ${first + 1}–${first + 8}`,
    );
    await waitFor('the selected rows stay in view above the panel', () =>
      inView($$('.lt-cell.selected')).length === 8 &&
      Math.max(...$$('.lt-cell.selected').map((c) => c.getBoundingClientRect().bottom)) <=
        splitter().getBoundingClientRect().top + 1,
    );
    click(rows().find((r) => r.textContent.includes('Starting ShopApplication')));
    await waitFor('a single click changes the entry in the open panel', () =>
      panelText() === rowTexts()[0] && panelRange() === 'Zeile 1',
    );
    const logTop = topLine();
    panelBody().focus();
    for (const key of ['ArrowDown', 'PageDown', 'End']) {
      panelBody().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
    await sleep(200);
    await waitFor('keys in the panel leave the log alone', () => topLine() === logTop && status().includes('Pausiert'));
    const separator = splitter();
    await waitFor('the splitter is a focusable separator', () =>
      separator.getAttribute('role') === 'separator' &&
      separator.getAttribute('aria-orientation') === 'horizontal' &&
      separator.tabIndex === 0 &&
      Math.abs(Number(separator.getAttribute('aria-valuenow')) - panelHeight()) < 1,
    );
    const height0 = panelHeight();
    separator.focus();
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await waitFor('ArrowUp on the splitter makes the panel taller', () =>
      Math.abs(panelHeight() - (height0 + 10)) < 1 &&
      Math.abs(Number(separator.getAttribute('aria-valuenow')) - (height0 + 10)) < 1,
    );
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true }));
    await waitFor('Shift+ArrowDown makes it 100 px lower', () => Math.abs(panelHeight() - (height0 - 90)) < 1);
    await waitFor('the splitter keys leave the log alone', () => topLine() === logTop);
    separator.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await waitFor('double click on the splitter restores the default height', () => Math.abs(panelHeight() - 240) < 1);
    const jsonLine =
      '2026-01-15T10:00:30.000+01:00  INFO 4711 --- [t] a.B : payload {"id":9007199254740993,"items":[{"sku":"A-1","qty":2}],"ok":true}';
    await act(`append ${jsonLine}`);
    press('End');
    await waitFor('the JSON line arrived', () => rowTexts().some((t) => t.includes('payload {')));
    click(rows().find((r) => r.textContent.includes('payload {')));
    await waitFor('JSON is formatted in the panel, the big id exact', () =>
      panelText().includes('payload {\n  "id": 9007199254740993,\n  "items": [\n    {\n      "sku": "A-1",') &&
      panel().querySelector('.f-key')?.textContent === '"id"',
    );
    click(panelButton('Roh'));
    await waitFor('the raw view shows the line as written', () =>
      panelText() === jsonLine && panelButton('Roh').getAttribute('aria-pressed') === 'true',
    );
    click(panelButton('Formatiert'));
    await waitFor('formatted again', () => panelText().includes('\n  "ok": true\n}'));
    press('d');
    await waitFor('D closes the panel', () => !panel() && detailButton().getAttribute('aria-pressed') === 'false');
    press('Escape');

    // Font size.
    const fontOf = () => getComputedStyle($('app-log-table-view .lt-table')).fontSize;
    const before = fontOf();
    click(button('A+'));
    await waitFor('font grows', () => fontOf() !== before);
    click(button('A−'));

    // File events.
    press('End');
    await act('truncate');
    await waitFor('truncation empties the view', () => status().match(/\b0 Zeilen/) && $('.lt-empty'));
    await act('append 2026-01-15T10:03:00.000+01:00  WARN 4711 --- [t] a.B : after truncate');
    await waitFor('reads on after truncation', () => rowTexts().some((t) => t.includes('after truncate')));
    await act('rotate 2026-01-15T10:04:00.000+01:00 ERROR 4711 --- [t] a.B : first in new file');
    await waitFor('rotation is announced', () => status().includes('Datei rotiert'));
    await waitFor('old and new lines stay', () =>
      rowTexts().some((t) => t.includes('after truncate')) && rowTexts().some((t) => t.includes('first in new file')),
    );
    await act('delete');
    await waitFor('missing file is reported', () => status().includes('Datei fehlt'));
    await act('recreate 2026-01-15T10:05:00.000+01:00  INFO 4711 --- [t] a.B : back again');
    await waitFor('picks the file up again', () => rowTexts().some((t) => t.includes('back again')));

    // A second tab: errors arriving in the background show a red dot until the tab is looked at.
    const tabs = () => $$('.tab .title');
    await waitFor('all files have tabs', () => tabs().length === 3);
    const tabOf = (name) => tabs().find((t) => t.textContent.includes(name));
    click(tabOf('other.log'));
    await waitFor('tab switch shows the other file', () => rowTexts().some((t) => t.includes('other file')));
    await waitFor('profile belongs to the tab', () => {
      const select = $('select[aria-label=Profil]');
      return select.options[select.selectedIndex].value === 'python';
    });
    await act('append 2026-01-15T10:06:00.000+01:00 ERROR 4711 --- [t] a.B : background error');
    await waitFor('red dot on the background tab', () => tabOf('e2e.log').querySelector('.alert'));
    click(tabOf('e2e.log'));
    await waitFor('dot clears when seen', () => !tabOf('e2e.log').querySelector('.alert'));

    // Settings: a custom profile is validated by the backend and changes the levels.
    click($('button[title=Einstellungen]'));
    await waitFor('settings open', () => $('dialog[open]'));
    const form = $('.profile-form');
    const [nameInput, patternInput] = form.querySelectorAll('input');
    const mappingInput = form.querySelector('textarea');
    const formButton = (text) => [...form.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));
    // Layout preview (prompt 008): the backend splits the sample line, spans in UTF-16.
    const layoutsInput = form.querySelectorAll('textarea')[1];
    const sampleInput = form.querySelectorAll('input')[2];
    layoutsInput.value = '^(?P<level>[A-Z]+) (?P<message>.*)$';
    sampleInput.value = 'WARN größer 😀 ok';
    click(formButton('Testen'));
    await waitFor('layout preview splits the sample line', () =>
      [...form.querySelectorAll('.preview dd')].map((d) => d.textContent).join('|') === 'WARN|größer 😀 ok',
    );
    layoutsInput.value = '';
    nameInput.value = 'Mine';
    patternInput.value = '^no level group';
    click(formButton('Profil'));
    await waitFor('bad regex is refused', () => form.querySelector('.error')?.textContent.includes('level'));
    patternInput.value = ' : (?P<level>back|bulk) ';
    mappingInput.value = 'back=FATAL\nbulk=DEBUG';
    click(formButton('Profil'));
    await waitFor('profile accepted', () => !form.querySelector('.error') && $('.profile-row')?.textContent.includes('Mine'));
    $('dialog').close();
    await waitFor('settings closed', () => !$('dialog[open]'));
    const profileSelect = $('select[aria-label=Profil]');
    await waitFor('custom profile selectable', () => [...profileSelect.options].some((o) => o.textContent.trim() === 'Mine'));
    profileSelect.value = [...profileSelect.options].find((o) => o.textContent.trim() === 'Mine').value;
    profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor('levels recomputed by the profile', () => count('FATAL') === 2 && count('UNKNOWN') === 2 && !!$('.lt-cell.lv-FATAL'));

    // A big file: the scrollbar reaches every line although the view is far over the browser limit.
    click(tabOf('big.log'));
    await waitFor('big file indexed', () => /2\.000\.000 Zeilen/.test(status()) && status().includes('Live'), 60000);
    const bar = scroller();
    await waitFor('scroll range is capped', () => bar.scrollHeight < 9000000);
    await waitFor('following shows the last line', () => rowTexts().some((t) => t.includes('big line 2000000')));
    bar.scrollTop = bar.scrollHeight / 2;
    await waitFor('dragging the bar pauses near the middle', () =>
      status().includes('Pausiert') && rowTexts().some((t) => /big line (99\d{4}|100\d{4}) /.test(t)),
    );
    const middle = topLine();
    wheel(60);
    await waitFor('wheel moves by lines even here', () => {
      const now = topLine();
      return now > middle && now <= middle + 4;
    });
    press('Home');
    await waitFor('start of the big file', () => rowTexts()[0]?.includes('big line 1 '));
    click(tabOf('e2e.log'));
    await waitFor('back on the small file', () => !status().includes('2.000.000'));

    // 10 000 lines per second while following: the event loop stays free.
    press('End');
    const lineCount = () => Number(status().match(/([\d.]+) Zeilen/)[1].replace(/\./g, ''));
    const linesBefore = lineCount();
    let last = performance.now();
    let worstLag = 0;
    // A message loop, not a timer: timers of a window in the background run about once a second.
    let measuring = true;
    let turns = 0;
    const loop = new MessageChannel();
    loop.port1.onmessage = () => {
      const now = performance.now();
      worstLag = Math.max(worstLag, now - last);
      last = now;
      turns++;
      if (measuring) loop.port2.postMessage(0);
    };
    loop.port2.postMessage(0);
    await waitFor('rows are loaded before the burst', () => !$('.lt-cell.loading'));
    // The detail panel stays on its entry while the tail runs (prompt 004).
    click(rows()[0]);
    press('d');
    await waitFor('panel open on the first row in view', () => panelText() && panelRange() && status().includes('Live'));
    const heldEntry = panelText();
    const heldRange = panelRange();
    let tail = watchTail();
    await act('rate 10000 3');
    await waitFor('all lines of the burst arrived', () => lineCount() === linesBefore + 30000, 20000);
    await waitFor('follow kept up', () => rowTexts().some((t) => t.includes('rate line 30000')));
    await waitFor('the panel kept its entry during the burst', () => panelText() === heldEntry && panelRange() === heldRange);
    measuring = false;
    await report(`PASS worst event loop lag during 3 s at 10k lines/s: ${Math.round(worstLag)} ms (${turns} turns)`);
    if (worstLag > 250) throw new Error(`event loop blocked for ${Math.round(worstLag)} ms`);
    await tail.check('all levels');
    press('d');
    press('Escape');
    await waitFor('panel closed after the burst', () => !panel());

    // The same with only errors on screen, where a row without its colour stands out most. The custom
    // profile from above would call every line FATAL.
    profileSelect.value = 'log4j';
    profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor('back on the log4j profile', () => count('INFO') > 30000);
    click(button('ERROR+'));
    await waitFor('only errors are shown', () => $('.lt-cell.lv-ERROR') && !$('.lt-cell.lv-INFO'));
    await waitFor('filtered rows are loaded', () => !$('.lt-cell.loading'));
    tail = watchTail();
    await act('rate 2000 2 ERROR');
    await waitFor('filtered follow kept up', () => rowTexts().some((t) => t.includes('ERROR rate line 4000')), 20000);
    await tail.check('ERROR+');
    click(button('Alle'));
    await waitFor('all lines again', () => !status().includes(' von '));

    // Freeze: nothing moves while the file grows, a filter still works, resuming catches up.
    const pill = () => $('app-status-bar .pill').textContent.trim();
    click(button('⏸'));
    await waitFor('frozen', () => pill() === 'Eingefroren' && button('▶') && $('.tab .frozen'));
    await sleep(300);
    const heldLines = lineCount();
    const heldRows = rowTexts().join();
    await act('rate 2000 2');
    await waitFor('waiting bytes are shown', () => status().includes('warten'));
    await sleep(600);
    await waitFor('line count holds', () => lineCount() === heldLines);
    await waitFor('rows hold', () => rowTexts().join() === heldRows);
    click(button('ERROR+'));
    await waitFor('a filter finishes during the freeze', () => status().includes(' von ') && $('.lt-cell.lv-ERROR') && !$('.lt-cell.lv-INFO'));
    click(button('Alle'));
    await waitFor('the filter lifts during the freeze', () => !status().includes(' von ') && lineCount() === heldLines);
    await sleep(2200); // all of the burst is in the file
    press('p');
    await waitFor('P resumes', () => pill() !== 'Eingefroren' && button('⏸') && !$('.tab .frozen'));
    await waitFor('resuming catches up', () => lineCount() === heldLines + 4000);
    await waitFor('and shows the end', () => rowTexts().some((t) => t.includes('rate line 4000')));
    await waitFor('nothing waits any more', () => !status().includes('warten'));

    // End stays within the freeze; a reader keeps the position on resuming and sees the count.
    press('p');
    await waitFor('frozen again', () => pill() === 'Eingefroren');
    press('End');
    await sleep(200);
    await waitFor('End does not lift the freeze', () => pill() === 'Eingefroren');
    wheel(-400);
    await waitFor('scrolled up within the freeze', () => !rowTexts().some((t) => t.includes('rate line 4000')));
    await sleep(100);
    const readingAt = topLine();
    await act('append 2026-01-15T10:08:00.000+01:00  INFO 4711 --- [t] a.B : after the freeze');
    await sleep(400);
    press('p');
    await waitFor('resumed for the reader', () => pill() === 'Pausiert');
    await waitFor('the badge counts what came', () => $('.new-lines')?.textContent.includes('1 neue Zeile'));
    await waitFor('the reader stays in place', () => topLine() === readingAt);
    press('End');
    await waitFor('following again', () => pill() === 'Live');

    // The column view comes back with its layout.
    press('t');
    await waitFor('T switches back to the columns', () =>
      columnsButton().getAttribute('aria-pressed') === 'true' && headLabels() === ALL_COLUMNS,
    );

    // Closing the tabs leads back to the start screen.
    click(tabOf('big.log').parentElement.querySelector('.close'));
    await waitFor('tab closed', () => tabs().length === 2);
    click(tabOf('other.log').parentElement.querySelector('.close'));
    click(tabOf('e2e.log').parentElement.querySelector('.close'));
    await waitFor('start screen lists recent files', () => $('app-start-screen')?.textContent.includes('e2e.log'));

    // Opening by a typed path; the harness sets HOME to the folder that holds other.log.
    const typePath = (text) => {
      const input = $('app-open-path-dialog input');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.form;
    };
    click(button('Pfad eingeben'));
    await waitFor('path dialog opens and takes the focus', () =>
      $('app-open-path-dialog dialog')?.open && document.activeElement === $('app-open-path-dialog input'));
    typePath('   ');
    await waitFor('blank path cannot be submitted', () => $('app-open-path-dialog button[type=submit]').disabled);
    typePath('~/does-not-exist.log').requestSubmit();
    await waitFor('wrong path is reported in the dialog, which stays open', () =>
      $('app-open-path-dialog .error')?.textContent.includes('does-not-exist.log') && $('app-open-path-dialog dialog').open);
    typePath(' "~/other.log" ').requestSubmit();
    await waitFor('quotes and ~ are resolved and the file opens', () => tabOf('other.log') && !$('app-open-path-dialog'));
    press('o', { metaKey: true, shiftKey: true });
    await waitFor('shortcut opens the path dialog', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/other.log').requestSubmit();
    await waitFor('a file already open gets no second tab', () => !$('app-open-path-dialog') && tabs().length === 1);
    click(button('Pfad'));
    await waitFor('tab bar opens the path dialog', () => $('app-open-path-dialog dialog')?.open);
    $('app-open-path-dialog dialog').close();
    await waitFor('dialog can be dismissed', () => !$('app-open-path-dialog'));

    // A file without structure: no header in the column view, the switch is off.
    click(button('Pfad'));
    await waitFor('path dialog for the plain file', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/plain.log').requestSubmit();
    await waitFor('plain file is open', () => tabOf('plain.log') && rowTexts().some((t) => t.includes('just some words')));
    await waitFor('no header for a file without structure', () =>
      heads().length === 0 && !$('.lt-col') && columnsButton().disabled,
    );

    await report('DONE');
  } catch (e) {
    await report(`FAIL ${e.message}`);
  }
})();
