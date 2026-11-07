// Measurement of prompt 003: the log view (GuiExpert Table) in the real webview. Until 1.1.107 it compared the
// own viewport as well; the numbers are in prompts/done/003-gui-expert-table.design.md.
// Run: node scripts/e2e/run.mjs --scenario scripts/e2e/spike-003.js
// Every measurement goes out as a PASS line, the harness prints them.
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const report = (message) => invoke('e2e_report', { message });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const act = (action) => report(`ACTION ${action}`);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const status = () => $('app-status-bar').innerText;
  const button = (text) => $$('button').find((b) => b.textContent.trim().startsWith(text));
  const press = (key) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

  async function waitFor(what, condition, timeoutMs = 20000) {
    const start = Date.now();
    for (;;) {
      let value;
      try {
        value = condition();
      } catch {
        value = false;
      }
      if (value) return value;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`);
      await sleep(30);
    }
  }

  const MODES = {
    table: {
      root: () => $('app-log-table-view'),
      scroller: () => $('app-log-table-view .ge-table-scroll-viewport'),
      placeholder: '.lt-cell.loading',
      firstLine() {
        const top = $('app-log-table-view').getBoundingClientRect().top;
        const cells = $$('app-log-table-view .lt-gutter')
          .map((c) => ({ c, r: c.getBoundingClientRect() }))
          .filter(({ r }) => r.bottom > top + 1)
          .sort((a, b) => a.r.top - b.r.top);
        return cells.length ? Number(cells[0].c.textContent) : -1;
      },
      textCell: () => $('app-log-table-view .lt-text'),
    },
  };

  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q) => Math.round((sorted[Math.floor(q * (sorted.length - 1))] ?? 0) * 10) / 10;
    return `n=${sorted.length} p50=${at(0.5)} p95=${at(0.95)} max=${at(1)}`;
  };

  /** Frame intervals via requestAnimationFrame, and rows drawn without text. */
  function sample(mode) {
    const frames = [];
    let last = performance.now();
    let running = true;
    const loop = (now) => {
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    let changes = 0;
    let withPlaceholder = 0;
    const observer = new MutationObserver(() => {
      changes++;
      if (mode.root().querySelector(mode.placeholder)) withPlaceholder++;
    });
    observer.observe(mode.root(), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    const drawStart = window.__lcTable?.drawTimes.length ?? 0;
    return () => {
      running = false;
      observer.disconnect();
      const draws = window.__lcTable?.drawTimes.slice(drawStart) ?? [];
      return {
        frames: stats(frames.slice(1)),
        long: frames.filter((f) => f > 50).length,
        placeholder: `${withPlaceholder}/${changes}`,
        draws: draws.length ? stats(draws) : '-',
      };
    };
  }

  async function setMode(name) {
    await waitFor(`${name} view`, () => MODES[name].root());
    await sleep(500);
  }

  async function follow(name, mode, label, rates) {
    press('End');
    await waitFor('live', () => status().includes('Live'));
    await sleep(500);
    await act('cpustart');
    const stop = sample(mode);
    for (const r of rates) await act(`rate ${r}`);
    await sleep(5600);
    const result = stop();
    await act(`cpustop ${name} ${label}`);
    await report(
      `PASS ${name} follow ${label}: frames ${result.frames}, >50ms ${result.long}, placeholder ${result.placeholder}, draw ${result.draws}`,
    );
  }

  try {
    await report('START');
    await waitFor('tabs', () => $$('.tab .title').length === 3);
    click($$('.tab .title').find((t) => t.textContent.includes('big.log')));
    // 10 million lines take minutes in a debug build; report now and then, so the harness waits.
    const loadStart = Date.now();
    while (!status().includes('Live')) {
      if (Date.now() - loadStart > 600000) throw new Error('timeout: big loaded');
      await report(`PASS loading big.log: ${status().replace(/\s+/g, ' ').slice(0, 80)}`);
      await sleep(15000);
    }

    for (const name of ['table']) {
      const mode = MODES[name];
      await setMode(name);

      // 1. Follow at 5000 lines/s, all levels and ERROR+.
      await follow(name, mode, 'all', ['5000 5 INFO big']);
      click(button('ERROR+'));
      await sleep(800);
      await follow(name, mode, 'ERROR+', ['4000 5 INFO big', '1000 5 ERROR big']);
      click(button('Alle'));
      await sleep(800);

      // 2. Reading in the middle while the file grows (blocker 1).
      const scroller = mode.scroller();
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
      await waitFor('paused', () => status().includes('Pausiert'));
      await sleep(800);
      const before = mode.firstLine();
      await act('rate 5000 5 INFO big');
      const seen = new Set();
      for (let i = 0; i < 60; i++) {
        seen.add(mode.firstLine());
        await sleep(100);
      }
      const after = mode.firstLine();
      await report(
        `PASS ${name} reading at line ${before} while 30000 lines arrive: now ${after}, moved ${after - before}, distinct tops ${seen.size}, rows ${status().match(/[\d.]+ Zeilen/)?.[0]}`,
      );

      // 3. A text selection while reading and lines arrive (blocker 3).
      const cell = mode.textCell();
      const node = cell.firstChild.firstChild ?? cell.firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(10, node.textContent.length));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      const selected = getSelection().toString();
      await act('rate 2000 3 INFO big');
      await sleep(3500);
      const kept = getSelection().toString() === selected && getSelection().anchorNode?.isConnected;
      await report(
        `PASS ${name} selection "${selected}" while reading, 6000 new lines: kept=${kept}`,
      );
      getSelection().removeAllRanges();
      await sleep(500);
      await report(`PASS ${name} after releasing the selection: top line ${mode.firstLine()}`);

      // 4. Wheel and scroll bar.
      await act('cpustart');
      const stop = sample(mode);
      for (let i = 0; i < 60; i++) {
        mode.scroller().dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: i % 20 < 10 ? 120 : -120,
            bubbles: true,
            cancelable: true,
          }),
        );
        await sleep(16);
      }
      for (let i = 0; i < 40; i++) {
        const s = mode.scroller();
        s.scrollTop = ((i % 10) / 10) * (s.scrollHeight - s.clientHeight);
        await sleep(30);
      }
      const result = stop();
      await act(`cpustop ${name} scrolling`);
      await report(
        `PASS ${name} scrolling: frames ${result.frames}, >50ms ${result.long}, placeholder ${result.placeholder}, draw ${result.draws}`,
      );
      press('End');
      await sleep(500);
    }
    await report('DONE');
  } catch (error) {
    await report(`FAIL ${error.message}`);
  }
})();
