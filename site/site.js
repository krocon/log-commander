/*
 * Log Commander – product site. One script for all pages, no dependencies, no requests.
 * Everything here is decoration or demo: the pages read completely without JavaScript.
 */
(() => {
  'use strict';
  const doc = document;
  const root = doc.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, el = doc) => el.querySelector(sel);
  const $$ = (sel, el = doc) => [...el.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  root.classList.add('js');

  /* ── headings: words rise from their line ── */
  for (const el of $$('.split')) {
    let i = 0;
    const wrap = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = doc.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { frag.append(' '); continue; }
            const w = doc.createElement('span');
            w.className = 'w';
            const inner = doc.createElement('span');
            inner.style.setProperty('--i', i++);
            inner.textContent = part;
            w.append(inner);
            frag.append(w);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && child.tagName !== 'BR') wrap(child);
      }
    };
    wrap(el);
  }

  /* ── reveal on scroll ── */
  const arrive = (el) => {
    if (el.classList.contains('in')) return;
    el.classList.add('in');
    if (el.dataset.count) countUp(el);
    if (el.classList.contains('chat')) playChat(el);
  };
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      seen.unobserve(e.target);
      arrive(e.target);
    }
  }, { threshold: 0.01, rootMargin: '0px 0px -7% 0px' });
  // what is on screen at the start does not wait for the observer (it stays silent in a page that is not painted)
  for (const el of $$('.reveal, .split, [data-count], .chat')) {
    if (el.getBoundingClientRect().top < innerHeight) arrive(el);
    else seen.observe(el);
  }

  function countUp(el) {
    const to = parseFloat(el.dataset.count);
    const digits = (el.dataset.count.split('.')[1] || '').length;
    const node = el.firstChild;
    if (reduce) { node.textContent = to.toFixed(digits); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = clamp((t - t0) / 1400, 0, 1);
      node.textContent = (to * (1 - Math.pow(1 - k, 4))).toFixed(digits);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function playChat(chat) {
    const items = [...chat.children];
    if (reduce) { chat.classList.add('static'); return; }
    let t = 200;
    for (const item of items) {
      setTimeout(() => item.classList.add('on'), t);
      t += item.classList.contains('tool') ? 420 : 1100;
    }
  }

  /* ── nav, hero tilt, page ruler: one scroll handler ── */
  const nav = $('.nav');
  const stage = $('.hero-stage');
  const ruler = buildRuler();
  let ticking = false;
  function onScroll() {
    ticking = false;
    const y = scrollY;
    nav?.classList.toggle('scrolled', y > 8);
    if (stage && !reduce) stage.style.setProperty('--tilt', (1 - clamp(y / 520, 0, 1)).toFixed(3));
    ruler?.update();
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  addEventListener('resize', () => { ruler?.layout(); onScroll(); });
  addEventListener('load', () => { ruler?.layout(); onScroll(); });
  onScroll();

  /** The bar at the right edge: one mark per section in the colour of its level, a band for the viewport. */
  function buildRuler() {
    const sections = $$('[data-lv][id]');
    if (sections.length < 2) return null;
    const bar = doc.createElement('nav');
    bar.className = 'pruler';
    bar.setAttribute('aria-label', 'Sections of this page');
    const band = doc.createElement('i');
    bar.append(band);
    const marks = sections.map((s) => {
      const a = doc.createElement('a');
      a.href = '#' + s.id;
      a.dataset.lv = s.dataset.lv;
      a.title = s.dataset.title || s.id;
      a.setAttribute('aria-label', a.title);
      bar.append(a);
      return a;
    });
    doc.body.append(bar);
    let total = 1;
    const layout = () => {
      total = Math.max(1, root.scrollHeight);
      const h = bar.clientHeight;
      sections.forEach((s, i) => { marks[i].style.top = ((s.getBoundingClientRect().top + scrollY) / total) * h + 'px'; });
      band.style.setProperty('--h', Math.max(18, (innerHeight / total) * h) + 'px');
    };
    const update = () => band.style.setProperty('--y', (scrollY / total) * bar.clientHeight + 'px');
    layout();
    return { layout, update };
  }

  /* ── cards: a light that follows the pointer ── */
  for (const card of $$('.card')) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', e.clientX - r.left + 'px');
      card.style.setProperty('--my', e.clientY - r.top + 'px');
    });
  }

  /* ── story: the pinned window shows the picture of the step in view ── */
  for (const story of $$('.story')) {
    const steps = $$('.step', story);
    const imgs = $$('.story-pin .stack img', story);
    const count = $('.story-count', story);
    const title = $('.story-pin .win-bar span', story);
    const show = (i) => {
      steps.forEach((s, k) => s.classList.toggle('on', k === i));
      imgs.forEach((im, k) => im.classList.toggle('on', k === i));
      if (count) count.textContent = `${i + 1} / ${steps.length}`;
      if (title && steps[i].dataset.title) title.textContent = steps[i].dataset.title;
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) show(steps.indexOf(e.target));
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach((s) => io.observe(s));
    show(0);
  }

  /* ── sub navigation: mark the group in view ── */
  const subLinks = $$('.subnav a[href^="#"]');
  if (subLinks.length) {
    const byId = new Map(subLinks.map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        subLinks.forEach((a) => a.classList.remove('on'));
        const a = byId.get(e.target.id);
        a?.classList.add('on');
        a?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }, { rootMargin: '-30% 0px -65% 0px' });
    for (const id of byId.keys()) { const el = doc.getElementById(id); if (el) io.observe(el); }
  }

  /* ── colour schemes: swatches switch the screenshot with a wipe ── */
  const schemeBox = $('.schemes');
  if (schemeBox) {
    const stack = $('.scheme-stage .stack');
    const label = $('.scheme-stage .win-bar span');
    const buttons = $$('.swatch', schemeBox);
    let current = 0;
    let auto = null;
    const pick = (i, user) => {
      if (i === current) return;
      current = i;
      buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
      const b = buttons[i];
      const img = new Image();
      img.alt = '';
      img.className = 'wipe';
      img.src = b.dataset.src;
      const swap = () => {
        stack.append(img);
        requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add('on')));
        setTimeout(() => { while (stack.children.length > 1) stack.firstElementChild.remove(); }, 900);
        label.textContent = b.textContent.trim();
        stack.lastElementChild.alt = `Log Commander in the colour scheme ${b.textContent.trim()}`;
      };
      img.decode ? img.decode().then(swap, swap) : (img.onload = swap);
      if (user) stop();
    };
    const stop = () => { clearInterval(auto); auto = null; };
    buttons.forEach((b, i) => b.addEventListener('click', () => pick(i, true)));
    if (!reduce) {
      new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !auto && !schemeBox.dataset.touched) auto = setInterval(() => pick((current + 1) % buttons.length), 2600);
        else if (!e.isIntersecting) stop();
      }, { threshold: 0.4 }).observe(stack);
      schemeBox.addEventListener('pointerdown', () => { schemeBox.dataset.touched = '1'; stop(); });
      schemeBox.addEventListener('keydown', () => { schemeBox.dataset.touched = '1'; stop(); });
    }
  }

  /* ── screenshots open large ── */
  const zoomable = $$('.win img:not([data-nozoom])').filter((im) => !im.closest('.scheme-stage'));
  if (zoomable.length && typeof HTMLDialogElement !== 'undefined') {
    const dlg = doc.createElement('dialog');
    dlg.className = 'lightbox';
    const big = doc.createElement('img');
    dlg.append(big);
    doc.body.append(dlg);
    dlg.addEventListener('click', () => dlg.close());
    for (const im of zoomable) {
      im.addEventListener('click', () => { big.src = im.currentSrc || im.src; big.alt = im.alt; dlg.showModal(); });
    }
  }

  /* ── table filter (keyboard page) ── */
  for (const input of $$('input[data-filter]')) {
    const rows = $$(input.dataset.filter);
    const none = $(input.dataset.none);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (const r of rows) { r.hidden = !!q && !r.textContent.toLowerCase().includes(q); if (!r.hidden) shown++; }
      if (none) none.hidden = shown > 0;
    });
  }

  /* ── the live demo in the hero ── */
  const demo = $('#demo');
  if (demo) liveDemo(demo);

  function liveDemo(el) {
    const rowsEl = $('.demo-rows', el);
    const tl = $('.demo-tl', el);
    const rulerEl = $('.demo-ruler', el);
    const empty = $('.demo-empty', el);
    const search = $('.demo-search', el);
    const live = $('.live', el);
    const linesEl = $('[data-lines]', el);
    const sizeEl = $('[data-size]', el);
    const errDot = $('.demo-tabs .dot', el);
    const chips = new Map($$('.chip', el).map((c) => [c.dataset.lv, c]));
    const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    const MAX_ROWS = 16;
    const BUFFER = 600;
    const nf = new Intl.NumberFormat('en-US');

    const on = Object.fromEntries(LEVELS.map((l) => [l, true]));
    const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
    let buffer = [];
    let pending = [];
    let frozen = false;
    let query = '';
    let line = 5104000 + Math.floor(Math.random() * 900);
    let bytes = 500.2 * 1024 * 1024;
    let visible = true;

    // a small shop that is not doing well every twelve seconds
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
    const threads = () => `nio-8080-exec-${rnd(1, 9)}`;
    const NORMAL = [
      ['info', 'c.a.shop.web.RequestLogger', () => `GET /api/orders/${rnd(4000, 4999)} 200 took ${rnd(8, 140)}ms`],
      ['info', 'c.a.shop.web.RequestLogger', () => `POST /api/cart/items 201 took ${rnd(12, 90)}ms`],
      ['info', 'c.a.shop.service.OrderService', () => `Order ${rnd(4000, 4999)} placed for user ${rnd(10000, 99999)}`],
      ['debug', 'c.a.shop.db.ConnectionPool', () => `acquired connection ${rnd(1, 20)} of 20`],
      ['debug', 'c.a.shop.cache.ProductCache', () => `cache hit sku=${rnd(100, 999)} ttl=${rnd(1, 60)}s`],
      ['trace', 'c.a.shop.web.RequestLogger', () => `headers accept=application/json trace=${rnd(1e5, 1e6).toString(16)}`],
      ['info', 'c.a.shop.payment.Gateway', () => `payment authorised order=${rnd(4000, 4999)} took ${rnd(120, 480)}ms`],
      ['info', 'c.a.shop.metrics.Reporter', () => `cpu=${(20 + Math.random() * 50).toFixed(1)}% mem=${(0.8 + Math.random()).toFixed(1)}GB`],
      ['debug', 'c.a.shop.search.Index', () => `query "running shoes" ${rnd(3, 40)} hits in ${rnd(2, 30)}ms`],
    ];
    const WARNS = [
      ['warn', 'c.a.shop.db.ConnectionPool', () => `Pool usage at ${rnd(85, 99)}% (${rnd(17, 20)} of 20)`],
      ['warn', 'c.a.shop.web.RequestLogger', () => `GET /api/orders/${rnd(4000, 4999)} 200 took ${rnd(900, 2400)}ms`],
      ['warn', 'c.a.shop.payment.Gateway', () => `retrying payment order=${rnd(4000, 4999)} attempt ${rnd(2, 4)}`],
    ];
    const STACK = [
      ['java.lang.IllegalStateException: connection pool exhausted', true],
      ['at com.acme.shop.db.ConnectionPool.acquire(ConnectionPool.java:142)'],
      ['at com.acme.shop.service.OrderService.place(OrderService.java:57)'],
      ['Caused by: java.net.SocketTimeoutException: Read timed out', true],
      ['... 12 more'],
    ];
    function make(kind) {
      const [lv, logger, msg] = kind === 'error'
        ? ['error', 'c.a.shop.service.OrderService', () => `Could not place order ${rnd(4000, 4999)}`]
        : kind === 'fatal'
          ? ['fatal', 'c.a.shop.ShopApplication', () => 'Out of memory, shutting down']
          : pick(kind === 'warn' ? WARNS : NORMAL);
      const d = new Date();
      const p = (n, w = 2) => String(n).padStart(w, '0');
      const entry = {
        lv, logger, msg: msg(), thread: lv === 'fatal' ? 'main' : threads(),
        time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`,
        stack: lv === 'error' ? STACK : [], line,
      };
      line += 1 + entry.stack.length;
      bytes += 96 + entry.msg.length + entry.stack.length * 60;
      return entry;
    }

    const matches = (e) => on[e.lv] && (!query || [e.msg, e.logger, e.thread, ...e.stack.map((s) => s[0])].some((t) => t.toLowerCase().includes(query)));

    function paint(node, text) {
      const q = query;
      const re = q ? new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig') : /(\d+(?:\.\d+)?(?:ms|GB|%|s)?)/g;
      for (const [i, part] of text.split(re).entries()) {
        if (!part) continue;
        if (i % 2) {
          const m = doc.createElement(q ? 'mark' : 'span');
          if (!q) m.className = 'n';
          m.textContent = part;
          node.append(m);
        } else node.append(part);
      }
    }
    function cellEl(cls, text, painted) {
      const s = doc.createElement('span');
      s.className = cls;
      painted ? paint(s, text) : (s.textContent = text);
      return s;
    }
    function rowsOf(e, fresh) {
      const out = [];
      const head = doc.createElement('div');
      head.className = `row l-${e.lv}${fresh ? ' new' : ''}`;
      head.append(
        cellEl('ln', nf.format(e.line)), cellEl('tm', e.time), cellEl('lvl', e.lv.toUpperCase()),
        cellEl('th', e.thread, true), cellEl('lg', e.logger, true), cellEl('ms', e.msg, true),
      );
      out.push(head);
      e.stack.forEach(([text, isHead], i) => {
        const r = doc.createElement('div');
        r.className = `row l-${e.lv}${fresh ? ' new' : ''}`;
        r.append(cellEl('ln', nf.format(e.line + 1 + i)), cellEl(isHead ? 'st head' : 'st', text, true));
        out.push(r);
      });
      return out;
    }
    function trim() {
      while (rowsEl.children.length > MAX_ROWS + 8) rowsEl.firstElementChild.remove();
    }
    function render() {
      rowsEl.textContent = '';
      const view = buffer.filter(matches);
      let n = 0;
      const picked = [];
      for (let i = view.length - 1; i >= 0 && n < MAX_ROWS; i--) { picked.unshift(view[i]); n += 1 + view[i].stack.length; }
      for (const e of picked) rowsEl.append(...rowsOf(e, false));
      empty.classList.toggle('on', picked.length === 0);
    }
    function status() {
      linesEl.textContent = frozen && pending.length ? `${nf.format(line)} lines · ${pending.length} new while frozen` : `${nf.format(line)} lines`;
      sizeEl.textContent = `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    function take(e, fresh) {
      buffer.push(e);
      if (buffer.length > BUFFER) buffer.shift();
      counts[e.lv]++;
      const chip = chips.get(e.lv);
      chip.lastElementChild.textContent = nf.format(counts[e.lv]);
      if (fresh && (e.lv === 'error' || e.lv === 'fatal' || e.lv === 'warn') && !reduce) {
        chip.classList.remove('bump');
        void chip.offsetWidth;
        chip.classList.add('bump');
      }
      if (matches(e) && fresh) {
        empty.classList.remove('on');
        rowsEl.append(...rowsOf(e, !reduce));
        trim();
      }
    }
    function emit(kind) {
      const e = make(kind);
      bucket[e.lv === 'fatal' ? 3 : e.lv === 'error' ? 2 : e.lv === 'warn' ? 1 : 0] += 1 + e.stack.length;
      if (frozen) pending.push(e); else take(e, true);
      if (e.lv === 'error' || e.lv === 'fatal') { errDot.classList.add('on'); setTimeout(() => errDot.classList.remove('on'), 2400); }
      status();
    }

    // timeline: one column per 400 ms, stacked by level, sliding to the left
    const BUCKET_MS = 400;
    const COLS = 150;
    let buckets = [];
    let bucket = [0, 0, 0, 0];
    let bucketStart = performance.now();
    const css = (name) => getComputedStyle(el).getPropertyValue(name).trim();
    let colors = null;
    const readColors = () => { colors = { all: css('--trace'), warn: css('--warn'), error: css('--error'), fatal: css('--fatal'), band: css('--border'), dim: css('--faint') }; };
    readColors();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); drawRuler(); });

    function fit(canvas) {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [ctx, w, h];
    }
    function drawTimeline(now) {
      const [ctx, w, h] = fit(tl);
      ctx.clearRect(0, 0, w, h);
      const cw = w / (COLS - 2);
      const shift = reduce ? 0 : ((now - bucketStart) / BUCKET_MS) * cw;
      const all = [...buckets, bucket];
      const peak = Math.max(8, ...all.map((b) => b[0] + b[1] + b[2] + b[3]));
      const fills = [colors.all, colors.warn, colors.error, colors.fatal];
      all.forEach((b, i) => {
        const x = w - (all.length - i) * cw - shift + cw;
        let y = h - 2;
        b.forEach((v, k) => {
          if (!v) return;
          const bh = Math.max(k ? 3 : 1, (v / peak) * (h - 8));
          ctx.fillStyle = fills[k];
          ctx.globalAlpha = k ? 1 : 0.55;
          ctx.fillRect(Math.round(x) + 0.5, y - bh, Math.max(1, cw - 1.5), bh);
          y -= bh;
        });
      });
      ctx.globalAlpha = 1;
    }
    function drawRuler() {
      const [ctx, w, h] = fit(rulerEl);
      ctx.clearRect(0, 0, w, h);
      const view = buffer.filter(matches);
      const n = view.length || 1;
      view.forEach((e, i) => {
        if (e.lv !== 'warn' && e.lv !== 'error' && e.lv !== 'fatal') return;
        const y = (i / n) * (h - 4);
        ctx.fillStyle = colors[e.lv];
        if (e.lv === 'warn') ctx.fillRect(w - 6, y, 4, 2); else ctx.fillRect(2, y, e.lv === 'fatal' ? 8 : 5, e.lv === 'fatal' ? 4 : 3);
      });
      const bh = Math.max(14, (MAX_ROWS / Math.max(MAX_ROWS, n)) * h);
      ctx.fillStyle = colors.band;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(0, h - bh, w, bh);
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.dim;
      ctx.fillRect(0, h - bh, w, 1);
    }

    // controls
    for (const [lv, chip] of chips) {
      chip.addEventListener('click', (ev) => {
        if (ev.altKey) { const only = LEVELS.every((l) => on[l] === (l === lv)); LEVELS.forEach((l) => (on[l] = only ? true : l === lv)); }
        else on[lv] = !on[lv];
        for (const [l, c] of chips) c.setAttribute('aria-pressed', String(on[l]));
        render(); drawRuler();
      });
    }
    for (const b of $$('[data-preset]', el)) {
      b.addEventListener('click', () => {
        const from = LEVELS.indexOf(b.dataset.preset);
        LEVELS.forEach((l, i) => (on[l] = i >= from));
        for (const [l, c] of chips) c.setAttribute('aria-pressed', String(on[l]));
        render(); drawRuler();
      });
    }
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); drawRuler(); });
    const freezeBtn = $('[data-act="freeze"]', el);
    freezeBtn.addEventListener('click', () => {
      frozen = !frozen;
      freezeBtn.setAttribute('aria-pressed', String(frozen));
      live.classList.toggle('frozen', frozen);
      live.textContent = frozen ? 'Frozen' : 'Live';
      if (!frozen) { pending.forEach((e) => take(e, false)); pending = []; render(); }
      status();
    });

    // the clock: calm traffic, and an incident now and then
    let phase = 0;
    function tick() {
      if (visible && !doc.hidden) {
        phase = (phase + 1) % 150;
        const incident = phase > 110 && phase < 140;
        if (incident) {
          if (Math.random() < 0.5) emit('warn');
          if (phase % 7 === 0) emit('error');
          if (phase === 136 && Math.random() < 0.6) emit('fatal');
        }
        if (Math.random() < (incident ? 0.5 : 0.75)) emit(Math.random() < 0.04 ? 'warn' : 'normal');
      }
      setTimeout(tick, 90 + Math.random() * 80);
    }
    function frame(now) {
      if (now - bucketStart >= BUCKET_MS) {
        buckets.push(bucket);
        if (buckets.length > COLS) buckets.shift();
        bucket = [0, 0, 0, 0];
        bucketStart = now;
        drawRuler();
      }
      if (visible) drawTimeline(now);
      requestAnimationFrame(frame);
    }

    // start with a filled screen and a timeline that already has a past
    for (let i = 0; i < COLS; i++) {
      const hot = (i > 30 && i < 44) || (i > 104 && i < 114);
      buckets.push([rnd(2, 7), hot ? rnd(1, 4) : Math.random() < 0.08 ? 1 : 0, hot && i % 3 === 0 ? rnd(4, 9) : 0, i === 43 ? 3 : 0]);
    }
    for (let i = 0; i < 26; i++) take(make(i === 9 ? 'warn' : i === 17 ? 'error' : 'normal'), false);
    Object.assign(counts, { trace: 204817, debug: 1532904, info: 3190422, warn: 121377, error: 54212, fatal: 80 });
    for (const [lv, chip] of chips) chip.lastElementChild.textContent = nf.format(counts[lv]);
    render(); status(); drawRuler(); drawTimeline(performance.now());
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(el);
    addEventListener('resize', () => { drawRuler(); drawTimeline(performance.now()); });
    if (!reduce) { tick(); requestAnimationFrame(frame); }
    else { live.textContent = 'Paused (reduced motion)'; live.classList.add('frozen'); }
  }
})();
