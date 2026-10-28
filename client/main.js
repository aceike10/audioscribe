/* AudioScribe v2 — panel side.
   Words and sounds are stored in SOURCE time. Every poll reads the layer's
   startTime / stretch, so moving or trimming the layer never breaks sync. */
(function () {
  'use strict';

  const req = typeof cep_node !== 'undefined' ? cep_node.require : require;
  const fs = req('fs'), path = req('path'), os = req('os'), cp = req('child_process'), crypto = req('crypto');
  const CEP = window.__adobe_cep__;
  const $ = (id) => document.getElementById(id);
  const WIN = os.platform() === 'win32';

  // ------------------------------------------------------------ host bridge
  const es = (s) => new Promise((res) => CEP.evalScript(s, res));
  async function esJSON(s) {
    const r = await es(s);
    try { return JSON.parse(r); } catch (e) { return { ok: false, err: 'After Effects returned: ' + r }; }
  }
  function extDir() {
    const p = decodeURI(CEP.getSystemPath('extension'));
    return WIN ? p.replace(/^file:\/\/\//, '') : p.replace(/^file:\/\//, '');
  }

  // --------------------------------------------------------------- settings
  const SKEY = 'audioscribe.v2.settings';
  const defaults = { python: '', mfa: '', model: 'small', lang: 'en', chars: 32, color: '#f0a23b', highlight: true, range: 'layer', repo: '', token: '', lines: 2, bg: 'line',
    box: { padX: 27, padY: 14, round: 19, opacity: 70 } };
  let settings = Object.assign({}, defaults);
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch (e) { /* keep defaults */ }
  const saveSettings = () => { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } };

  // ------------------------------------------------------------------ state
  const S = {
    layer: null, timing: null, words: [], segs: [], aligned: false,
    mode: 'words', cur: -1, phone: 0, pin: null, els: [], cards: [], busy: false, lastT: null,
    data: null, dataPath: null, range: null, editing: false, undo: [], gapWarned: false,
    t: null, peaks: null, dragWin: null, rig: null, rigMany: false, rigDrag: false
  };
  const WHOLE = 999999;

  const status = (msg) => { $('status').textContent = msg || ''; $('status').title = msg || ''; };

  // ---------------------------------------------------------------- feedback
  // busy(msg, frac): progress strip under the header (frac null = indeterminate).
  // notify(kind, msg): banner for results; errors stay until dismissed.
  let onCancel = null, noticeTimer = null;
  function busy(msg, frac, cancel) {
    $('busy').hidden = false;
    $('busyMsg').textContent = msg;
    const bar = $('busyBar');
    if (frac == null) { bar.classList.add('indet'); bar.style.width = ''; }
    else { bar.classList.remove('indet'); bar.style.width = Math.round(frac * 100) + '%'; }
    if (cancel !== undefined) onCancel = cancel;
    $('busyCancel').hidden = !onCancel;
  }
  function busyEnd() { $('busy').hidden = true; onCancel = null; }
  function notify(kind, msg) {
    clearTimeout(noticeTimer);
    const n = $('notice');
    n.className = 'notice ' + kind;
    $('noticeMsg').textContent = msg;
    n.hidden = false;
    if (kind !== 'error') noticeTimer = setTimeout(() => { n.hidden = true; }, 7000);
  }
  window.AS = { busy, busyEnd, notify };

  // ------------------------------------------------------------ time maths
  const rate = () => (S.timing.sr || 100) / 100;
  const compOf = (src) => S.timing.st + src * rate();
  const srcOf = (comp) => (comp - S.timing.st) / rate();
  const fps = () => S.timing.fps || 24;
  const frameOf = (t) => Math.floor(t * fps() + 1e-6);
  const snap = (t) => frameOf(t) / fps();
  function tc(t) {
    const f = Math.max(0, frameOf(t)), r = Math.round(fps());
    const p = (n) => String(n).padStart(2, '0');
    return p(Math.floor(f / (r * 3600))) + ':' + p(Math.floor(f / (r * 60)) % 60) + ':' +
      p(Math.floor(f / r) % 60) + ':' + p(f % r);
  }

  // Index of the last word that has started by the end of the frame at comp time t.
  function wordAt(t) {
    const s = srcOf(t) + (1 / fps()) / rate() - 1e-6;
    let lo = 0, hi = S.words.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (S.words[m].start < s) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  }
  function phoneAt(i, t) {
    const ph = (S.words[i] && S.words[i].phones) || [];
    const s = srcOf(t) + (1 / fps()) / rate() - 1e-6;
    let ans = 0;
    for (let j = 0; j < ph.length; j++) if (ph[j].start < s) ans = j;
    return ans;
  }

  // -------------------------------------------------------------- rendering
  function renderTranscript() {
    const root = $('transcript');
    root.textContent = '';
    S.els = [];
    if (!S.words.length) {
      root.innerHTML = '<p class="empty">No speech found on this layer.</p>';
      return;
    }
    let para = null, words = null, seg = -1;
    S.words.forEach((w, i) => {
      if (w.seg !== seg || !para) {
        seg = w.seg;
        para = document.createElement('div');
        para.className = 'para';
        const head = document.createElement('button');
        head.className = 'para-tc';
        head.dataset.i = i;
        head.textContent = tc(compOf(w.start));
        para.appendChild(head);
        words = document.createElement('div');
        words.className = 'words';
        para.appendChild(words);
        root.appendChild(para);
      }
      const b = document.createElement('button');
      b.className = 'w';
      b.dataset.i = i;
      b.textContent = w.word;
      words.appendChild(b);
      S.els.push(b);
    });
    markTrimmed();
    paintCurrent(true);
  }

  function markTrimmed() {
    if (!S.timing) return;
    S.words.forEach((w, i) => {
      const t = compOf(w.start);
      S.els[i] && S.els[i].classList.toggle('out', t < S.timing.ip - 1e-4 || t >= S.timing.op);
    });
  }

  function paintCurrent(scroll) {
    S.els.forEach((el, i) => {
      el.classList.toggle('cur', i === S.cur);
      el.classList.toggle('past', i < S.cur);
    });
    if (scroll && S.els[S.cur]) S.els[S.cur].scrollIntoView({ block: 'nearest' });
    renderSounds();
    renderPreview();
    drawWave();
  }

  function shapeOf(p) {
    if (/^(M|B|P)$/.test(p)) return 'A · closed';
    if (/^(F|V)$/.test(p)) return 'G · teeth on lip';
    if (p === 'L') return 'H · tongue up';
    if (/^(AA|AY|AW)$/.test(p)) return 'D · wide open';
    if (/^(AO|ER)$/.test(p)) return 'E · rounded';
    if (/^(UW|OW|OY|W|UH)$/.test(p)) return 'F · puckered';
    if (/^(EH|AE|AH|EY|IH|IY)$/.test(p)) return 'C · open';
    return 'B · slightly open';
  }

  function renderSounds() {
    const box = $('sounds');
    box.hidden = S.mode !== 'sounds' || !S.words.length;
    if (box.hidden) return;
    const w = S.words[Math.max(0, S.cur)];
    const ph = w.phones || [];
    $('sWord').textContent = w.word.replace(/^[^\w']+|[^\w']+$/g, '');
    $('sSpan').textContent = tc(compOf(w.start)) + ' → ' + tc(compOf(w.end)) + ' · ' +
      Math.round((w.end - w.start) * 1000) + ' ms';
    const row = $('phones');
    row.textContent = '';
    if (!ph.length) {
      const n = document.createElement('span');
      n.className = 'none';
      n.textContent = w.edited ? 'Edited words lose sound timing until you transcribe again.' :
        S.aligned ? 'The aligner could not place sounds in this word.' :
          'Sound-level timing needs the aligner. See README.';
      row.appendChild(n);
      $('sShape').textContent = '';
      $('sNote').textContent = '';
      return;
    }
    const frames = {};
    ph.forEach((p, j) => {
      const f = frameOf(compOf(p.start));
      frames[f] = (frames[f] || 0) + 1;
      const b = document.createElement('button');
      b.className = 'ph' + (j === S.phone ? ' cur' : '');
      // Width = this sound's share of the word (flex-grow must sum past 1 to fill).
      b.style.flex = Math.max(2, (p.end - p.start) / Math.max(0.001, w.end - w.start) * 100) + ' 1 0';
      b.dataset.j = j;
      b.title = tc(compOf(p.start));
      b.innerHTML = '<b></b><small></small>';
      b.firstChild.textContent = p.p;
      b.lastChild.textContent = 'f' + f;
      row.appendChild(b);
    });
    const shared = Object.values(frames).filter((n) => n > 1).length;
    const cp = ph[Math.min(S.phone, ph.length - 1)];
    $('sShape').textContent = 'Mouth shape ' + shapeOf(cp.p);
    $('sNote').textContent = shared ? shared + (shared > 1 ? ' frames hold' : ' frame holds') + ' 2+ sounds' : 'One sound per frame';
  }

  // The preview mirrors the look being edited: the targeted rig's settings, or
  // the defaults. Sizes are scaled from a 1080p caption (54 px text) to the
  // preview's 12 px text.
  function previewLook() {
    const k = 12 / 54;
    const src = S.rig || settings.box;
    const ref = S.rig ? 1080 / (S.rig.h || 1080) : 1;
    const v = (key, d) => (src[key] == null ? d : src[key]);
    return {
      mode: rigMode(), hl: rigHL(),
      px: v('padX', 27) * ref * k, py: v('padY', 14) * ref * k,
      r: v('round', 19) * ref * k, op: v('opacity', 70) / 100
    };
  }

  function renderPreview() {
    const box = $('capPreview');
    box.textContent = '';
    const look = previewLook();
    box.className = 'cap bg-' + look.mode;
    box.style.setProperty('--px', look.px.toFixed(1) + 'px');
    box.style.setProperty('--py', look.py.toFixed(1) + 'px');
    box.style.setProperty('--r', look.r.toFixed(1) + 'px');
    box.style.setProperty('--op', String(look.op));
    const card = cardOf(S.cur) || S.cards[0];
    if (!card) return;
    card.lines.forEach((ln) => {
      const row = document.createElement('div');
      row.className = 'cap-line';
      ln.idxs.forEach((i) => {
        const s = document.createElement('span');
        s.className = 'cw' + (look.hl && i === S.cur ? ' hl' : '');
        s.textContent = S.words[i].word;
        row.appendChild(s);
      });
      box.appendChild(row);
    });
  }
  const cardOf = (i) => S.cards.find((c) => c.idxs.indexOf(i) >= 0);

  // --------------------------------------------------------------- captions
  function buildCards(lines) {
    lines = lines || settings.lines;
    const cards = [];
    if (!S.timing) return cards;
    let cur = null;
    const close = () => { if (cur) { cur.end = cur.lastEnd + 0.3; cards.push(cur); cur = null; } };
    S.words.forEach((w, i) => {
      const cs = compOf(w.start), ce = compOf(w.end);
      if (cs < S.timing.ip - 1e-4 || cs >= S.timing.op) { close(); return; }
      const limit = settings.chars * lines, len = cur ? cur.text.length + 1 + w.word.length : 0;
      // Let a caption run up to 20% long to finish a sentence instead of orphaning its last word.
      const finishes = /[.!?]["'”’)\]]?$/.test(w.word) && len <= limit * 1.2;
      if (cur && ((len > limit && !finishes) || cs - cur.lastEnd > 0.7)) close();
      if (!cur) cur = { start: snap(cs), text: '', words: [], idxs: [], lastEnd: ce };
      cur.text += (cur.text ? ' ' : '') + w.word;
      cur.words.push({ t: snap(cs), w: w.word });
      cur.idxs.push(i);
      cur.lastEnd = ce;
      if (/[.!?]["'”’)\]]?$/.test(w.word)) close();
    });
    close();
    cards.forEach((c, k) => {
      const next = cards[k + 1];
      // Hold through short pauses so captions don't flicker off for a few frames.
      if (next && next.start - c.end < 0.5) c.end = next.start;
      c.end = Math.round(Math.min(c.end, next ? next.start : Infinity, S.timing.op) * fps()) / fps();
      c.end = Math.max(c.end, c.start + 1 / fps());
      c.lines = splitLines(c, lines);
    });
    return cards;
  }

  // Two-line mode: split at the word boundary that best balances the lines.
  function splitLines(card, lines) {
    const items = card.idxs.map((i, k) => ({ i, w: card.words[k].w, t: card.words[k].t }));
    const mk = (arr) => ({ text: arr.map((x) => x.w).join(' '), idxs: arr.map((x) => x.i),
      words: arr.map((x) => ({ t: x.t, w: x.w })) });
    if (lines < 2 || card.text.length <= settings.chars || items.length < 2) return [mk(items)];
    let best = 1, score = Infinity;
    for (let k = 1; k < items.length; k++) {
      const a = mk(items.slice(0, k)).text.length, b = mk(items.slice(k)).text.length;
      const sc = Math.max(a, b);
      if (sc < score) { score = sc; best = k; }
    }
    return [mk(items.slice(0, best)), mk(items.slice(best))];
  }

  function hexToRGB(h) {
    const n = parseInt(h.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  async function createCaptions() {
    if (!S.layer) { notify('error', 'Transcribe a layer first.'); return; }
    S.cards = buildCards();
    if (!S.cards.length) { notify('error', 'No words fall inside the layer’s in and out points.'); return; }
    $('btnCaptions').disabled = true;
    busy('Creating ' + S.cards.length + ' captions in After Effects…', null);
    await new Promise((r) => setTimeout(r, 60)); // let the panel paint before AE gets busy
    const file = path.join(os.tmpdir(), 'audioscribe_captions.json');
    fs.writeFileSync(file, JSON.stringify({
      name: 'Captions – ' + S.layer.name, fontScale: 0.05, yPos: 0.88, lines: settings.lines,
      highlight: settings.highlight, color: hexToRGB(settings.color), bg: settings.bg, box: settings.box,
      cards: S.cards.map((c) => ({ start: c.start, end: c.end,
        lines: c.lines.map((l) => ({ text: l.text, words: l.words })) }))
    }), 'utf8');
    const r = await esJSON('as_makeCaptions(' + JSON.stringify(file) + ')');
    busyEnd();
    $('btnCaptions').disabled = false;
    if (r.ok) notify('ok', 'Created “' + r.name + '” with ' + r.cards + ' captions. Adjust the box with the controls above, or in the null’s Effect Controls.');
    else notify('error', r.err);
  }

  // ---------------------------------------------------------- transcription
  function cacheDir() {
    const base = WIN ? (process.env.APPDATA || os.homedir()) :
      os.platform() === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') :
        path.join(os.homedir(), '.config');
    const d = path.join(base, 'AudioScribe', 'cache');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  // Cache files are named <hash>_<start>_<end>.json, where start/end are the
  // source seconds that were transcribed. Any cached range that covers the
  // layer's range is reused, so trimming inside it never re-transcribes.
  function cacheBase(src) {
    const st = fs.statSync(src);
    const key = [src, st.size, st.mtimeMs, settings.model, settings.lang, 'v3'].join('|');
    return crypto.createHash('sha1').update(key).digest('hex');
  }
  function findCache(src, a, b) {
    const base = cacheBase(src), dir = cacheDir();
    let best = null;
    fs.readdirSync(dir).forEach((f) => {
      if (!f.startsWith(base + '_') || !f.endsWith('.json')) return;
      const r = f.slice(base.length + 1, -5).split('_').map(Number);
      if (r.length !== 2 || r[0] > a + 1e-3 || r[1] < b - 1e-3) return;
      if (!best || r[1] - r[0] < best.len) best = { file: path.join(dir, f), len: r[1] - r[0] };
    });
    return best && best.file;
  }
  const newCachePath = (src, a, b) =>
    path.join(cacheDir(), cacheBase(src) + '_' + a.toFixed(2) + '_' + b.toFixed(2) + '.json');

  // Source seconds the layer actually uses (in point to out point).
  function layerSrcRange(t) {
    const r = (t.sr || 100) / 100;
    const a = (t.ip - t.st) / r, b = (t.op - t.st) / r;
    return [Math.max(0, Math.min(a, b)), Math.max(a, b)];
  }
  function neededRange(t) {
    if (settings.range === 'whole') return [0, WHOLE];
    const [a, b] = layerSrcRange(t);
    // A second of padding so words cut by the in/out points are still heard whole.
    return [Math.max(0, Math.floor((a - 1) * 100) / 100), Math.ceil((b + 1) * 100) / 100];
  }
  function covered(t) {
    if (!S.range) return true;
    const [a, b] = layerSrcRange(t);
    return S.range[0] <= a + 0.05 && S.range[1] >= Math.min(b, S.data && S.data.duration || b) - 0.05;
  }

  function childEnv() {
    const env = Object.assign({}, process.env);
    const h = os.homedir();
    const extra = WIN ? [] : ['/opt/homebrew/bin', '/usr/local/bin',
      path.join(h, 'miniforge3', 'bin'), path.join(h, 'miniconda3', 'bin'), path.join(h, 'anaconda3', 'bin')];
    env.PATH = extra.concat([env.PATH || '']).join(path.delimiter);
    return env;
  }

  // The installer puts Python in a conda env called "aligner"; look there first.
  function detectPython() {
    const h = os.homedir();
    const roots = ['miniforge3', 'miniconda3', 'anaconda3', 'mambaforge'].map((r) => path.join(h, r));
    if (!WIN) roots.push('/opt/homebrew/Caskroom/miniforge/base', '/opt/miniconda3', '/opt/anaconda3');
    for (const r of roots) {
      const p = WIN ? path.join(r, 'envs', 'aligner', 'python.exe') : path.join(r, 'envs', 'aligner', 'bin', 'python');
      if (fs.existsSync(p)) return p;
    }
    return '';
  }

  function runHelper(src, out, range, extra) {
    return new Promise((resolve, reject) => {
      const py = settings.python || detectPython() || (WIN ? 'python' : 'python3');
      const args = [path.join(extDir(), 'helper', 'transcribe.py'), src, out,
        '--model', settings.model, '--lang', settings.lang];
      if (settings.mfa) args.push('--mfa', settings.mfa);
      if (range[0] > 0) args.push('--start', String(range[0]));
      if (range[1] < WHOLE) args.push('--end', String(range[1]));
      if (extra) args.push(...extra);
      let tail = '';
      const p = cp.spawn(py, args, { env: childEnv() });
      let frac = 0.01, msg = 'Starting…', cancelled = false;
      busy(msg, frac, () => { cancelled = true; p.kill(); });
      p.stderr.on('data', (d) => {
        const s = d.toString();
        tail = (tail + s).slice(-600);
        s.split(/\r?\n/).forEach((line) => {
          if (line.startsWith('STATUS: ')) msg = line.slice(8);
          else if (line.startsWith('PROGRESS: ')) frac = Number(line.slice(10)) || frac;
          else return;
          busy(msg, frac);
        });
      });
      p.on('close', () => { if (cancelled) reject(new Error('Cancelled')); });
      p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ?
        'Python not found. Run the AudioScribe installer, or set its path in Settings › Advanced.' : e.message)));
      p.on('close', (code) => code === 0 ? resolve() :
        reject(new Error((tail.split(/\r?\n/).filter((l) => l && !/^(STATUS|PROGRESS)/.test(l)).pop()) || 'Transcription failed')));
    });
  }

  function loadData(file) {
    if (typeof stop === 'function') stop();
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    S.data = d;
    S.dataPath = file;
    S.words = d.words.map((w) => ({ word: w.word, start: w.start, end: w.end, seg: w.seg || 0,
      phones: w.phones, edited: w.edited }));
    S.segs = d.segments || [];
    S.aligned = !!d.aligned;
    S.range = d.range || [0, WHOLE];
    S.peaks = d.peaks && d.peaks.data && d.peaks.data.length ? d.peaks : null;
    S.cur = -1; S.phone = 0; S.pin = null; S.undo = []; S.gapWarned = false;
    S.cards = buildCards();
    renderTranscript();
    updateRangeLabel();
  }

  function saveData() {
    if (!S.data || !S.dataPath) return;
    S.data.words = S.words;
    S.data.edited = true;
    try { fs.writeFileSync(S.dataPath, JSON.stringify(S.data), 'utf8'); }
    catch (e) { status('Could not save your edit: ' + e.message); }
  }

  function updateRangeLabel() {
    if (!S.layer) return;
    const base = S.layer.comp + ' · ' + path.basename(S.layer.path);
    const full = !S.range || (S.range[0] <= 0.01 && S.data && S.range[1] >= S.data.duration - 0.05);
    const secs = (x) => {
      const m = Math.floor(x / 60), s = x - m * 60;
      return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    };
    $('layerSub').textContent = full ? base : base + ' · source ' + secs(S.range[0]) + '–' + secs(S.range[1]);
  }

  async function transcribe() {
    if (S.busy) return;
    const L = await esJSON('as_getLayer()');
    if (!L.ok) { notify('error', L.err); return; }
    S.layer = L;
    S.timing = { st: L.st, sr: L.sr, ip: L.ip, op: L.op, fps: L.fps, remap: L.remap };
    $('layerNum').textContent = L.index;
    $('layerName').textContent = L.name;
    $('layerSub').textContent = L.comp + ' · ' + path.basename(L.path);

    const fresh = $('setFresh').checked;
    $('setFresh').checked = false;
    const range = neededRange(S.timing);
    let out;
    try {
      const hit = fresh ? null : findCache(L.path, range[0], Math.min(range[1], WHOLE));
      if (hit) {
        loadData(hit);
        const note = remapNote();
        if (note) notify('warn', note);
        else notify('ok', 'Loaded ' + S.words.length + ' words (already transcribed).');
        status(S.words.length + ' words');
        return;
      }
      out = newCachePath(L.path, range[0], range[1]);
    } catch (e) { notify('error', 'Cannot read the source file: ' + e.message); return; }
    S.busy = true;
    $('btnTranscribe').disabled = true;
    $('btnTranscribe').textContent = 'Transcribing…';
    try {
      await runHelper(L.path, out, range);
      loadData(out);
      const note = remapNote();
      if (note) notify('warn', note);
      else notify('ok', 'Transcribed ' + S.words.length + ' words' +
        (S.aligned ? ' with sound timing.' : '. Sound timing unavailable, so Sounds view is limited.'));
      status(S.words.length + ' words');
    } catch (e) {
      if (e.message === 'Cancelled') notify('warn', 'Transcription cancelled.');
      else notify('error', 'Transcription failed: ' + e.message);
    } finally {
      busyEnd();
      S.busy = false;
      $('btnTranscribe').disabled = false;
      $('btnTranscribe').textContent = 'Transcribe';
    }
  }

  const remapNote = () => S.timing && S.timing.remap ?
    'Time remap is on for this layer, so word positions will be off. v1 ignores remapping.' : '';

  // -------------------------------------------------------------- navigation
  async function goTo(i, j) {
    if (!S.timing || !S.words[i]) return;
    const w = S.words[i];
    const src = (j != null && w.phones && w.phones[j]) ? w.phones[j].start : w.start;
    const t = snap(compOf(src));
    S.pin = { t, i, j: j || 0 };
    S.t = t;
    S.cur = i; S.phone = j || 0;
    if (playing) seekAudio(t);
    paintCurrent(false);
    $('tc').textContent = tc(t);
    await es('as_setTime(' + t + ')');
  }

  function step(dir) {
    if (!S.words.length) return;
    let i = Math.max(0, S.cur), j = S.phone + dir;
    const n = (k) => Math.max(1, (S.words[k].phones || []).length);
    if (j >= n(i)) { if (i < S.words.length - 1) { i++; j = 0; } else j = n(i) - 1; }
    if (j < 0) { if (i > 0) { i--; j = n(i) - 1; } else j = 0; }
    goTo(i, j);
  }

  function find() {
    const q = $('find').value.trim().toLowerCase().replace(/[^\w' ]/g, '');
    if (!q || !S.words.length) return;
    const norm = (s) => s.toLowerCase().replace(/[^\w']/g, '');
    const parts = q.split(/\s+/);
    for (let k = 1; k <= S.words.length; k++) {
      const i = (Math.max(0, S.cur) + k) % S.words.length;
      if (parts.every((p, o) => S.words[i + o] && norm(S.words[i + o].word).startsWith(p))) {
        goTo(i, 0);
        S.els[i].scrollIntoView({ block: 'center' });
        return;
      }
    }
    status('No match for “' + $('find').value.trim() + '”');
  }

  // -------------------------------------------------------------------- poll
  async function poll() {
    try {
      if (S.layer && !document.hidden && !S.busy) {
        const r = await esJSON('as_getTime(' + S.layer.id + ')');
        if (r.ok) onTime(r);
      }
    } catch (e) { /* AE busy (e.g. RAM preview); try again next tick */ }
    setTimeout(poll, 120);
  }

  function onTime(r) {
    if (playing) return; // the panel's own clock drives everything while playing
    if (!r.here) { $('tc').textContent = '--:--:--:--'; return; }
    const moved = !S.timing || r.st !== S.timing.st || r.sr !== S.timing.sr ||
      r.ip !== S.timing.ip || r.op !== S.timing.op;
    S.timing = { st: r.st, sr: r.sr, ip: r.ip, op: r.op, fps: r.fps, remap: r.remap };
    if (moved) {
      markTrimmed();
      S.cards = buildCards();
      if (!covered(S.timing)) {
        if (!S.gapWarned) status('The layer now uses audio outside the transcript. Press Transcribe to add it.');
        S.gapWarned = true;
      } else S.gapWarned = false;
    }
    $('tc').textContent = tc(r.t);
    if (r.t === S.lastT && !moved) return;
    S.lastT = r.t;
    S.t = r.t;
    let i, j;
    if (S.pin && Math.abs(S.pin.t - r.t) < 1e-6) { i = S.pin.i; j = S.pin.j; }
    else { S.pin = null; i = wordAt(r.t); j = i >= 0 ? phoneAt(i, r.t) : 0; }
    if (i !== S.cur || j !== S.phone || moved) {
      const scroll = i !== S.cur;
      S.cur = i; S.phone = j;
      paintCurrent(scroll);
    } else drawWave();
  }

  // ---------------------------------------------------------------- waveform
  // Shows the caption being spoken. Click or drag to move the playhead;
  // with the strip focused, Left/Right step one frame.
  function waveWindow() {
    if (S.dragWin) return S.dragWin;
    const card = cardOf(S.cur);
    if (card) return [card.start - 0.15, card.end + 0.15];
    if (S.t != null) return [S.t - 1.5, S.t + 1.5];
    return null;
  }

  function drawWave() {
    const cv = $('wave'), wrap = $('waveWrap');
    const win = S.timing && S.words.length ? waveWindow() : null;
    wrap.hidden = !win;
    if (!win) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const [t0, t1] = win;
    const xOf = (t) => (t - t0) / (t1 - t0) * W;
    const css = getComputedStyle(document.documentElement);
    const ph = css.getPropertyValue('--playhead').trim() || '#f0a23b';

    // Current word span
    const cw = S.words[S.cur];
    if (cw) {
      g.fillStyle = 'rgba(240,162,59,0.14)';
      const a = xOf(compOf(cw.start)), b = xOf(compOf(cw.end));
      g.fillRect(a, 0, Math.max(1, b - a), H);
    }

    // Waveform
    const mid = H * 0.58, amp = H * 0.36;
    if (S.peaks) {
      const pk = S.peaks;
      for (let x = 0; x < W; x += Math.max(1, Math.round(dpr))) {
        const ta = t0 + x / W * (t1 - t0), tb = t0 + (x + dpr) / W * (t1 - t0);
        let i0 = Math.floor((srcOf(ta) - pk.start) * pk.rate), i1 = Math.ceil((srcOf(tb) - pk.start) * pk.rate);
        if (i1 <= 0 || i0 >= pk.data.length) continue;
        i0 = Math.max(0, i0); i1 = Math.min(pk.data.length, Math.max(i1, i0 + 1));
        let v = 0;
        for (let k = i0; k < i1; k++) if (pk.data[k] > v) v = pk.data[k];
        const h = Math.max(dpr, v / 255 * amp);
        g.fillStyle = S.t != null && ta <= S.t ? '#cfcfcf' : '#686868';
        g.fillRect(x, mid - h, Math.max(1, Math.round(dpr)), h * 2);
      }
    } else {
      g.fillStyle = '#8a8a8a';
      g.font = (11 * dpr) + 'px -apple-system, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('Transcribe again to see the waveform', W / 2, mid + 4 * dpr);
    }

    // Outside the layer's in/out
    g.fillStyle = 'rgba(15,15,15,0.6)';
    const ia = xOf(S.timing.ip), ob = xOf(S.timing.op);
    if (ia > 0) g.fillRect(0, 0, ia, H);
    if (ob < W) g.fillRect(ob, 0, W - ob, H);

    // Word boundaries and labels
    g.font = (10 * dpr) + 'px -apple-system, system-ui, sans-serif';
    g.textAlign = 'left';
    S.words.forEach((w, i) => {
      const a = xOf(compOf(w.start)), b = xOf(compOf(w.end));
      if (b < 0 || a > W) return;
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(Math.round(a), 0, Math.max(1, Math.round(dpr)), H);
      const label = w.word;
      if (g.measureText(label).width + 4 * dpr < b - a) {
        g.fillStyle = i === S.cur ? ph : '#a8a8a8';
        g.fillText(label, a + 3 * dpr, 12 * dpr);
      }
    });

    // Playhead
    if (S.t != null) {
      const x = xOf(S.t);
      if (x >= 0 && x <= W) { g.fillStyle = ph; g.fillRect(Math.round(x - dpr), 0, Math.round(2 * dpr), H); }
    }
  }

  let sendT = null, sending = false;
  async function pushTime(t) {
    sendT = t;
    if (sending) return;
    sending = true;
    while (sendT != null) {
      const v = sendT;
      sendT = null;
      await es('as_setTime(' + v + ')');
    }
    sending = false;
  }
  function scrubTo(t) {
    if (!S.timing) return;
    t = snap(Math.max(0, t));
    if (t === S.t) return;
    S.t = t;
    const i = wordAt(t);
    S.pin = { t, i, j: i >= 0 ? phoneAt(i, t) : 0 };
    if (playing) seekAudio(t);
    $('tc').textContent = tc(t);
    if (i !== S.cur) { S.cur = i; S.phone = S.pin.j; paintCurrent(true); }
    else { S.phone = S.pin.j; renderSounds(); drawWave(); }
    pushTime(t);
  }
  function waveT(e) {
    const cv = $('wave'), r = cv.getBoundingClientRect(), win = waveWindow();
    return win[0] + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (win[1] - win[0]);
  }
  $('wave').addEventListener('pointerdown', (e) => {
    if (!waveWindow()) return;
    S.dragWin = waveWindow().slice();
    $('wave').setPointerCapture(e.pointerId);
    scrubTo(waveT(e));
  });
  $('wave').addEventListener('pointermove', (e) => { if (S.dragWin) scrubTo(waveT(e)); });
  const endDrag = () => { if (S.dragWin) { S.dragWin = null; drawWave(); } };
  $('wave').addEventListener('pointerup', endDrag);
  $('wave').addEventListener('pointercancel', endDrag);
  $('wave').addEventListener('keydown', (e) => {
    if (S.t == null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    scrubTo(S.t + (e.key === 'ArrowRight' ? 1 : -1) / fps() * (e.shiftKey ? 10 : 1) + 1e-6);
  });
  if (window.ResizeObserver) new ResizeObserver(() => drawWave()).observe($('wave'));

  // ---------------------------------------------------------------- playback
  // AE doesn't let panels read the playhead during its own preview playback,
  // so the panel plays the audio itself: transcript and waveform follow live,
  // and AE's playhead follows along (a few times a second) and lands where you
  // stop. Audio comes from a 16 kHz copy the helper writes next to the cache.
  const audio = new Audio();
  let playing = false, raf = 0, lastPush = 0;

  const wavPath = () => S.dataPath && S.dataPath.replace(/\.json$/, '.wav');
  const fileURL = (p) => WIN ? 'file:///' + encodeURI(p.replace(/\\/g, '/')) : 'file://' + encodeURI(p);

  async function ensureAudio() {
    const wav = wavPath();
    if (!fs.existsSync(wav)) {
      // Transcript made before playback existed: write just the audio.
      try {
        await runHelper(S.layer.path, S.dataPath, [S.range[0], S.range[1]], ['--audio-only']);
      } finally { busyEnd(); }
    }
    if (audio.dataset.src !== wav) {
      audio.dataset.src = wav;
      audio.src = fileURL(wav);
      await new Promise((res, rej) => {
        audio.onloadedmetadata = res;
        audio.onerror = () => rej(new Error('Couldn’t load the audio for playback.'));
      });
    }
  }
  const audioOffset = (t) => srcOf(t) - S.range[0];
  function seekAudio(t) {
    const off = audioOffset(t);
    if (off >= 0 && off < audio.duration) audio.currentTime = off;
  }

  function setPlayUI() {
    $('btnPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('btnPlay').setAttribute('aria-pressed', String(playing));
    // SVG elements ignore .hidden; toggle the attribute instead.
    $('playIcon').toggleAttribute('hidden', playing);
    $('pauseIcon').toggleAttribute('hidden', !playing);
  }

  async function play() {
    if (playing) return;
    if (!S.layer || !S.words.length || !S.timing) { notify('error', 'Transcribe a layer first.'); return; }
    try { await ensureAudio(); } catch (e) { notify('error', e.message === 'Cancelled' ? 'Cancelled.' : e.message); return; }
    let t = S.t != null ? S.t : compOf(S.words[0].start);
    if (t < S.timing.ip || t >= S.timing.op - 1 / fps()) t = S.timing.ip;
    const off = audioOffset(t);
    audio.currentTime = Math.max(0, Math.min(audio.duration - 0.01, off));
    try { await audio.play(); } catch (e) { notify('error', 'Playback failed: ' + e.message); return; }
    playing = true;
    S.pin = null;
    setPlayUI();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (!playing) return;
    playing = false;
    audio.pause();
    cancelAnimationFrame(raf);
    setPlayUI();
    if (S.t != null) {
      const t = snap(S.t);
      S.t = t;
      S.pin = { t, i: S.cur, j: S.phone };
      $('tc').textContent = tc(t);
      pushTime(t);
      drawWave();
    }
  }

  function tick(now) {
    if (!playing) return;
    const t = compOf(S.range[0] + audio.currentTime);
    if (audio.ended || t >= S.timing.op) { stop(); return; }
    S.t = t;
    $('tc').textContent = tc(t);
    const i = wordAt(t), j = i >= 0 ? phoneAt(i, t) : 0;
    if (i !== S.cur) { S.cur = i; S.phone = j; paintCurrent(true); }
    else if (j !== S.phone) { S.phone = j; renderSounds(); drawWave(); }
    else drawWave();
    if (now - lastPush > 200) { lastPush = now; pushTime(snap(t)); }
    raf = requestAnimationFrame(tick);
  }

  $('btnPlay').onclick = () => (playing ? stop() : play());
  // Space plays/pauses while the panel has focus (not while typing).
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || S.editing) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    if (playing) stop(); else play();
  });

  // ----------------------------------------------------------------- editing
  // Double-click a word to edit it. Enter or clicking away saves, Esc cancels,
  // Tab / Shift+Tab save and move to the next / previous word. Typing several
  // words splits the original's time across them; clearing a word deletes it.
  const normW = (w) => w.toLowerCase().replace(/[^\w']/g, '');

  function startEdit(i) {
    const el = S.els[i];
    if (!el || S.editing) return;
    S.editing = true;
    const input = document.createElement('input');
    input.className = 'w-edit';
    input.value = S.words[i].word;
    input.setAttribute('aria-label', 'Edit word');
    const fit = () => { input.size = Math.max(2, input.value.length + 1); };
    fit();
    el.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit, move) => {
      if (done) return;
      done = true;
      S.editing = false;
      if (commit) applyEdit(i, input.value, move);
      else { input.replaceWith(el); el.focus(); }
    };
    input.addEventListener('input', fit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true, 0); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false, 0); }
      else if (ev.key === 'Tab') { ev.preventDefault(); finish(true, ev.shiftKey ? -1 : 1); }
    });
    input.addEventListener('blur', () => finish(true, 0));
  }

  function applyEdit(i, text, move) {
    const old = S.words[i];
    const toks = text.trim().split(/\s+/).filter(Boolean);
    const same = toks.length === 1 && toks[0] === old.word;
    if (!same) {
      S.undo.push(JSON.stringify(S.words));
      if (S.undo.length > 100) S.undo.shift();
      const total = toks.reduce((n, t) => n + t.length, 0) || 1;
      const span = old.end - old.start;
      let t = old.start;
      const repl = toks.map((tk) => {
        const d = span * tk.length / total;
        const keep = toks.length === 1 && normW(tk) === normW(old.word);
        const w = { word: tk, start: +t.toFixed(3), end: +(t + d).toFixed(3), seg: old.seg,
          phones: keep ? old.phones : undefined, edited: !keep || old.edited };
        t += d;
        return w;
      });
      S.words.splice(i, 1, ...repl);
      wordsChanged();
      status(toks.length ? 'Edited · ⌘Z to undo' : 'Word removed · ⌘Z to undo');
      if (move) {
        const ni = move > 0 ? i + repl.length : i - 1;
        if (ni >= 0 && ni < S.words.length) startEdit(ni);
      }
      return;
    }
    renderTranscript();
    if (move) {
      const ni = i + move;
      if (ni >= 0 && ni < S.words.length) startEdit(ni);
    }
  }

  function wordsChanged() {
    S.pin = null;
    if (S.cur >= S.words.length) S.cur = S.words.length - 1;
    S.cards = buildCards();
    renderTranscript();
    saveData();
  }

  function undo() {
    if (!S.undo.length) { status('Nothing to undo'); return; }
    S.words = JSON.parse(S.undo.pop());
    wordsChanged();
    status('Undone');
  }

  // ------------------------------------------------------------------ wiring
  function setMode(m) {
    S.mode = m;
    $('modeWords').setAttribute('aria-pressed', String(m === 'words'));
    $('modeSounds').setAttribute('aria-pressed', String(m === 'sounds'));
    renderSounds();
  }
  // ---------------------------------------------------------------- box style
  // The Box controls and the Highlight/Box buttons edit the selected captions
  // rig live (or the only rig in the comp). With no rig, they set the defaults
  // for new captions. Edits to a rig also become the new defaults.
  const BG_LABEL = { off: 'Off', line: 'Per line', block: 'Block' };
  // "pad" is the uniform Padding slider: it sets X and Y together. Ticking
  // "Separate X and Y" swaps it for individual X and Y sliders.
  const BOX = [
    { key: 'pad', id: 'Pad', max: 200 },
    { key: 'padX', id: 'PadX', max: 200 }, { key: 'padY', id: 'PadY', max: 200 },
    { key: 'round', id: 'Round', max: 200 }, { key: 'opacity', id: 'Opacity', max: 100 }];

  function rigMode() { return !S.rig ? settings.bg : (S.rig.bg != 1 ? 'off' : S.rig.perLine == 1 ? 'line' : 'block'); }
  function rigHL() { return S.rig ? S.rig.hl == 1 : settings.highlight; }

  function renderToggles() {
    const on = rigHL(), mode = rigMode();
    $('btnHighlight').setAttribute('aria-pressed', String(on));
    $('btnHighlight').textContent = 'Highlight: ' + (on ? 'On' : 'Off');
    $('btnBg').textContent = 'Box: ' + BG_LABEL[mode];
  }

  function renderBox() {
    $('rigTarget').textContent = S.rig ? 'Editing “' + S.rig.name + '”' :
      S.rigMany ? 'Select a captions rig to edit it' : 'Defaults for new captions';
    $('rigTarget').title = $('rigTarget').textContent;
    const split = !!settings.box.split;
    $('splitPad').checked = split;
    $('rowPad').hidden = split;
    $('padXY').hidden = !split;
    $('btnUpdateCaps').disabled = !S.rig;
    $('btnUpdateCaps').title = S.rig ? 'Rewrite “' + S.rig.name + '” from the current transcript' :
      'Select a captions rig to update it';
    BOX.forEach((b) => {
      const key = b.key === 'pad' ? 'padX' : b.key;
      const v = S.rig ? S.rig[key] : settings.box[key];
      if (v == null) return;
      const r = $('sl' + b.id), n = $('n' + b.id);
      if (!(S.rigDrag && document.activeElement === r)) r.value = Math.min(b.max, v);
      if (document.activeElement !== n) n.value = Math.round(v);
    });
    renderToggles();
    renderPreview();
  }

  // Sends rig changes one at a time, always the latest value per control.
  const rigPending = {};
  let rigSending = false;
  async function sendRig(key, value) {
    if (!S.rig) return;
    rigPending[key] = value;
    if (rigSending) return;
    rigSending = true;
    while (Object.keys(rigPending).length && S.rig) {
      const k = Object.keys(rigPending)[0], v = rigPending[k];
      delete rigPending[k];
      const r = await esJSON('as_setRig(' + S.rig.id + ',' + JSON.stringify(k) + ',' + v + ')');
      if (!r.ok) { notify('error', r.err); S.rig = null; renderBox(); break; }
    }
    rigSending = false;
  }

  function setOne(key, v) {
    if (S.rig) {
      S.rig[key] = v;
      sendRig(key, v);
      settings.box[key] = key === 'opacity' ? v : Math.round(v * 1080 / (S.rig.h || 1080));
    } else settings.box[key] = v;
  }
  function setBoxValue(b, v) {
    v = Math.max(0, Math.min(b.key === 'opacity' ? 100 : 999, Number(v) || 0));
    if (b.key === 'pad') { setOne('padX', v); setOne('padY', v); }
    else setOne(b.key, v);
    saveSettings();
    const r = $('sl' + b.id), n = $('n' + b.id);
    if (document.activeElement !== r) r.value = Math.min(b.max, v);
    if (document.activeElement !== n) n.value = Math.round(v);
    renderPreview();
  }
  $('splitPad').addEventListener('change', () => {
    settings.box.split = $('splitPad').checked;
    // Back to uniform: Y follows X.
    if (!settings.box.split) {
      const x = S.rig ? S.rig.padX : settings.box.padX;
      if (x != null) { setOne('padY', x); }
    }
    saveSettings();
    renderBox();
  });

  async function updateCaptions() {
    if (!S.rig) { notify('error', 'Select the captions rig you want to update.'); return; }
    if (!S.layer || !S.words.length) { notify('error', 'Transcribe the dialogue layer first.'); return; }
    const cards = buildCards(S.rig.lines);
    if (!cards.length) { notify('error', 'No words fall inside the layer’s in and out points.'); return; }
    const file = path.join(os.tmpdir(), 'audioscribe_captions.json');
    fs.writeFileSync(file, JSON.stringify({ cards: cards.map((c) => ({ start: c.start, end: c.end,
      lines: c.lines.map((l) => ({ text: l.text, words: l.words })) })) }), 'utf8');
    $('btnUpdateCaps').disabled = true;
    busy('Updating “' + S.rig.name + '”…', null);
    await new Promise((r) => setTimeout(r, 60));
    const r = await esJSON('as_updateCaptions(' + JSON.stringify(file) + ',' + S.rig.id + ')');
    busyEnd();
    $('btnUpdateCaps').disabled = !S.rig;
    if (r.ok) notify('ok', 'Updated “' + r.name + '”: ' + r.cards + ' captions from the current transcript. Styling was kept.');
    else notify('error', r.err);
  }

  BOX.forEach((b) => {
    const r = $('sl' + b.id), n = $('n' + b.id);
    r.max = b.max;
    r.addEventListener('pointerdown', () => { S.rigDrag = true; });
    r.addEventListener('pointerup', () => { S.rigDrag = false; });
    r.addEventListener('input', () => { n.value = r.value; setBoxValue(b, r.value); });
    r.addEventListener('change', () => { S.rigDrag = false; });
    n.addEventListener('change', () => setBoxValue(b, n.value));
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setBoxValue(b, n.value); n.blur(); } });
  });

  async function pollRig() {
    try {
      if (!S.busy && !document.hidden && !S.rigDrag && !rigSending) {
        const r = await esJSON('as_getRig()');
        if (r.ok) { S.rig = r.found ? r : null; S.rigMany = !!r.many; renderBox(); }
      }
    } catch (e) { /* AE busy; try again */ }
    setTimeout(pollRig, 800);
  }

  function setBg(v) {
    settings.bg = v; saveSettings();
    if (S.rig) {
      S.rig.bg = v === 'off' ? 0 : 1;
      sendRig('bg', S.rig.bg);
      if (v !== 'off') { S.rig.perLine = v === 'line' ? 1 : 0; sendRig('perLine', S.rig.perLine); }
    }
    renderToggles();
    renderPreview();
  }
  function setHighlight(on) {
    settings.highlight = on; saveSettings();
    if (S.rig) { S.rig.hl = on ? 1 : 0; sendRig('hl', S.rig.hl); }
    renderToggles();
    renderPreview();
  }

  $('transcript').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) goTo(Number(b.dataset.i), 0);
  });
  $('phones').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-j]');
    if (b) goTo(Math.max(0, S.cur), Number(b.dataset.j));
  });
  $('transcript').addEventListener('dblclick', (e) => {
    const b = e.target.closest('button.w');
    if (b) startEdit(Number(b.dataset.i));
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !S.editing &&
      !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      undo();
    }
  });
  $('busyCancel').onclick = () => { if (onCancel) onCancel(); };
  $('noticeClose').onclick = () => { $('notice').hidden = true; };
  $('prevPhone').onclick = () => step(-1);
  $('nextPhone').onclick = () => step(1);
  $('modeWords').onclick = () => setMode('words');
  $('modeSounds').onclick = () => setMode('sounds');
  $('btnTranscribe').onclick = transcribe;
  $('btnCaptions').onclick = createCaptions;
  $('btnUpdateCaps').onclick = updateCaptions;
  $('btnHighlight').onclick = () => setHighlight(!rigHL());
  $('btnBg').onclick = () => setBg({ off: 'line', line: 'block', block: 'off' }[rigMode()] || 'line');
  $('find').addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
  // Tabs: Transcript, Captions, Settings. Arrow keys move between tabs.
  const TABS = ['Transcript', 'Captions', 'Settings'];
  function showTab(name, focus) {
    TABS.forEach((t) => {
      const on = t === name, b = $('tabBtn' + t);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('tab' + t).hidden = !on;
      if (on && focus) b.focus();
    });
    try { sessionStorage.setItem('audioscribe.tab', name); } catch (e) { /* ignore */ }
    if (name === 'Transcript') drawWave();
    if (name === 'Captions') { renderPreview(); renderBox(); }
  }
  TABS.forEach((t, k) => {
    const b = $('tabBtn' + t);
    b.onclick = () => showTab(t);
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      showTab(TABS[(k + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], true);
    });
  });

  const bind = (id, key, num) => {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('change', () => {
      settings[key] = key === 'lines' ? (Number(el.value) === 1 ? 1 : 2) :
        num ? Math.max(12, Number(el.value) || defaults[key]) : el.value.trim();
      saveSettings();
      if (key === 'color') document.documentElement.style.setProperty('--playhead', settings.color);
      if (key === 'chars' || key === 'lines') { S.cards = buildCards(); renderPreview(); drawWave(); }
    });
  };
  bind('setPython', 'python'); bind('setMfa', 'mfa'); bind('setModel', 'model');
  bind('setLang', 'lang'); bind('setChars', 'chars', true); bind('setColor', 'color');
  bind('setRange', 'range'); bind('setRepo', 'repo'); bind('setToken', 'token');
  bind('setLines', 'lines', true);
  setBg(settings.bg);
  { const found = detectPython(); if (found) $('setPython').placeholder = 'auto: ' + found; }
  document.documentElement.style.setProperty('--playhead', settings.color);
  settings.box = Object.assign({}, defaults.box, settings.box);
  { let t = null; try { t = sessionStorage.getItem('audioscribe.tab'); } catch (e) { /* ignore */ }
    showTab(TABS.indexOf(t) >= 0 ? t : 'Transcript'); }
  setHighlight(settings.highlight);
  renderBox();
  pollRig();

  poll();
})();
