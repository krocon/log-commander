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
        throw new Error(`timeout: ${what} UI: ${state}`);
      }
      await sleep(30);
    }
  }

  const rowTexts = () => $$('.row .text').map((e) => e.textContent);
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
    $('.scroller').dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
  const press = (key, options = {}) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));

  try {
    await report('START');
    // CLI argument opened the file; first lines, colours, counters, profile suggestion.
    await waitFor('file from the command line is open', () => $('.tab .title')?.textContent.includes('e2e.log'));
    await waitFor('every command line file gets a tab', () => $$('.tab .title').length === 3);
    click($$('.tab .title').find((t) => t.textContent.includes('e2e.log')));
    await waitFor('lines rendered', () => rowTexts().some((t) => t.includes('Starting ShopApplication')));
    await waitFor('counters', () => count('ERROR') === 8 && count('FATAL') === 1 && count('WARN') === 1);
    await waitFor('text keeps its spaces', () => getComputedStyle($('.row .text')).whiteSpace === 'pre');
    await waitFor('text is exact, without added spaces', () =>
      rowTexts()[0] === '2026-01-15T10:00:00.123+01:00  INFO 4711 --- [           main] c.a.shop.ShopApplication                 : Starting ShopApplication v2.4.1 using Java 21',
    );
    await waitFor('long lines scroll sideways', () => $('.scroller').scrollWidth > $('.scroller').clientWidth);
    $('.scroller').scrollLeft = 120;
    await waitFor('text moves, line numbers stay', () => {
      const text = $('.row .text').getBoundingClientRect().left;
      const gutter = $('.row .gutter').getBoundingClientRect().left;
      return gutter === 0 && text < 0;
    });
    $('.scroller').scrollLeft = 0;
    await waitFor('continuation lines inherit ERROR', () =>
      $$('.row.lv-ERROR.cont').some((r) => r.textContent.includes('Caused by')),
    );
    const errorRow = $$('.row.lv-ERROR')[0];
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
    await waitFor('INFO off', () => chip('INFO').getAttribute('aria-pressed') === 'false' && !$('.row.lv-INFO'));
    click(button('WARN+'));
    await waitFor('WARN+ shows no INFO', () => $('.row') && !$('.row.lv-INFO') && !!$('.row.lv-WARN'));
    click(chip('ERROR'), { altKey: true });
    await waitFor('alt-click only ERROR, with its stack trace', () =>
      $$('.row').every((r) => r.classList.contains('lv-ERROR')) && rowTexts().some((t) => t.includes('Caused by')),
    );
    chip('WARN').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor('double click: WARN and worse', () => !!$('.row.lv-WARN') && !!$('.row.lv-FATAL') && !$('.row.lv-INFO'));
    await act('append 2026-01-15T10:02:00.000+01:00 ERROR 4711 --- [t] a.B : after the filter');
    await waitFor('filter grows incrementally', () => rowTexts().some((t) => t.includes('after the filter')));
    click(button('Alle'));
    await waitFor('all levels again', () => status().includes('Zeilen') && !status().includes(' von '));

    // Search: filter mode, regex, invalid regex, highlight mode with navigation.
    search('order');
    await waitFor('search filters', () => status().includes(' von ') && rowTexts().some((t) => t.includes('Could not place order')));
    await waitFor('entry stays together', () => rowTexts().some((t) => t.includes('at com.acme.shop.db.ConnectionPool')));
    await waitFor('match is marked', () => $$('.row .hit').some((h) => /order/i.test(h.textContent)));
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
      $$('.row.current-hit').some((r) => r.textContent.includes('bulk line 10')),
    );
    await waitFor('follow stopped by the jump', () => status().includes('Pausiert'));
    const firstHit = $('.row.current-hit .gutter').textContent;
    click($('button[title^="Nächster"]'));
    await waitFor('next match moves on', () => $('.row.current-hit .gutter')?.textContent !== firstHit);
    click($('button[title^="Vorheriger"]'));
    await waitFor('previous match goes back', () => $('.row.current-hit .gutter')?.textContent === firstHit);
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
    const cause = $$('.row').find((r) => r.textContent.includes('Caused by'));
    click(cause.querySelector('.text'));
    await waitFor('entry selected', () => $$('.row.selected').length === 8);
    const first = Number($$('.row.selected')[0].dataset.line);
    const text = await invoke('copy_lines', {
      sessionId: 1,
      first,
      last: first + 7,
    });
    await waitFor('copy text is the entry', () => text.startsWith('2026-01-15T10:00:07') && text.includes('... 12 more'));

    // Wrapping, line numbers, font size, theme.
    click(button('⏎'));
    await waitFor('wrap on', () => $('.view.wrap'));
    click(button('⏎'));
    await waitFor('wrap off', () => !$('.view.wrap'));
    const before = getComputedStyle($('.view')).fontSize;
    click(button('A+'));
    await waitFor('font grows', () => getComputedStyle($('.view')).fontSize !== before);
    click(button('A−'));

    // File events.
    press('End');
    await act('truncate');
    await waitFor('truncation empties the view', () => status().match(/\b0 Zeilen/) && $('.empty'));
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
    nameInput.value = 'Mine';
    patternInput.value = '^no level group';
    click(form.querySelector('button'));
    await waitFor('bad regex is refused', () => form.querySelector('.error')?.textContent.includes('level'));
    patternInput.value = ' : (?P<level>back|bulk) ';
    mappingInput.value = 'back=FATAL\nbulk=DEBUG';
    click(form.querySelector('button'));
    await waitFor('profile accepted', () => !form.querySelector('.error') && $('.profile-row')?.textContent.includes('Mine'));
    $('dialog').close();
    await waitFor('settings closed', () => !$('dialog[open]'));
    const profileSelect = $('select[aria-label=Profil]');
    await waitFor('custom profile selectable', () => [...profileSelect.options].some((o) => o.textContent.trim() === 'Mine'));
    profileSelect.value = [...profileSelect.options].find((o) => o.textContent.trim() === 'Mine').value;
    profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor('levels recomputed by the profile', () => count('FATAL') === 2 && count('UNKNOWN') === 2 && !!$('.row.lv-FATAL'));

    // A big file: the scrollbar reaches every line although the view is far over the browser limit.
    click(tabOf('big.log'));
    await waitFor('big file indexed', () => /2\.000\.000 Zeilen/.test(status()) && status().includes('Live'), 60000);
    const scroller = $('.scroller');
    await waitFor('scroll range is capped', () => scroller.scrollHeight < 9000000);
    await waitFor('following shows the last line', () => rowTexts().some((t) => t.includes('big line 2000000')));
    scroller.scrollTop = scroller.scrollHeight / 2;
    await waitFor('dragging the bar pauses near the middle', () =>
      status().includes('Pausiert') && rowTexts().some((t) => /big line (99\d{4}|100\d{4}) /.test(t)),
    );
    const middle = Number($('.row').dataset.line);
    wheel(60);
    await waitFor('wheel moves by lines even here', () => {
      const now = Number($('.row').dataset.line);
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
    await act('rate 10000 3');
    await waitFor('all lines of the burst arrived', () => lineCount() === linesBefore + 30000, 20000);
    await waitFor('follow kept up', () => rowTexts().some((t) => t.includes('rate line 30000')));
    measuring = false;
    await report(`PASS worst event loop lag during 3 s at 10k lines/s: ${Math.round(worstLag)} ms (${turns} turns)`);
    if (worstLag > 250) throw new Error(`event loop blocked for ${Math.round(worstLag)} ms`);

    // Closing the tabs leads back to the start screen.
    click(tabOf('big.log').parentElement.querySelector('.close'));
    await waitFor('tab closed', () => tabs().length === 2);
    click(tabOf('other.log').parentElement.querySelector('.close'));
    click(tabOf('e2e.log').parentElement.querySelector('.close'));
    await waitFor('start screen lists recent files', () => $('app-start-screen')?.textContent.includes('e2e.log'));

    await report('DONE');
  } catch (e) {
    await report(`FAIL ${e.message}`);
  }
})();
