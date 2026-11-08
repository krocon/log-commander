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

    // Sidebar (prompt 005): tree with files and filters, statistics with the columns "Alle" and "Ansicht".
    const statRow = (label) =>
      $$('app-stats-panel tbody tr').find((tr) => tr.querySelector('th').textContent.trim() === label);
    const stat = (label, column) => {
      const text = statRow(label).querySelectorAll('td')[column === 'all' ? 0 : 1].textContent.trim();
      return text === '…' ? NaN : Number(text.replace(/\D/g, ''));
    };
    const treeItem = (text) =>
      $$('app-log-tree [role=treeitem]').find((n) => n.querySelector('.label')?.textContent.trim() === text);
    const treeKind = (kind) => $(`app-log-tree [role=treeitem].kind-${kind}`);
    const searchValue = () => $('input[type=search]').value;
    const pressed = (level) => chip(level).getAttribute('aria-pressed') === 'true';
    const keyOn = (el, key, options = {}) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
    await waitFor('sidebar with tree and statistics', () => $('app-sidebar [role=tree]') && $('app-stats-panel table'));
    await waitFor('statistics of the sample', () =>
      stat('Zeilen', 'all') === 15 && stat('Zeilen', 'view') === 15 &&
      stat('ERROR', 'all') === 8 && stat('FATAL', 'all') === 1 && stat('INFO', 'all') === 3 &&
      stat('WARN', 'all') === 1 && stat('TRACE', 'all') === 1 && stat('DEBUG', 'all') === 1 &&
      stat('Ohne Level', 'all') === 0 && stat('ERROR', 'view') === 8);
    await waitFor('statistics match the level chips', () =>
      ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].every((l) => stat(l, 'all') === count(l)));
    await waitFor('file size in the statistics', () => statRow('Dateigröße').textContent.includes('KB'));
    await waitFor('tree lists the open files', () => treeItem('e2e.log') && treeItem('other.log') && treeItem('big.log'));
    await waitFor('active file is selected in the tree', () => treeItem('e2e.log').getAttribute('aria-selected') === 'true');

    // Toggle: Cmd/Ctrl+B and the toolbar button.
    press('b', { metaKey: true });
    await waitFor('Cmd+B hides the sidebar', () => !$('app-sidebar') && button('◧').getAttribute('aria-pressed') === 'false');
    click(button('◧'));
    await waitFor('toolbar button shows it again', () => $('app-sidebar') && button('◧').getAttribute('aria-pressed') === 'true');

    // Width by keyboard on its splitter.
    const widthSplitter = () => $('app-splitter[aria-label="Breite der Seitenleiste"]');
    const sidebarWidth = () => $('app-sidebar').getBoundingClientRect().width;
    const widthBefore = sidebarWidth();
    widthSplitter().focus();
    keyOn(widthSplitter(), 'ArrowRight');
    await waitFor('splitter widens the sidebar', () => Math.round(sidebarWidth() - widthBefore) === 10);
    keyOn(widthSplitter(), 'ArrowLeft');
    await waitFor('and back', () => Math.round(sidebarWidth()) === Math.round(widthBefore));

    // Switching files through the tree.
    click(treeItem('other.log'));
    await waitFor('tree activates the other tab', () => $('.tab.active')?.textContent.includes('other.log'));
    click(treeItem('e2e.log'));
    await waitFor('and back through the tree', () => $('.tab.active')?.textContent.includes('e2e.log') &&
      rowTexts().some((t) => t.includes('Starting ShopApplication')));

    // Arrow keys move in the tree, not in the log; Space there does not stop following.
    const topBefore = topLine();
    treeItem('e2e.log').focus();
    keyOn(treeItem('e2e.log'), 'ArrowDown');
    await waitFor('ArrowDown moves the focus in the tree', () => document.activeElement === treeItem('other.log'));
    keyOn(document.activeElement, ' ');
    await waitFor('Space in the tree activates the file and leaves following alone', () =>
      $('.tab.active')?.textContent.includes('other.log') && $('app-status-bar .pill').textContent.trim() === 'Live');
    click(treeItem('e2e.log'));
    await waitFor('e2e.log active again, same top line', () =>
      $('.tab.active')?.textContent.includes('e2e.log') && topLine() === topBefore);

    // A click on ERROR in the statistics filters on it, the × in the tree removes it again.
    click($('app-stats-panel button[data-level=ERROR]'));
    await waitFor('click on ERROR filters on it', () =>
      pressed('ERROR') && !pressed('INFO') && !pressed('FATAL') && stat('Zeilen', 'view') === 8 &&
      stat('ERROR', 'view') === 8 && stat('INFO', 'view') === 0 && stat('INFO', 'all') === 3);
    await waitFor('tree shows the active filter', () => treeKind('filter-levels')?.textContent.includes('ERROR'));
    click($('app-stats-panel button[data-level=FATAL]'), { altKey: true });
    await waitFor('Alt-click adds FATAL', () => pressed('ERROR') && pressed('FATAL') && stat('Zeilen', 'view') === 9);
    click(treeKind('filter-levels').querySelector('.remove'));
    await waitFor('× in the tree shows all levels again, the toolbar follows', () =>
      ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].every(pressed) && !treeKind('active-filter') &&
      stat('Zeilen', 'view') === 15);

    // Save a filter, remove the search by ×, apply the saved filter again.
    search('order');
    await waitFor('search shows in the tree', () => treeKind('filter-query')?.textContent.includes('order'));
    click(treeKind('active-filter').querySelector('.save'));
    await waitFor('name field in the tree', () => document.activeElement === $('app-log-tree input.name'));
    $('app-log-tree input.name').value = 'Bestellungen';
    keyOn($('app-log-tree input.name'), 'Enter');
    await waitFor('saved filter in the tree, marked as in use', () => treeItem('Bestellungen')?.classList.contains('current'));
    const filteredWithSearch = stat('Zeilen', 'view');
    click(treeKind('filter-query').querySelector('.remove'));
    await waitFor('× removes the search, the toolbar shows it', () =>
      searchValue() === '' && !treeKind('active-filter') && stat('Zeilen', 'view') === 15);
    click(treeItem('Bestellungen'));
    await waitFor('saved filter applies', () =>
      searchValue() === 'order' && stat('Zeilen', 'view') === filteredWithSearch &&
      treeItem('Bestellungen').classList.contains('current'));
    // A search still being typed must not overwrite a saved filter applied right after.
    click(treeKind('filter-query').querySelector('.remove'));
    await waitFor('search removed again', () => searchValue() === '' && stat('Zeilen', 'view') === 15);
    search('typed but not done');
    click(treeItem('Bestellungen'));
    await sleep(400);
    await waitFor('typing yields to the saved filter', () =>
      searchValue() === 'order' && treeKind('filter-query')?.textContent.includes('order'));
    click(treeItem('Bestellungen').querySelector('.remove'));
    await waitFor('saved filter deleted', () => !treeItem('Bestellungen') && !treeKind('saved-group'));
    click(treeKind('filter-query').querySelector('.remove'));
    await waitFor('back to everything', () => searchValue() === '' && stat('Zeilen', 'view') === 15);

    // Filter tree (prompt 010): a request id by marking it, AND and OR, a condition switched off, a section
    // between two markers, an error at its node.
    const exprConds = () => $$('app-log-tree [role=treeitem].kind-expr-cond');
    const exprRoot = () => $('app-log-tree [role=treeitem].kind-expr-group');
    /** Marks `text` inside the log view like a user dragging over it; returns the element holding it. */
    // Waits for the text first: counts in the sidebar can be ahead of the rows the table has drawn.
    const markText = async (text) => {
      await waitFor(`text in the view: ${text}`, () => $('app-log-table-view').textContent.includes(text));
      const walker = document.createTreeWalker($('app-log-table-view'), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return node.parentElement;
      }
      throw new Error(`text not in the view: ${text}`);
    };
    const requestId = '123e4567-e89b-12d3-a456-426614174000';
    const marked = await markText(requestId);
    const box = marked.getBoundingClientRect();
    marked.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + 4,
        clientY: box.top + 4,
      }),
    );
    const menuItem = (start) =>
      $$('app-row-menu [role=menuitem]').find((b) => b.textContent.trim().startsWith(start));
    await waitFor('right click on marked text offers to filter on it', () => menuItem('Filtern auf „123e4567'));
    click(menuItem('Filtern auf'));
    await waitFor('the request id filters its whole entry, stack trace included', () =>
      stat('Zeilen', 'view') === 8 && status().includes('1 Bedingung · 8 von 15 Zeilen') &&
      exprConds().length === 1 && exprConds()[0].textContent.includes(requestId),
    );
    window.getSelection().removeAllRanges();
    // Switched off, the whole log is back for marking the next text.
    click(exprConds()[0].querySelector('input.onoff'));
    await waitFor('the check mark switches the condition off', () =>
      stat('Zeilen', 'view') === 15 && exprConds()[0].getAttribute('aria-checked') === 'false',
    );
    await markText('anna.berg');
    press('i');
    await waitFor('I adds the marked text', () => exprConds().length === 2 && stat('Zeilen', 'view') === 1);
    window.getSelection().removeAllRanges();
    click(exprConds()[0].querySelector('input.onoff'));
    await waitFor('both on, AND: no entry has both', () =>
      status().includes('2 Bedingungen') && stat('Zeilen', 'view') === 0,
    );
    await waitFor('the second condition says how it joins, as text', () =>
      exprConds()[1].querySelector('.joiner')?.textContent.trim() === 'UND',
    );
    click(exprRoot().querySelector('button.op'));
    await waitFor('OR: both entries', () =>
      stat('Zeilen', 'view') === 9 && exprConds()[1].querySelector('.joiner')?.textContent.trim() === 'ODER',
    );
    exprConds()[0].focus();
    keyOn(exprConds()[0], 'ArrowDown', { altKey: true });
    await waitFor('Alt+ArrowDown moves the condition down', () =>
      exprConds()[0].textContent.includes('anna.berg') && exprConds()[1].textContent.includes(requestId),
    );
    click(exprConds()[1].querySelector('input.onoff'));
    await waitFor('switched off: only the other condition counts', () =>
      stat('Zeilen', 'view') === 1 && status().includes('1 Bedingung ·') &&
      exprConds()[1].getAttribute('aria-checked') === 'false' && exprConds()[1].classList.contains('off'),
    );
    click(exprRoot().querySelector('button[aria-label$="entfernen"]'));
    await waitFor('× on the conditions takes the whole tree away', () =>
      !exprRoot() && !treeKind('active-filter') && stat('Zeilen', 'view') === 15,
    );

    // The form: a section between a start and an end marker.
    const dialogInput = (selector, value) => {
      const el = $(`app-condition-dialog ${selector}`);
      el.value = value;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    click(treeItem('e2e.log').querySelector('button.add'));
    await waitFor('the form for a condition opens', () => $('app-condition-dialog dialog')?.open);
    dialogInput('#cond-type', 'range');
    await waitFor('section fields', () => $('app-condition-dialog #cond-start'));
    dialogInput('#cond-start', 'Tomcat started');
    dialogInput('#cond-end', 'Pool usage');
    await waitFor('the form is complete', () => !$('app-condition-dialog button[type=submit]').disabled);
    click($('app-condition-dialog button[type=submit]'));
    await waitFor('the section from the start to the end marker', () =>
      !$('app-condition-dialog') && stat('Zeilen', 'view') === 3 &&
      exprConds()[0]?.textContent.includes('Abschnitt'),
    );
    // A broken regex: the backend names the node, the form and the tree show it.
    click(exprRoot().querySelector('button.add'));
    await waitFor('the form opens again', () => $('app-condition-dialog dialog')?.open);
    click($$('app-condition-dialog label.check').find((l) => l.textContent.includes('Regex')).querySelector('input'));
    dialogInput('#cond-text', '(');
    await waitFor('the error shows in the form', () =>
      $('app-condition-dialog .error[role=alert]')?.textContent.length > 0,
    );
    await waitFor('and at its node in the tree', () =>
      exprConds().some((n) => n.getAttribute('aria-invalid') === 'true' && n.querySelector('.err-mark')) &&
      status().includes('Bedingung ungültig'),
    );
    click($$('app-condition-dialog button').find((b) => b.textContent.trim() === 'Abbrechen'));
    await waitFor('cancel takes the broken condition out again', () =>
      !$('app-condition-dialog') && exprConds().length === 1 && !status().includes('Bedingung ungültig') &&
      stat('Zeilen', 'view') === 3,
    );
    click(exprRoot().querySelector('button[aria-label$="entfernen"]'));
    await waitFor('everything again', () => stat('Zeilen', 'view') === 15 && !exprRoot());

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
    const splitter = () => $('app-splitter[aria-controls="detail-panel"]');
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

    // Overview ruler and navigation (prompt 007). The canvas is not read: marks and pins come as data
    // attributes (`LEVEL:y:percent` and `kind:line:y`, y in px from the top of the track, percent the highest
    // density of the mark: its bar is that long).
    const ruler = () => $('app-overview-ruler');
    const track = () => ruler().querySelector('.track');
    const rulerMarks = () =>
      (ruler().dataset.marks || '').split(',').filter(Boolean).map((m) => {
        const [level, y, percent] = m.split(':');
        return { level, y: Number(y), percent: Number(percent) };
      });
    const pins = () =>
      (ruler().dataset.pins || '').split(',').filter(Boolean).map((p) => {
        const [kind, line, y] = p.split(':');
        return { kind, line: Number(line), y: Number(y) };
      });
    const pin = (kind) => pins().find((p) => p.kind === kind);
    const clickRuler = (y) => {
      const box = track().getBoundingClientRect();
      track().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.left + 7, clientY: box.top + y }));
    };
    const lineInView = (line) => inView($$('.lt-gutter')).some((g) => Number(g.dataset.line) === line);
    const errorHeadInView = () => rows().some((r) => r.classList.contains('lv-ERROR') && !r.classList.contains('cont'));
    await waitFor('ruler shows the view with its error marks', () =>
      ruler() && Number(ruler().dataset.count) > 700 && rulerMarks().some((m) => m.level === 'ERROR') &&
      rulerMarks().some((m) => m.level === 'FATAL') && track().getAttribute('aria-hidden') === 'true',
    );
    await waitFor('WARN has marks of its own next to the errors, every mark with a density', () =>
      rulerMarks().some((m) => m.level === 'WARN') &&
      rulerMarks().every((m) => m.percent >= 1 && m.percent <= 100),
    );
    await waitFor('ruler button "Ans Ende" is pressed while following', () =>
      ruler().querySelector('button.to-end').getAttribute('aria-pressed') === 'true',
    );
    press('Home');
    await waitFor('home again', () => rowTexts()[0]?.includes('Starting ShopApplication'));
    click(rows()[0]);
    await waitFor('selection shows on the ruler', () => pin('selection')?.line === 0);
    press('m');
    await waitFor('M sets a bookmark: flag in the gutter and on the ruler', () =>
      $('.lt-gutter.bookmark')?.dataset.line === '0' && pin('bookmark')?.line === 0,
    );
    press('e');
    // The first error is on screen already: the jump keeps the top line, give its answer time to arrive.
    await sleep(300);
    await waitFor('E goes to the first error, the view stays at the top', () => errorHeadInView() && topLine() === 0);
    press('e');
    await waitFor('E again: the FATAL entry, below the stack trace', () =>
      topLine() === 9 && rows().some((r) => r.classList.contains('lv-FATAL')),
    );
    press('e');
    await waitFor('and on to the error appended later', () => rowTexts().some((t) => t.includes('after the filter')));
    press('E', { shiftKey: true });
    await waitFor('Shift+E goes back', () => topLine() === 9);
    press('W', { shiftKey: true });
    await waitFor('Shift+W: the warning before', () => rows().some((r) => r.classList.contains('lv-WARN')) && topLine() === 0);
    await waitFor('jumps leave the selection alone', () =>
      pin('selection')?.line === 0 && $('.lt-gutter.selected')?.dataset.line === '0',
    );
    press('End');
    await waitFor('following again', () => status().includes('Live'));
    const lastError = rulerMarks().filter((m) => m.level === 'ERROR').at(-1);
    clickRuler(lastError.y);
    await waitFor('a click on an error mark shows its entry', () =>
      rowTexts().some((t) => t.includes('after the filter')) && status().includes('Pausiert'),
    );
    await waitFor('the click leaves the selection alone', () => pin('selection')?.line === 0);
    clickRuler(2);
    await waitFor('a click near the top goes there', () => topLine() < 10);
    press('End');
    await waitFor('following once more', () => status().includes('Live'));
    press('n');
    await waitFor('N wraps around to the bookmark', () =>
      rowTexts()[0]?.includes('Starting ShopApplication') && $('.find-message')?.textContent.includes('fortgesetzt'),
    );
    // A filter on ERROR lays the marks out again, positions are those of the view.
    const generation = Number(ruler().dataset.generation);
    click(chip('ERROR'), { altKey: true });
    await waitFor('ERROR filter: the ruler shows the view, only error marks', () =>
      Number(ruler().dataset.generation) > generation && Number(ruler().dataset.count) === 9 &&
      rulerMarks().length > 0 && rulerMarks().every((m) => m.level === 'ERROR'),
    );
    await waitFor('the hidden bookmark stays on the ruler', () => pin('bookmark')?.line === 0);
    await waitFor('error rows in the filter', () => rows().some((r) => r.textContent.includes('after the filter')));
    const revealRow = rows().find((r) => r.textContent.includes('after the filter'));
    const revealed = Number(revealRow.dataset.line);
    click(revealRow);
    await waitFor('selected in the filter', () => pin('selection')?.line === revealed && button('⇱ Im Gesamtlog'));
    press('g');
    await waitFor('G shows the selected line in the whole log', () =>
      !status().includes(' von ') && lineInView(revealed) && button('↩ Zurück zum Filter') &&
      chip('INFO').getAttribute('aria-pressed') === 'true',
    );
    await waitFor('the selection is the same', () => pin('selection')?.line === revealed);
    press('g');
    await waitFor('G again: back to the filter, the line in view', () =>
      status().includes(' von ') && Number(ruler().dataset.count) === 9 && lineInView(revealed) &&
      chip('INFO').getAttribute('aria-pressed') === 'false' && !button('↩ Zurück zum Filter'),
    );
    await waitFor('the selection is still the same', () => pin('selection')?.line === revealed);
    click(button('⇱ Im Gesamtlog'));
    await waitFor('the button does the same', () => button('↩ Zurück zum Filter') && lineInView(revealed));
    click(button('Alle'));
    await waitFor('a filter set by hand forgets the kept one', () =>
      !button('↩ Zurück zum Filter') && !status().includes(' von '),
    );
    press('Escape');
    press('End');
    await waitFor('following', () => status().includes('Live'));
    // The ruler during the tail: it keeps up and the button stays pressed.
    const rulerCount = Number(ruler().dataset.count);
    await act('bulk 300');
    await waitFor('the ruler follows the tail', () =>
      Number(ruler().dataset.count) >= rulerCount + 300 &&
      ruler().querySelector('button.to-end').getAttribute('aria-pressed') === 'true',
    );
    await waitFor('the bookmark stays while the file grows', () => pin('bookmark')?.line === 0);
    // More lines than pixels now: the stack trace fills its pixels, the lone error line only part of one,
    // and it still has its mark.
    await waitFor('density: the stack trace is dense, the lone error is light but marked', () => {
      const errors = rulerMarks().filter((m) => m.level === 'ERROR');
      return Number(ruler().dataset.count) > track().clientHeight &&
        errors.some((m) => m.percent === 100) && errors.some((m) => m.percent < 100);
    });

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
    await waitFor('a new epoch clears the bookmarks', () => !pin('bookmark') && !$('.lt-gutter.bookmark'));
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

    // Prompt 021: shortcuts are actions of a keymap. `?` shows them, Cmd/Ctrl+Shift+K edits them: Freeze from P to K,
    // stored in the settings (survives a restart), reset brings P back. Menu accelerators are not covered here.
    const scDialog = () => $('app-shortcut-dialog dialog[open]');
    const scRow = (id) => $(`app-shortcut-dialog li[data-action="${id}"]`);
    const scKeys = (id) => [...scRow(id).querySelectorAll('kbd')].map((k) => k.textContent.trim()).join(',');
    const scButton = (id, text) => [...scRow(id).querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    const scKey = (key, options = {}) =>
      scDialog().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
    press('?', { shiftKey: true });
    await waitFor('? shows the shortcuts as an overview', () =>
      scDialog() && $$('app-shortcut-dialog li[data-action]').length >= 45 && scKeys('TOGGLE_FREEZE') === 'P' &&
      !scButton('TOGGLE_FREEZE', 'Aufnehmen') && button('Bearbeiten'));
    scKey('p');
    await sleep(200);
    await waitFor('P in the overview does not freeze the log behind it', () => pill() === 'Live');
    scDialog().close();
    await waitFor('overview closed', () => !scDialog());
    press('k', { metaKey: true, shiftKey: true });
    await waitFor('Cmd/Ctrl+Shift+K opens the editor', () => scDialog() && scButton('TOGGLE_FREEZE', 'Aufnehmen'));
    click(scButton('TOGGLE_FREEZE', 'Aufnehmen'));
    await waitFor('recording', () => scRow('TOGGLE_FREEZE').textContent.includes('Tasten drücken'));
    scKey('t', { code: 'KeyT' });
    await waitFor('T is taken: the editor asks', () =>
      $('app-shortcut-dialog .ask')?.textContent.includes('belegt durch „Spalten oder Rohzeilen“'));
    click($$('app-shortcut-dialog .ask button').find((b) => b.textContent.trim() === 'Abbrechen'));
    await waitFor('cancelled: Freeze keeps P', () => !$('app-shortcut-dialog .ask') && scKeys('TOGGLE_FREEZE') === 'P');
    click(scButton('TOGGLE_FREEZE', 'Aufnehmen'));
    scKey('Escape');
    await waitFor('Esc stops recording, the dialog stays', () =>
      scDialog() && !scRow('TOGGLE_FREEZE').textContent.includes('Tasten drücken'));
    click(scButton('TOGGLE_FREEZE', 'Aufnehmen'));
    scKey('k', { code: 'KeyK' });
    await waitFor('K recorded for Freeze', () =>
      scKeys('TOGGLE_FREEZE') === 'K' && scButton('TOGGLE_FREEZE', 'Zurücksetzen'));
    scDialog().close();
    await waitFor('editor closed', () => !scDialog());
    press('p');
    await sleep(300);
    await waitFor('P does nothing any more', () => pill() === 'Live');
    press('k');
    await waitFor('K freezes', () => pill() === 'Eingefroren');
    press('k');
    await waitFor('K resumes', () => pill() !== 'Eingefroren');
    await sleep(800);
    await act('expectsettings "keymap"|"TOGGLE_FREEZE"|"K"');
    press('k', { metaKey: true, shiftKey: true });
    await waitFor('editor open again', () => scDialog() && scButton('TOGGLE_FREEZE', 'Zurücksetzen'));
    click(scButton('TOGGLE_FREEZE', 'Zurücksetzen'));
    await waitFor('reset brings P back', () =>
      scKeys('TOGGLE_FREEZE') === 'P' && !scButton('TOGGLE_FREEZE', 'Zurücksetzen'));
    scDialog().close();
    await waitFor('editor closed again', () => !scDialog());
    press('p');
    await waitFor('P freezes again', () => pill() === 'Eingefroren');
    press('p');
    await waitFor('P resumes again', () => pill() !== 'Eingefroren');
    press('End');
    await waitFor('following after the shortcuts', () => pill() === 'Live');
    search('typed');
    keyOn($('input[type=search]'), 'Escape');
    await waitFor('Esc in the search field clears it (a field action)', () => searchValue() === '');
    await sleep(400);

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

    // Extracted fields (prompt 011): a hint after opening, suggestions accepted, value in the column, rule deleted,
    // a rule from marked text through the form. Without reading the file again.
    click(button('Pfad'));
    await waitFor('path dialog for the metrics file', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/metrics.log').requestSubmit();
    await waitFor('metrics file is open', () => tabOf('metrics.log') && rowTexts().some((t) => t.includes('cpu=')));
    let metricsId = null;
    for (let id = 1; id < 40 && metricsId === null; id++) {
      const stats = await invoke('get_stats', { sessionId: id }).catch(() => null);
      if (stats?.totalLines === 300) metricsId = id;
    }
    if (metricsId === null) throw new Error('metrics session not found');
    const metricsColumns = () => invoke('get_columns', { sessionId: metricsId });
    const metricsBefore = await invoke('get_stats', { sessionId: metricsId });
    const fieldHint = () => $$('app-status-bar button').find((b) => b.textContent.includes('erkannt'));
    await waitFor('status bar hints at fields, no dialog by itself', () =>
      /\d+ Felder erkannt/.test(fieldHint()?.textContent ?? '') && !$('app-fields-dialog'),
    );
    click(fieldHint());
    const suggestionNames = () =>
      $$('app-fields-dialog tr.suggestion input.name').map((i) => i.value).sort().join(',');
    await waitFor('suggestions: cpu, mem, took, all ticked', () =>
      $('app-fields-dialog dialog')?.open &&
      suggestionNames() === 'cpu,mem,took' &&
      $$('app-fields-dialog tr.suggestion input[type=checkbox]').every((c) => c.checked),
    );
    await waitFor('the hint is gone once seen', () => !fieldHint());
    click(button('Ausgewählte übernehmen'));
    await waitFor('rules listed in the dialog', () => $$('app-fields-dialog tr.rule').length === 3);
    let fieldSet = await metricsColumns();
    const fieldKinds = Object.fromEntries(fieldSet.columns.filter((c) => c.rule).map((c) => [c.id, c.kind]));
    if (fieldKinds.cpu !== 'percent' || fieldKinds.mem !== 'size' || fieldKinds.took !== 'duration') {
      throw new Error(`extracted kinds: ${JSON.stringify(fieldKinds)}`);
    }
    const [firstHead] = await invoke('get_lines', { sessionId: metricsId, view: 'all', start: 0, count: 1 });
    const cpuIndex = fieldSet.columns.findIndex((c) => c.id === 'cpu');
    const cpuValue = firstHead.text.slice(...firstHead.fields[cpuIndex]);
    if (!/^\d+\.\d%$/.test(cpuValue) || !firstHead.text.includes(`cpu=${cpuValue}`)) {
      throw new Error(`cpu of the first line: ${cpuValue}`);
    }
    const metricsAfter = await invoke('get_stats', { sessionId: metricsId });
    if (metricsAfter.epoch !== metricsBefore.epoch || metricsAfter.totalLines !== metricsBefore.totalLines) {
      throw new Error('accepting the rules read the file again');
    }
    await report(`PASS accepted fields without reading again: cpu of the first line ${cpuValue}`);
    $('app-fields-dialog dialog').close();
    await waitFor('fields dialog closed', () => !$('app-fields-dialog'));
    if (columnsButton().getAttribute('aria-pressed') !== 'true') press('t');
    const scrollTableTo = (x) => {
      scroller().scrollLeft = x;
      scroller().dispatchEvent(new Event('scroll'));
    };
    const cpuCell = () => $$('.lt-cell[data-col=cpu]:not(.lt-spanned)').find((c) => /^\d+\.\d%$/.test(c.textContent));
    await waitFor('the column shows the value, right-aligned', () => {
      scrollTableTo(scroller().scrollWidth);
      return (
        cpuCell() &&
        $$(".lt-cell.lt-num[data-col]").some((c) => ["cpu", "mem", "took"].includes(c.dataset.col) && getComputedStyle(c).textAlign === "right")
      );
    });
    scrollTableTo(0);

    click(button('ƒ Felder'));
    await waitFor('fields dialog from the toolbar lists the rules', () =>
      $('app-fields-dialog dialog')?.open && $$('app-fields-dialog tr.rule').length === 3,
    );
    click($('app-fields-dialog button[aria-label="Regel cpu löschen"]'));
    await waitFor('rule deleted: two left', () => $$('app-fields-dialog tr.rule').length === 2);
    fieldSet = await metricsColumns();
    if (fieldSet.columns.some((c) => c.id === 'cpu')) throw new Error('cpu column still there');
    await report('PASS rule deleted, its column is gone');

    // From marked text, the form way: the marked value typed in, pattern built, preview, created.
    const setField = (selector, text) => {
      const input = $(selector);
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const fieldSample = $('app-fields-dialog #fields-sample').value;
    const cpuMarked = /cpu=(\d+\.\d)%/.exec(fieldSample)?.[1];
    if (!cpuMarked) throw new Error(`no cpu in the sample line: ${fieldSample}`);
    setField('app-fields-dialog #fields-marked', cpuMarked);
    click(button('Muster bauen'));
    await waitFor('pattern built from the marked value', () =>
      $('app-fields-dialog #fields-draft-pattern')?.value.includes('cpu=') &&
      $('app-fields-dialog #fields-draft-name')?.value === 'cpu',
    );
    await waitFor('preview finds the value in the loaded lines', () =>
      /Treffer in [1-9]\d* von \d+ geladenen Zeilen/.test($('app-fields-dialog .preview')?.textContent ?? ''),
    );
    setField('app-fields-dialog #fields-draft-pattern', 'cpu=[\\d.]+%');
    await waitFor('a pattern without a group is refused by the backend', () =>
      /Regel ungültig|group/.test($('app-fields-dialog .preview .error')?.textContent ?? ''),
    );
    setField('app-fields-dialog #fields-draft-pattern', 'cpu=([\\d.]+)%');
    await waitFor('valid again', () => /Treffer in [1-9]/.test($('app-fields-dialog .preview')?.textContent ?? ''));
    click(button('Als Spalte anlegen'));
    await waitFor('rule from the marked text listed', () => $$('app-fields-dialog tr.rule').length === 3);
    fieldSet = await metricsColumns();
    const createdColumn = fieldSet.columns.find((c) => c.id === 'cpu');
    if (createdColumn?.kind !== 'percent') throw new Error(`created column: ${JSON.stringify(createdColumn)}`);
    await report('PASS column from marked text through the form');
    $('app-fields-dialog dialog').close();
    await waitFor('fields dialog closed again', () => !$('app-fields-dialog'));
    click(tabOf('metrics.log').parentElement.querySelector('.close'));
    await waitFor('metrics tab closed', () => !tabOf('metrics.log'));

    // Merge (prompt 006): two files into one tab in time order, source in the gutter, source filter, live.
    click(button('Pfad'));
    await waitFor('path dialog for merge-a', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/merge-a.log').requestSubmit();
    await waitFor('merge-a is open', () => tabOf('merge-a.log') && !$('app-open-path-dialog'));
    click(button('Pfad'));
    await waitFor('path dialog for merge-b', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/merge-b.log').requestSubmit();
    await waitFor('merge-b is open', () => tabOf('merge-b.log') && !$('app-open-path-dialog'));
    press('m', { metaKey: true, shiftKey: true });
    await waitFor('merge dialog opens', () => $('app-merge-dialog dialog')?.open);
    const mergeBox = (name) =>
      $$('app-merge-dialog .open-tab').find((l) => l.textContent.includes(name))?.querySelector('input');
    const submitMerge = () => $('app-merge-dialog button[type=submit]');
    for (const name of ['merge-a.log', 'plain.log']) click(mergeBox(name));
    await waitFor('a file without timestamps is refused at that file', () =>
      $$('app-merge-dialog .entries li.failed').some((li) => li.textContent.includes('Keine Zeitstempel')) &&
      submitMerge().disabled,
    );
    click($$('app-merge-dialog .entries li.failed')[0].querySelector('.remove'));
    click(mergeBox('merge-b.log'));
    await waitFor('both files with their profile and time span', () =>
      $$('app-merge-dialog .entries li').length === 2 &&
      $$('app-merge-dialog .times').every((t) => t.textContent.includes('2026-01-15')) &&
      !submitMerge().disabled,
    );
    click(submitMerge());
    await waitFor('merge tab opens', () => tabOf('Merge (2 Dateien)') && !$('app-merge-dialog'));
    // Raw view: one text cell per row.
    await waitFor('merge columns known', () => !columnsButton().disabled);
    if (columnsButton().getAttribute('aria-pressed') === 'true') press('t');
    await waitFor('raw view for the merge', () => !$('.lt-col'));
    const merged = ['a1', 'b2', 'a3', 'b4', 'Traceback', 'ValueError', 'a5'];
    await waitFor('entries in time order, the stack trace with its head', () =>
      merged.every((word, i) => rowTexts()[i]?.includes(word)),
    );
    const gutters = () => inView($$('app-log-table-view .lt-gutter.lt-src')).map((g) => g.textContent);
    await waitFor('the gutter names the source of each line', () =>
      gutters()[0]?.startsWith('merge-a.log') && gutters()[1]?.startsWith('merge-b.log'),
    );
    await waitFor('status bar: mixed encoding', () => status().includes('gemischt'));
    const sourceChip = (name) => $$('.chip.src').find((c) => c.textContent.includes(name));
    click(sourceChip('merge-b.log'));
    await waitFor('source filter: only merge-a', () =>
      rowTexts().length === 3 && gutters().every((g) => g.startsWith('merge-a.log')),
    );
    click(sourceChip('merge-b.log'));
    await waitFor('source filter lifted', () => rowTexts().length === 7);
    await waitFor('the profile cannot be changed for a merge', () => $('select[aria-label=Profil]').disabled);

    // Live: 5000 lines/s next to 20 lines/s, the busy file rotates every 20 000 lines.
    let mergeId = null;
    for (let id = 1; id < 30 && mergeId === null; id++) {
      const stats = await invoke('get_stats', { sessionId: id }).catch(() => null);
      if (stats?.sources?.length === 2) mergeId = id;
    }
    if (mergeId === null) throw new Error('merge session not found');
    await act('genstart');
    const start = Date.now();
    let stats;
    while (Date.now() - start < 20000) {
      stats = await invoke('get_stats', { sessionId: mergeId });
      if (stats.sources[0].lines > 25000 && stats.sources[1].lines > 20) break;
      await sleep(200);
    }
    await act('genstop');
    if (!(stats.sources[0].lines > 25000 && stats.sources[1].lines > 20)) {
      throw new Error(`live merge stalled: ${JSON.stringify(stats.sources)}`);
    }
    await report(`PASS live merge: ${stats.sources.map((s) => s.lines).join(' + ')} lines, rotation kept the old lines`);
    await sleep(1500);
    stats = await invoke('get_stats', { sessionId: mergeId });
    const lastLines = await invoke('get_lines', {
      sessionId: mergeId,
      view: 'all',
      start: Math.max(0, stats.totalLines - 5000),
      count: 5000,
    });
    const timeOf = (text) => {
      const m = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})[.,](\d{3})(Z?)/);
      if (!m) return null;
      return Date.parse(`${m[1]}T${m[2]}.${m[3]}${m[4]}`);
    };
    let previous = -Infinity;
    let inversions = 0;
    for (const line of lastLines) {
      if (line.isContinuation) continue;
      const t = timeOf(line.text);
      if (t === null) continue;
      if (t < previous) inversions++;
      previous = Math.max(previous, t);
    }
    const late = stats.sources.reduce((sum, s) => sum + s.lateLines, 0);
    if (inversions > late) throw new Error(`merge out of order: ${inversions} inversions, ${late} late`);
    if (!lastLines.some((l) => l.source === 1) || !lastLines.some((l) => l.source === 0)) {
      throw new Error('the last lines miss a source');
    }
    await report(`PASS live merge in time order: ${inversions} inversions, ${late} late lines`);
    await waitFor('the merge view follows the end', () => pill() === 'Live');

    // Dashboard (prompt 012): no database before a dashboard opens, then a template with the right
    // numbers (entry heads, not lines), own SQL with the engine's error, refusing writes, the log running on
    // meanwhile, a table row and a point that jump into the log.
    for (let id = 1; id < 40; id++) {
      const s = await invoke('get_stats', { sessionId: id }).catch(() => null);
      if (s?.report) throw new Error(`session ${id} has a dashboard database without a dashboard`);
    }
    await report('PASS no dashboard database dashBefore a dashboard opens');
    click(button('Pfad'));
    await waitFor('path dialog for the dashboard file', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/dash.log').requestSubmit();
    await waitFor('dash.log is open', () => tabOf('dash.log') && !$('app-open-path-dialog'));
    let dashId = 0;
    for (let id = 1; id < 40; id++) {
      if (await invoke('get_stats', { sessionId: id }).catch(() => null)) dashId = id;
    }
    await waitFor('dash.log loaded', () => rowTexts().some((t) => t.includes('Out of memory')));
    const dashLines = await invoke('get_lines', { sessionId: dashId, view: 'all', start: 0, count: 5000 });
    const dashHeads = {};
    for (const line of dashLines) if (!line.isContinuation) dashHeads[line.level] = (dashHeads[line.level] ?? 0) + 1;
    press('d', { metaKey: true, shiftKey: true });
    await waitFor('the dashboard opens over the log', () => $('app-dashboard') && $('app-log-table-view'));
    await waitFor('the log below is hidden and inert', () => $('.log-layer.behind')?.inert === true);
    await waitFor('the table is built', () => $('app-dashboard .status')?.dataset.state === 'ready', 20000);
    const dashPanel = (title) =>
      $$('app-dashboard-panel').find((p) => p.querySelector('h3')?.textContent.trim() === title);
    const chartOf = (title) => dashPanel(title)?.querySelector('.rc[data-ready="1"]');
    const sumsOf = (title) => JSON.parse(chartOf(title)?.dataset.sums ?? '{}');
    const levelsTitle = 'Einträge je Level je Minute';
    await waitFor('template „Einträge je Level“ is drawn', () => chartOf(levelsTitle));
    await waitFor('its numbers are the entry heads per level', () => {
      const sums = sumsOf(levelsTitle);
      return (
        Object.keys(dashHeads).every((level) => sums[level] === dashHeads[level]) &&
        Object.keys(sums).length === Object.keys(dashHeads).length
      );
    });
    if (count('ERROR') <= sumsOf(levelsTitle).ERROR) throw new Error('stack trace lines counted as errors');
    await report(`PASS heads per level ${JSON.stringify(sumsOf(levelsTitle))}, ERROR lines ${count('ERROR')}`);

    // Own SQL: the engine's message at the panel, writes refused, bars without a time axis.
    const panelsBefore = $$('app-dashboard-panel').length;
    click(button('+ Panel'));
    await waitFor('a new panel', () => $$('app-dashboard-panel').length === panelsBefore + 1);
    const dashFresh = $$('app-dashboard-panel').at(-1);
    click(dashFresh.querySelector('button.edit'));
    await waitFor('editor open', () => dashFresh.querySelector('textarea'));
    const runSql = (sql) => {
      const area = dashFresh.querySelector('textarea');
      area.value = sql;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    };
    runSql('SELECT nope FROM log');
    await waitFor('the engine says what is wrong', () =>
      dashFresh.querySelector('.error')?.textContent.includes('no such column: nope'),
    );
    runSql('DELETE FROM log');
    await waitFor('a write is refused', () =>
      /Nicht erlaubt|Nur lesende/.test(dashFresh.querySelector('.error')?.textContent ?? ''),
    );
    runSql('SELECT level, count(*) AS n FROM log GROUP BY level ORDER BY n DESC');
    await waitFor(
      'own SQL without a time axis draws bars',
      () => !dashFresh.querySelector('.error') && dashFresh.querySelector('.rc[data-ready="1"]')?.dataset.kind === 'bars',
    );
    const countRows = async () =>
      (await invoke('run_report', { sessionId: dashId, sql: 'SELECT count(*) FROM log', slot: 'e2e' })).rows[0][0];
    const headCount = Object.values(dashHeads).reduce((a, b) => a + b, 0);
    if ((await countRows()) !== headCount) throw new Error('rows changed');
    await report('PASS nothing was deleted');

    // The log runs on below the dashboard; the table follows within the catch-up.
    const dashBefore = await invoke('get_stats', { sessionId: dashId });
    await act('appenddash 2026-01-15T10:00:10.000+01:00 ERROR 4711 --- [main] c.a.X : dashboard live');
    const liveStart = Date.now();
    for (;;) {
      const s = await invoke('get_stats', { sessionId: dashId });
      if (s.totalLines === dashBefore.totalLines + 1 && s.report.rows === dashBefore.report.rows + 1) break;
      if (Date.now() - liveStart > 12000) throw new Error(`no catch-up: ${JSON.stringify(s.report)}`);
      await sleep(100);
    }
    await report(`PASS log read on and the table caught up after ${Date.now() - liveStart} ms`);
    await waitFor(
      'the template shows the new error (live refresh)',
      () => sumsOf(levelsTitle).ERROR === dashHeads.ERROR + 1,
      15000,
    );

    // A row of „Letzte Fehler“ jumps to its line.
    const errorsPanel = dashPanel('Letzte Fehler');
    await waitFor('table of the last errors', () => errorsPanel.querySelector('tr.link'));
    errorsPanel.querySelector('button[aria-label="Neu ausführen"]').click();
    await waitFor('the new error is the first row', () =>
      errorsPanel.querySelector('tr.link td')?.textContent.trim() === String(dashBefore.totalLines + 1),
    );
    const dashTarget = dashBefore.totalLines + 1;
    click(errorsPanel.querySelector('tr.link'));
    await waitFor('the row jumps into the log', () =>
      !$('app-dashboard') && rows().some((c) => Number(c.dataset.line) === dashTarget - 1),
    );

    // Keyboard on a chart: → picks the first point, Enter jumps to the first line of that minute.
    press('d', { metaKey: true, shiftKey: true });
    await waitFor('dashboard again', () => chartOf(levelsTitle));
    const dashChart = chartOf(levelsTitle);
    dashChart.focus();
    dashChart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    dashChart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor('the point jumps to the first line of its minute', () =>
      !$('app-dashboard') && rows().some((c) => Number(c.dataset.line) === 0),
    );

    // Filter tabs (prompt 013): ERROR+ of dash.log as a tab of its own, filtered further there; the parent changes
    // and the child follows; the tail feeds both; closing the child leaves the parent running.
    const dashStats = (viewId) => invoke('get_stats', { sessionId: dashId, viewId });
    click(button('ERROR+'));
    for (let i = 0; i < 100 && (await dashStats(0)).filteredLines === (await dashStats(0)).totalLines; i++) await sleep(50);
    press('t', { metaKey: true, shiftKey: true });
    await waitFor('⌘⇧T opens a filter tab right of its parent', () => {
      const active = $('.tab.active');
      const prev = active?.previousElementSibling;
      return active?.classList.contains('view') && prev?.textContent.includes('dash.log') &&
        active.querySelector('.title').title.includes('dash.log › ERROR, FATAL');
    });
    let childView = 0;
    for (let v = 1; v <= 8 && !childView; v++) if (await dashStats(v).catch(() => null)) childView = v;
    if (!childView) throw new Error('no view of the filter tab in the backend');
    search('dashboard live');
    await waitFor('the filter tab filters the parent further', () =>
      rows().length === 1 && rowTexts()[0].includes('dashboard live') &&
      $('.tab.active .title').textContent.includes('dashboard live'));
    const parentBefore = await dashStats(0);
    await act('appenddash 2026-01-15T10:00:11.000+01:00 ERROR 4711 --- [main] c.a.X : dashboard live two');
    await waitFor('the tail runs in the filter tab', () =>
      rows().length === 2 && rowTexts()[1].includes('dashboard live two'));
    for (let i = 0; ; i++) {
      const s = await dashStats(0);
      if (s.filteredLines === parentBefore.filteredLines + 1) break;
      if (i > 200) throw new Error(`parent did not follow the tail: ${JSON.stringify(s)}`);
      await sleep(50);
    }
    await report('PASS the tail runs in the parent, too');
    // The parent hides ERROR: the child follows (its result is a part of the parent's).
    click(tabOf('dash.log'));
    await waitFor('back on the parent tab', () => !$('.tab.active').classList.contains('view'));
    click(chip('ERROR'));
    for (let i = 0; ; i++) {
      const s = await dashStats(childView);
      if (!s.filterPending && s.filteredLines === 0) break;
      if (i > 200) throw new Error(`child did not follow its parent: ${JSON.stringify(s)}`);
      await sleep(50);
    }
    await report('PASS the filter tab follows a change of its parent');
    click(chip('ERROR'));
    for (let i = 0; ; i++) {
      const s = await dashStats(childView);
      if (!s.filterPending && s.filteredLines === 2) break;
      if (i > 200) throw new Error(`child did not come back: ${JSON.stringify(s)}`);
      await sleep(50);
    }
    await report('PASS and back');
    click($('.tab.view .close'));
    await waitFor('the filter tab closes', () => !$('.tab.view') && $('.tab.active')?.textContent.includes('dash.log'));
    if (await dashStats(childView).then(() => true, () => false)) throw new Error('the view is still open');
    const afterClose = await dashStats(0);
    await act('appenddash 2026-01-15T10:00:12.000+01:00 ERROR 4711 --- [main] c.a.X : after the filter tab');
    for (let i = 0; ; i++) {
      const s = await dashStats(0);
      if (s.totalLines === afterClose.totalLines + 1) break;
      if (i > 200) throw new Error('the parent stopped after closing its filter tab');
      await sleep(50);
    }
    await report('PASS closing the filter tab leaves the parent live, without error');
    if ($('[role=alert]')?.textContent.trim()) throw new Error(`error shown: ${$('[role=alert]').textContent}`);

    // Timeline (prompt 014): gap.log has one entry a second from 09:00:00Z and 47 minutes of silence after
    // 09:04:59. The outage is there, a click jumps to the right time, a dragged window filters the tab.
    click(button('Pfad'));
    await waitFor('path dialog for the timeline file', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/gap.log').requestSubmit();
    await waitFor('gap.log is open', () => tabOf('gap.log') && !$('app-open-path-dialog'));
    const tlStrip = () => $('app-timeline');
    const tlAt = (iso) => Date.parse(iso) * 1000;
    await waitFor('the timeline counts every entry', () => Number(tlStrip()?.dataset.entries) === 600);
    const tlOutage = await waitFor('the outage is found', () => {
      const list = (tlStrip().dataset.outages ?? '').split(',').filter(Boolean).map((g) => g.split(':').map(Number));
      return list.length === 1 ? list[0] : null;
    });
    // Inside a chunk of lines the backend knows the outage to its sampled heads (every 32 lines).
    if (tlOutage[0] < tlAt('2026-01-15T09:04:00Z') || tlOutage[0] > tlAt('2026-01-15T09:06:30Z') ||
      tlOutage[1] < tlAt('2026-01-15T09:50:30Z') || tlOutage[1] > tlAt('2026-01-15T09:52:01Z')) {
      throw new Error(`outage at the wrong time: ${tlOutage.map((t) => new Date(t / 1000).toISOString())}`);
    }
    const tlTrack = $('app-timeline .track');
    if (!/Lücke/.test(tlTrack.getAttribute('aria-label'))) {
      throw new Error(`summary without the gap: ${tlTrack.getAttribute('aria-label')}`);
    }
    await report(`PASS outage ${new Date(tlOutage[0] / 1000).toISOString()} – ${new Date(tlOutage[1] / 1000).toISOString()}`);
    const tlAxis = () => [Number(tlStrip().dataset.from), Number(tlStrip().dataset.to)];
    const tlXOfTime = (ts) => {
      const [from, to] = tlAxis();
      return Math.round(((ts - from) / (to - from)) * tlTrack.clientWidth);
    };
    const tlTimeOfX = (x) => {
      const [from, to] = tlAxis();
      return from + (x / tlTrack.clientWidth) * (to - from);
    };
    const tlMouse = (type, x, target = tlTrack) =>
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: tlTrack.getBoundingClientRect().left + x,
        clientY: tlTrack.getBoundingClientRect().top + 10,
      }));
    const tlRowTime = (text) => {
      const m = text.match(/2026-01-15T\d\d:\d\d:\d\d\.\d{3}Z/);
      return m ? Date.parse(m[0]) * 1000 : null;
    };
    // A click jumps to the first entry at or after the time under the pointer.
    const tlClickX = tlXOfTime(tlAt('2026-01-15T09:53:20Z'));
    const tlWanted = Math.ceil(tlTimeOfX(tlClickX) / 1e6) * 1e6;
    tlMouse('mousedown', tlClickX);
    tlMouse('mouseup', tlClickX, window);
    await waitFor('a click jumps to its time', () =>
      rows().some((c) => tlRowTime(c.textContent) === tlWanted));
    await waitFor('the jump stops following', () => !$('app-overview-ruler .to-end[aria-pressed=true]'));
    // Keyboard: Home and Enter go to the first bucket, the start of the file.
    tlTrack.focus();
    tlTrack.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    tlTrack.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor('Home and Enter on the timeline jump to the start', () => topLine() === 0);
    // A dragged window as a filter of this tab.
    const tlX1 = tlXOfTime(tlAt('2026-01-15T09:52:30Z'));
    const tlX2 = tlXOfTime(tlAt('2026-01-15T09:53:30Z'));
    tlMouse('mousedown', tlX1);
    tlMouse('mousemove', tlX2, window);
    tlMouse('mouseup', tlX2, window);
    const tlWin = await waitFor('a drag marks a window', () => tlStrip().dataset.window?.split(':').map(Number));
    click(button('Als Filter'));
    const tlGapId = await (async () => {
      for (let id = 1; id < 60; id++) {
        const first = await invoke('get_lines', { sessionId: id, view: 'all', start: 0, count: 1 }).catch(() => null);
        if (first?.[0]?.text.startsWith('2026-01-15T09:00:00.000Z')) return id;
      }
      throw new Error('no session of gap.log');
    })();
    for (let i = 0; ; i++) {
      const s = await invoke('get_stats', { sessionId: tlGapId });
      if (!s.filterPending && s.filteredLines > 0 && s.filteredLines < s.totalLines) break;
      if (i > 200) throw new Error(`the time filter did not apply: ${JSON.stringify(s)}`);
      await sleep(50);
    }
    await waitFor('the time filter keeps only the window', () => {
      const times = rows().map((c) => tlRowTime(c.textContent)).filter((t) => t !== null);
      const from = Math.floor(tlWin[0] / 1e6) * 1e6;
      const to = Math.ceil(tlWin[1] / 1e6) * 1e6;
      return times.length > 20 && times.every((t) => t >= from && t <= to);
    });
    // The timeline still shows the whole file.
    if (Number(tlStrip().dataset.entries) !== 600) throw new Error('the timeline lost entries under a filter');
    // Z hides it, Z brings it back.
    press('z');
    await waitFor('Z hides the timeline', () => !tlStrip());
    press('z');
    await waitFor('Z shows it again', () => Number(tlStrip()?.dataset.entries) === 600);
    if ($('[role=alert]')?.textContent.trim()) throw new Error(`error shown: ${$('[role=alert]').textContent}`);

    // ---- Prompt 015: export, notes, workspace. Native dialogs are not covered: the scenario puts the paths into
    // `window.__lcDialogPaths` (core/dialog/native-dialog.ts); the harness checks the files it finds.
    const wsDialogPaths = (...paths) => {
      window.__lcDialogPaths = paths;
    };
    const wsPins = () => $('app-overview-ruler')?.dataset.pins || '';
    const wsButton = (text) =>
      [...($('app-workspace-dialog')?.querySelectorAll('button') ?? [])].find((b) =>
        b.textContent.trim().startsWith(text),
      );
    while (tabs().length) {
      click(tabs()[0].parentElement.querySelector('.close'));
      await sleep(40);
    }
    await waitFor('every tab closed before the workspace test', () => !tabs().length && $('app-start-screen'));
    click(button('Pfad eingeben'));
    await waitFor('path dialog for the workspace test', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/metrics.log').requestSubmit();
    await waitFor('metrics.log open again', () => tabOf('metrics.log') && rowTexts().some((t) => t.includes('cpu=')));
    const wsLog = tabOf('metrics.log').title.split('\n')[0];
    const wsSep = wsLog.includes('\\') ? '\\' : '/';
    const wsDir = wsLog.slice(0, wsLog.lastIndexOf(wsSep));
    let wsId = null;
    for (let id = 80; id >= 1 && wsId === null; id--) {
      const info = await invoke('get_stats', { sessionId: id }).catch(() => null);
      if (info?.totalLines === 300) wsId = id;
    }
    if (wsId === null) throw new Error('metrics session not found');

    // Export through the command with a fixed path: progress over a channel, the file next to the log.
    const wsChannel = (onMessage) =>
      `__CHANNEL__:${window.__TAURI_INTERNALS__.transformCallback((raw) =>
        onMessage(raw && typeof raw === 'object' && 'message' in raw ? raw.message : raw),
      )}`;
    const exportRun = (args) =>
      new Promise((resolve, reject) => {
        const onProgress = wsChannel((p) => {
          if (p && p.state && p.state !== 'running') resolve(p);
        });
        invoke('export_view', { ...args, onProgress }).catch(reject);
      });
    const csvDone = await exportRun({
      sessionId: wsId,
      viewId: 0,
      range: { kind: 'all' },
      format: 'csv',
      columns: null,
      targetPath: `${wsDir}${wsSep}export.csv`,
    });
    if (csvDone.state !== 'done' || csvDone.lines !== 300) throw new Error(`export: ${JSON.stringify(csvDone)}`);
    await report('PASS export command writes 300 lines as CSV');
    await act('expectfile export.csv|"line","level","text"|cpu=');
    await act('expectnofile .part');
    const refused = await invoke('export_view', {
      sessionId: wsId,
      viewId: 0,
      range: { kind: 'all' },
      format: 'txt',
      columns: null,
      targetPath: wsLog,
      onProgress: wsChannel(() => {}),
    }).then(
      () => null,
      (e) => e,
    );
    if (refused?.code !== 'invalid_export') throw new Error(`the log itself as target: ${JSON.stringify(refused)}`);
    await report('PASS the open log is refused as export target');
    // The dialog with a scripted save path: JSON Lines of the view.
    press('e', { metaKey: true, shiftKey: true });
    await waitFor('Cmd+Shift+E opens the export dialog', () => $('app-export-dialog dialog')?.open);
    click($('app-export-dialog input[name=format][value=jsonl]'));
    wsDialogPaths(`${wsDir}${wsSep}view`);
    $('app-export-dialog form').requestSubmit();
    await waitFor(
      'the export finishes, the status bar says so',
      () => !$('app-export-dialog') && status().includes('Exportiert: view.jsonl'),
      20000,
    );
    await act('expectfile view.jsonl|"line":1,|"level":"');

    // A filter, a filter tab, a bookmark and a note; then the workspace.
    click(chip('INFO'), { altKey: true });
    await waitFor('INFO only', () => rows().length > 3 && rows().every((r) => r.classList.contains('lv-INFO')));
    const wsRow = rows()[2];
    const wsLine = Number(wsRow.dataset.line);
    click(wsRow);
    await waitFor('row selected for the marks', () => $(`.lt-cell.selected[data-line="${wsLine}"]`));
    press('m');
    press('M', { shiftKey: true });
    await waitFor('Shift+M opens the note dialog', () => $('app-note-dialog dialog')?.open);
    const noteArea = $('app-note-dialog textarea');
    noteArea.value = 'Hier wird es langsam: `took` {code}';
    noteArea.dispatchEvent(new Event('input', { bubbles: true }));
    noteArea.form.requestSubmit();
    await waitFor(
      'the note shows in the gutter and on the ruler, next to the bookmark',
      () =>
        !$('app-note-dialog') &&
        $(`.lt-gutter.note[data-line="${wsLine}"]`) &&
        wsPins().includes(`note:${wsLine}:`) &&
        wsPins().includes(`bookmark:${wsLine}:`),
    );
    press('t', { metaKey: true, shiftKey: true });
    await waitFor('a filter tab below metrics.log', () => tabs().length === 2);
    search('took');
    await waitFor('the filter tab searches', () => tabs()[1]?.textContent.includes('took'), 20000);
    const columnsButtonOn = () => button('▦ Spalten');
    const columnsOn = () => columnsButtonOn()?.getAttribute('aria-pressed') === 'true';
    // Raw lines, set on the file's tab (it is in front when saved).
    click(tabs()[0]);
    await waitFor('the file tab knows its columns', () => !columnsButtonOn().disabled);
    if (columnsOn()) press('t');
    await waitFor('raw lines for the workspace', () => !columnsOn() && !columnsButtonOn().disabled);
    wsDialogPaths(`${wsDir}${wsSep}case`);
    click(button('❖ Speichern'));
    await waitFor('workspace saved', () => status().includes('Arbeitsstand gespeichert: case.lcw'));
    await act(
      'expectfile case.lcw|"format": "log-commander-workspace"|"relPath": "metrics.log"|Hier wird es langsam|"text": "took"|"columnMode": "raw"',
    );

    // Back to nothing: columns on, every tab closed. Then open it from the recent files.
    press('t');
    await waitFor('columns again', () => columnsOn());
    while (tabs().length) {
      click(tabs()[0].parentElement.querySelector('.close'));
      await sleep(40);
    }
    await waitFor('start screen lists the workspace with its symbol', () =>
      $$('app-start-screen .recent').some((b) => b.textContent.includes('case.lcw') && b.querySelector('.ws')),
    );
    click($$('app-start-screen .recent').find((b) => b.textContent.includes('case.lcw')));
    // Nothing of a workspace is touched before the user agrees (security review of 015).
    await waitFor(
      'the workspace asks which files to open, layouts not taken over by default',
      () =>
        $('app-workspace-dialog')?.textContent.includes('metrics.log') &&
        !tabs().length &&
        $('app-workspace-dialog .layouts input')?.checked !== true,
    );
    click(wsButton('Öffnen'));
    await waitFor(
      'the workspace brings both tabs back',
      () => tabs().length === 2 && tabOf('metrics.log') && tabs()[1].textContent.includes('took'),
      20000,
    );
    click(tabs()[1]);
    await waitFor('the filter tab searches again', () => $('input[type=search]').value === 'took');
    click(tabs()[0]);
    await waitFor(
      'the file tab shows INFO only',
      () => chip('INFO').getAttribute('aria-pressed') === 'true' && chip('ERROR').getAttribute('aria-pressed') === 'false',
    );
    await waitFor('raw lines again', () => !columnsOn() && !columnsButtonOn().disabled);
    await waitFor(
      'bookmark, note and selection are back on their line',
      () =>
        wsPins().includes(`bookmark:${wsLine}:`) &&
        wsPins().includes(`note:${wsLine}:`) &&
        wsPins().includes(`selection:${wsLine}:`),
      20000,
    );
    press('t');

    // A workspace from elsewhere: a missing file is skipped, the other is found next to the workspace, a note that
    // does not fit is reported, a broken bookmark is dropped.
    const foreign = {
      format: 'log-commander-workspace',
      version: 2,
      files: [
        { kind: 'file', sources: [{ path: `${wsDir}${wsSep}gone.log`, relPath: 'gone.log' }], tabs: [{}] },
        { kind: 'file', sources: [{ path: '//attacker/share/a.log', relPath: 'other.log' }], tabs: [{}] },
        {
          kind: 'file',
          sources: [{ path: '/nowhere/other.log', relPath: 'other.log' }],
          tabs: [{ filter: { levels: ['ERROR'] } }],
          notes: [{ anchor: { line: 1, offset: 9, len: 5, hash: '0123456789abcdef' }, text: 'passt nicht' }],
          bookmarks: [{ anchor: { line: 0, offset: 0, len: 1e30, hash: 'bad' } }],
        },
      ],
    };
    await invoke('write_workspace', { path: `${wsDir}${wsSep}foreign.lcw`, content: JSON.stringify(foreign) });
    const wsOther = await invoke('write_workspace', { path: `${wsDir}${wsSep}evil.sh`, content: 'x' }).then(
      () => null,
      (e) => e,
    );
    if (wsOther?.code !== 'invalid_workspace') throw new Error('write_workspace wrote something else than .lcw');
    await report('PASS write_workspace writes .lcw files only');
    click(button('Pfad'));
    await waitFor('path dialog for the foreign workspace', () => $('app-open-path-dialog dialog')?.open);
    typePath('~/foreign.lcw').requestSubmit();
    await waitFor('the network path is listed and cannot be chosen', () => {
      const net = [...($('app-workspace-dialog')?.querySelectorAll('li') ?? [])].find((li) =>
        li.textContent.includes('//attacker'),
      );
      return net && net.textContent.includes('Netzwerkpfad') && net.querySelector('input').disabled;
    });
    click(wsButton('Öffnen'));
    await waitFor(
      'the missing file is listed',
      () => wsButton('Überspringen') && $('app-workspace-dialog').textContent.includes('gone.log'),
    );
    click(wsButton('Überspringen'));
    await waitFor('skipping enables „Öffnen“', () => !wsButton('Öffnen').disabled);
    click(wsButton('Öffnen'));
    await waitFor(
      'the rest opens and the report names what did not come back',
      () =>
        tabOf('other.log') &&
        $('app-workspace-dialog')?.textContent.includes('gone.log') &&
        $('app-workspace-dialog').textContent.includes('Netzwerkpfad, nicht geöffnet') &&
        $('app-workspace-dialog').textContent.includes('1 Notiz') &&
        $('app-workspace-dialog').textContent.includes('ungültige'),
      20000,
    );
    click(wsButton('Schließen'));
    await waitFor(
      'report closed, other.log filtered on ERROR',
      () =>
        !$('app-workspace-dialog') &&
        rowTexts().some((t) => t.includes('other file')) &&
        !rowTexts().some((t) => t.includes('still here')),
    );
    window.__lcDialogPaths = undefined;
    if ($('[role=alert]')?.textContent.trim()) throw new Error(`error shown: ${$('[role=alert]').textContent}`);

    // ---- Prompt 016: a syslog source on a random port, messages arrive with levels, closing deletes the spool.
    const srcDialog = () => $('app-source-dialog dialog');
    const setSrcField = (selector, value) => {
      const el = $(selector);
      el.value = value;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    press('l', { metaKey: true, shiftKey: true });
    await waitFor('„Quelle öffnen“ with Cmd/Ctrl+Shift+L', () => srcDialog()?.open);
    // Prompt 018: Windows event logs only where they exist; elsewhere invisible and refused by the backend.
    const winSupported = await invoke('winevent_supported');
    const kindOptions = [...$('#source-kind').options].map((o) => o.value);
    if (winSupported !== kindOptions.includes('winevent')) {
      throw new Error(`Windows events offered ${kindOptions.includes('winevent')}, supported ${winSupported}`);
    }
    if (!winSupported) {
      const refused = await invoke('open_source', {
        config: { kind: 'winevent', channel: 'Application' },
        keep: false,
        credentials: null,
        onUpdate: `__CHANNEL__:${window.__TAURI_INTERNALS__.transformCallback(() => {})}`,
      }).then(
        () => null,
        (e) => e,
      );
      if (refused?.code !== 'unsupported' || !refused.message.includes('nur unter Windows')) {
        throw new Error(`Windows events not refused here: ${JSON.stringify(refused)}`);
      }
      const channels = await invoke('winevent_channels', { target: { computer: '' }, credentials: null }).then(
        () => null,
        (e) => e,
      );
      if (channels?.code !== 'unsupported') throw new Error(`channel list not refused: ${JSON.stringify(channels)}`);
      if (document.body.textContent.includes('Windows-Ereignisse')) {
        throw new Error('„Windows-Ereignisse“ shows on a system without them');
      }
    }
    await report(`PASS Windows events ${winSupported ? 'offered' : 'invisible and refused'} on this system`);
    await waitFor(
      'the source listens on this computer only by default',
      () => $('#source-address').value === '127.0.0.1' && $('#source-port').value === '5514' && !$('#source-start').disabled,
    );
    setSrcField('#source-address', '0.0.0.0');
    await waitFor(
      'all interfaces: warning shown, start only after the explicit choice',
      () => $('#source-remote-warning')?.textContent.includes('andere Rechner') && $('#source-start').disabled,
    );
    $('#source-allow-remote').checked = true;
    $('#source-allow-remote').dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor('chosen explicitly: start possible', () => !$('#source-start').disabled);
    setSrcField('#source-address', '127.0.0.1');
    await waitFor('back on loopback: no warning', () => !$('#source-remote-warning'));
    setSrcField('#source-port', '514');
    await waitFor('port 514 tells about the rights it needs', () =>
      $('#source-port-note').textContent.includes('Root-Rechte'),
    );
    let srcPort = 0;
    for (let attempt = 0; attempt < 5 && !srcPort; attempt++) {
      const candidate = 20000 + Math.floor(Math.random() * 30000);
      setSrcField('#source-port', String(candidate));
      await sleep(50);
      click($('#source-start'));
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (!srcDialog()) {
          srcPort = candidate;
          break;
        }
        if (srcDialog().querySelector('[role=alert]')?.textContent.includes('Port belegt')) break;
        await sleep(30);
      }
    }
    if (!srcPort) throw new Error('no free port for the syslog source');
    const srcLabel = `Syslog :${srcPort}`;
    await waitFor('the tab shows the source, not the spool', () => {
      const tab = tabs().find((t) => t.textContent.includes(srcLabel));
      return tab && tab.querySelector('.src') && !tab.textContent.includes('spool.log');
    });
    await waitFor('status bar: listening, nothing received yet', () =>
      status().includes('Lauscht') && status().includes('0 empfangen'),
    );
    const spoolPath = $('app-status-bar .path').title.replace(/^Spool: /, '');
    if (!spoolPath.endsWith('spool.log')) throw new Error(`no spool path in the title: ${spoolPath}`);
    await report('PASS spool path in the title of the status bar');
    await act(`expectspool ${spoolPath}`);
    await act(`syslog ${srcPort} 300`);
    await waitFor('301 messages received and shown', () => status().includes('301 empfangen'), 20000);
    await waitFor(
      'levels from the priority: 101 ERROR (one multi-line), 100 WARN, 100 INFO',
      () => count('ERROR') === 101 && count('WARN') === 100 && count('INFO') === 100,
      20000,
    );
    let srcId = null;
    for (let id = 1; id < 40 && srcId === null; id++) {
      const stats = await invoke('get_stats', { sessionId: id }).catch(() => null);
      if (stats?.sourceStatus) srcId = id;
    }
    const [lastSrcLine] = await invoke('get_lines', { sessionId: srcId, view: 'all', start: 300, count: 1 });
    if (!lastSrcLine?.text.endsWith('multi line\\nsecond line') || lastSrcLine.isContinuation) {
      throw new Error(`multi-line message not one line: ${lastSrcLine?.text}`);
    }
    await report('PASS the multi-line message is one line with \\n');
    // The same port for UDP and TCP again: in use, said in the dialog with the port.
    press('l', { metaKey: true, shiftKey: true });
    await waitFor('dialog again', () => srcDialog()?.open);
    click($('input[name=protocol][value=both]'));
    setSrcField('#source-port', String(srcPort));
    await sleep(50);
    click($('#source-start'));
    await waitFor('port in use: error with the port, no crash', () =>
      srcDialog()?.querySelector('[role=alert]')?.textContent.includes(String(srcPort)),
    );
    srcDialog().close();
    await waitFor('dialog closed', () => !srcDialog());
    const srcTab = () => tabs().find((t) => t.textContent.includes(srcLabel));
    click(srcTab());
    click(srcTab().closest('.tab').querySelector('.close'));
    await waitFor('the source tab is closed', () => !srcTab());
    await act(`expectspool ${spoolPath}`.replace('expectspool', 'expectnospool'));
    await sleep(500);
    if ($('[role=alert]')?.textContent.trim()) throw new Error(`error shown: ${$('[role=alert]').textContent}`);


    // ---- Prompt 019: a SQLite database as a source: table template, preview, live rows with equal times,
    // writing queries refused, the file never written (checked by the harness).
    const dbDialog = () => $('app-database-dialog dialog');
    const setDbField = (selector, value) => {
      const el = $(selector);
      el.value = value;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    press('l', { metaKey: true, shiftKey: true });
    await waitFor('„Quelle öffnen“ again', () => srcDialog()?.open);
    setDbField('#source-kind', 'database');
    await waitFor('the kind „Datenbank“ opens its own dialog', () => dbDialog()?.open && !srcDialog());
    await waitFor(
      'TLS with certificate check by default, no warning',
      () => $('#db-tls').value === 'verify' && !$('#db-tls-warning'),
    );
    setDbField('#db-tls', 'noVerify');
    await waitFor('switching the check off shows a warning', () =>
      $('#db-tls-warning')?.textContent.includes('Zertifikatsprüfung'),
    );
    setDbField('#db-tls', 'verify');
    setDbField('#db-engine', 'sqlite');
    const dbPath = `${wsDir}${wsSep}logs.db`;
    await waitFor('SQLite asks for a file, not a server', () => $('#db-path') && !$('#db-host'));
    setDbField('#db-path', dbPath);
    await sleep(50);
    click($('#db-tables'));
    await waitFor('„Tabelle wählen“ lists the tables', () => $('#db-table')?.options.length === 2);
    setDbField('#db-table', '0');
    await waitFor('the template writes the query', () => $('#db-query').value === 'SELECT * FROM "logs"');
    // Writing queries never reach the database: refused in the dialog and by the backend.
    setDbField('#db-query', 'DELETE FROM logs');
    await waitFor(
      'a DELETE cannot be previewed or opened',
      () => $('#db-preview-button').disabled && $('#db-start').disabled,
    );
    setDbField('#db-query', 'SELECT * FROM logs; DELETE FROM logs');
    await sleep(50);
    click($('#db-preview-button'));
    await waitFor('a second statement is refused by the backend', () =>
      $('#db-error')?.textContent.includes('Nur eine Anweisung'),
    );
    const refusedWrite = await invoke('db_preview', {
      config: {
        kind: 'database',
        engine: 'sqlite',
        path: dbPath,
        query: 'SELECT * INTO hacked FROM logs',
        keyColumn: 'id',
      },
      credentials: null,
    }).then(
      () => null,
      (e) => e,
    );
    if (refusedWrite?.code !== 'invalid_query') {
      throw new Error(`SELECT … INTO not refused: ${JSON.stringify(refusedWrite)}`);
    }
    await report('PASS SELECT … INTO refused by the backend');
    setDbField('#db-query', 'SELECT * FROM logs');
    setDbField('#db-key', 'ts');
    setDbField('#db-time', '');
    setDbField('#db-level', '');
    await sleep(50);
    click($('#db-preview-button'));
    await waitFor('the preview shows the first rows, binary as a hint', () => {
      const cells = $$('#db-preview tbody td').map((td) => td.textContent);
      return (
        $$('#db-preview tbody tr').length === 3 && cells.includes('(binär, 2 Byte)') && cells.includes('db Grüße 😀')
      );
    });
    await waitFor(
      'time and level columns guessed from the result',
      () => $('#db-time').value === 'ts' && $('#db-level').value === 'level',
    );
    click($('#db-start-all'));
    setDbField('#db-interval', '0,5');
    await sleep(50);
    click($('#db-start'));
    await waitFor('opened: the dialog closed', () => !dbDialog(), 15000);
    await waitFor('the tab is db:logs with the database symbol', () => {
      const tab = tabs().find((t) => t.textContent.includes('db:logs'));
      return tab?.querySelector('.src')?.textContent.includes('⛁');
    });
    await waitFor(
      'status bar: three rows and the last query',
      () => status().includes('3 Zeilen') && status().includes('letzte Abfrage'),
      15000,
    );
    await waitFor(
      'levels from the level column',
      () => count('ERROR') === 1 && count('WARN') === 1 && count('INFO') === 1,
    );
    // New rows, one with the time of the last ones (the edge): none lost, none doubled.
    await act('dbinsert 2026-11-08T10:00:01|DEBUG|db same time again');
    await act('dbinsert 2026-11-08T10:00:02|ERROR|db later');
    await waitFor('new rows arrive live', () => status().includes('5 Zeilen'), 15000);
    await sleep(1500);
    if (!status().includes('5 Zeilen') || count('ERROR') !== 2) {
      throw new Error(`rows doubled or lost: ${status()}`);
    }
    await report('PASS equal times neither lost nor doubled');
    await act('expectdbcount 5');
    const dbTab = () => tabs().find((t) => t.textContent.includes('db:logs'));
    click(dbTab());
    click(dbTab().closest('.tab').querySelector('.close'));
    await waitFor('the database tab is closed', () => !dbTab());

    // ---- Prompt 017: a remote file over SFTP (server in the app, debug builds only): host key confirmation,
    // password, folder browser, live lines, rotation; a changed host key is refused with no way around it.
    const remoteRoot = `${wsDir}${wsSep}remote`;
    const sftpPort = await invoke('e2e_sftp_server', { root: remoteRoot, seed: 7 });
    const remDialog = () => $('app-remote-dialog dialog');
    const setRemField = (selector, value) => {
      const el = $(selector);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const remSubmit = () => $('#remote-connect').closest('form').requestSubmit();
    press('h', { metaKey: true, shiftKey: true });
    await waitFor('„Remote-Datei“ with Cmd/Ctrl+Shift+H', () => remDialog()?.open);
    await waitFor(
      'defaults: agent, last 50 MB, 500 ms',
      () => $('#remote-auth-agent').checked && $('#remote-start-mb').value === '50' && $('#remote-poll').value === '500',
    );
    setRemField('#remote-host', '127.0.0.1');
    setRemField('#remote-port', String(sftpPort));
    setRemField('#remote-user', 'e2e');
    click($('#remote-auth-password'));
    await sleep(50);
    click($('#remote-browse'));
    await waitFor(
      'unknown host key: fingerprint shown, explicit confirmation needed',
      () => $('#remote-fingerprint')?.textContent.includes('SHA256:') && $('#remote-trust'),
    );
    if ($('#remote-secret')) throw new Error('password asked for before the host key was confirmed');
    click($('#remote-trust'));
    await waitFor('then the password is asked for', () => $('#remote-secret'));
    if ($('#remote-secret').type !== 'password') throw new Error('the password field shows its text');
    setRemField('#remote-secret', 'wrong-password');
    remSubmit();
    await waitFor(
      'a wrong password is said and asked again',
      () => $('#remote-secret-wrong')?.textContent.includes('nicht angenommen') && $('#remote-secret').value === '',
    );
    setRemField('#remote-secret', 'testSecretQx7-sftp');
    remSubmit();
    await waitFor('the folder browser lists the server folder, folders first', () => {
      const names = $$('#remote-listing .entry').map((e) => e.textContent.trim());
      return names.length >= 2 && names[0].includes('archive') && names.some((n) => n.includes('app.log'));
    });
    click($$('#remote-listing .entry').find((e) => e.textContent.includes('app.log')));
    await waitFor('the chosen file is the path', () => $('#remote-path').value === '/app.log');
    remSubmit();
    const remLabel = '127.0.0.1:/app.log';
    await waitFor('connected over the browser connection, the dialog closed', () => !remDialog(), 20000);
    await waitFor('the tab shows host:path with the remote symbol', () => {
      const tab = tabs().find((t) => t.textContent.includes(remLabel));
      return tab?.querySelector('.src')?.textContent.includes('⇅');
    });
    await waitFor(
      'status bar: connected, lines, latency',
      () => status().includes('Verbunden') && status().includes('2 Zeilen') && / ms/.test(status()),
    );
    await waitFor(
      'remote lines with levels and umlauts',
      () => rowTexts().some((t) => t.includes('remote größe 😀')) && count('ERROR') === 1,
    );
    await act('sftpappend 2026-01-15 10:00:02,000 WARN  [main] app.Live - live über SFTP');
    await waitFor('a line written on the server arrives', () => rowTexts().some((t) => t.includes('live über SFTP')), 20000);
    await act('sftprotate 2026-01-15 10:00:03,000 ERROR [main] app.Live - after rotation');
    await waitFor(
      'rotation on the server: the new file follows, old lines stay',
      () => rowTexts().some((t) => t.includes('after rotation')) && rowTexts().some((t) => t.includes('remote start')),
      20000,
    );
    const remTab = () => tabs().find((t) => t.textContent.includes(remLabel));
    click(remTab().closest('.tab').querySelector('.close'));
    await waitFor('the remote tab is closed', () => !remTab());
    // Another server on the same address and port (another host key): refused, no button to go on.
    await invoke('e2e_sftp_stop', { port: sftpPort });
    await invoke('e2e_sftp_server', { root: remoteRoot, seed: 8, port: sftpPort });
    press('h', { metaKey: true, shiftKey: true });
    await waitFor(
      'dialog again, the connection remembered',
      () => remDialog()?.open && $$('app-remote-dialog .chip').some((c) => c.textContent.includes(remLabel)),
    );
    click($$('app-remote-dialog .chip').find((c) => c.textContent.includes(remLabel)));
    await sleep(50);
    remSubmit();
    await waitFor(
      'changed host key: refused, no way around it',
      () => $('#remote-changed')?.textContent.includes('geändert') && !$('#remote-trust') && $('#remote-connect').disabled,
    );
    remDialog().close();
    await waitFor('remote dialog closed', () => !remDialog());

    // Prompt 020: colour schemes. Cmd/Ctrl+Alt+T opens the picker, arrows show a scheme at once, Esc goes back,
    // Enter keeps it; the ERROR rows take the scheme's colours, the choice is stored.
    const ONE_DARK = { bgApp: '#282c34', errorBg: '#42353d' }; // src/app/core/theme/themes/one-dark.json
    const rootStyle = () => getComputedStyle(document.documentElement);
    const picker = () => $('app-theme-picker dialog[open]');
    const pickerGrid = () => $('app-theme-picker [role=listbox]');
    const gridKey = (key) =>
      (document.activeElement?.closest('app-theme-picker [role=listbox]')
        ? document.activeElement
        : pickerGrid()
      ).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const rgbOf = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    const schemeBefore = rootStyle().getPropertyValue('--bg-app').trim();
    const openPicker = () =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 't', code: 'KeyT', altKey: true, metaKey: true, bubbles: true }),
      );
    openPicker();
    await waitFor(
      'Cmd/Ctrl+Alt+T opens the colour scheme picker with all schemes',
      () => picker() && $$('app-theme-picker .card').length === 18,
    );
    await waitFor('„System folgen“ is the chosen card', () => $('app-theme-picker .card.chosen')?.dataset.id === 'system');
    const schemeTop = topLine();
    gridKey('ArrowRight');
    gridKey('ArrowRight');
    await waitFor(
      'arrow keys show One Dark at once (preview), the log does not move',
      () =>
        rootStyle().getPropertyValue('--bg-app').trim() === ONE_DARK.bgApp &&
        $('app-theme-picker .card.chosen')?.dataset.id === 'one-dark' &&
        (Number.isNaN(schemeTop) || topLine() === schemeTop),
    );
    picker().dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(
      'Esc closes the picker and goes back to the scheme before',
      () => !picker() && rootStyle().getPropertyValue('--bg-app').trim() === schemeBefore,
    );
    openPicker();
    await waitFor('picker open again', () => picker() && $('app-theme-picker .card.chosen'));
    gridKey('ArrowRight');
    gridKey('ArrowRight');
    gridKey('Enter');
    await waitFor(
      'Enter keeps One Dark: data-theme, tokens inline',
      () =>
        !picker() &&
        document.documentElement.dataset.theme === 'dark' &&
        document.documentElement.style.getPropertyValue('--lv-error-bg') === ONE_DARK.errorBg,
    );
    await waitFor('an ERROR row has the colour of the scheme', () => {
      const cell = $$('.lt-cell.lv-ERROR')[0];
      return !cell || getComputedStyle(cell).backgroundColor === rgbOf(ONE_DARK.errorBg);
    });
    await sleep(800);
    await act('expectsettings "themeSelection"|"fixed"|"one-dark"');

    await report('DONE');
  } catch (e) {
    await report(`FAIL ${e.message}`);
  }
})();
