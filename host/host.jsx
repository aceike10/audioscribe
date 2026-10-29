/* AudioScribe v2 — ExtendScript host side.
   Every function returns a JSON string. Words stay in SOURCE time on the
   panel side; this file only reports layer timing and writes to the comp. */

function _q(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
}
function _j(o) {
  if (o === null || o === undefined) return 'null';
  var t = typeof o;
  if (t === 'number') return isFinite(o) ? String(o) : 'null';
  if (t === 'boolean') return String(o);
  if (t === 'string') return _q(o);
  if (o instanceof Array) {
    var a = [];
    for (var i = 0; i < o.length; i++) a.push(_j(o[i]));
    return '[' + a.join(',') + ']';
  }
  var p = [];
  for (var k in o) if (o.hasOwnProperty(k)) p.push(_q(k) + ':' + _j(o[k]));
  return '{' + p.join(',') + '}';
}
function _comp() {
  var c = app.project.activeItem;
  return (c && c instanceof CompItem) ? c : null;
}
function _layer(id) {
  try { return app.project.layerByID(id); } catch (e) { return null; }
}
function _readJSON(path) {
  var f = new File(path);
  f.encoding = 'UTF-8';
  if (!f.open('r')) throw new Error('Could not read ' + path);
  var s = f.read();
  f.close();
  return eval('(' + s + ')');
}

function as_getLayer() {
  var c = _comp();
  if (!c) return _j({ ok: false, err: "Open a comp first." });
  var sel = c.selectedLayers;
  if (!sel.length) return _j({ ok: false, err: "Select a layer with dialogue in the timeline." });
  var L = sel[0];
  var isFile = (L instanceof AVLayer) && (L.source instanceof FootageItem) &&
    (L.source.mainSource instanceof FileSource) && L.source.file;
  if (!isFile) return _j({ ok: false, err: "Select a footage layer. Precomps aren't supported in v1." });
  if (!L.hasAudio) return _j({ ok: false, err: "That layer has no audio." });
  return _j({
    ok: true, comp: c.name, fps: c.frameRate, id: L.id, index: L.index, name: L.name,
    path: L.source.file.fsName, st: L.startTime, sr: L.stretch,
    ip: L.inPoint, op: L.outPoint, remap: L.timeRemapEnabled
  });
}

function as_getTime(id) {
  var c = _comp();
  if (!c) return _j({ ok: false });
  var L = _layer(id);
  if (!L || L.containingComp.id !== c.id) return _j({ ok: true, here: false, t: c.time, fps: c.frameRate });
  return _j({
    ok: true, here: true, t: c.time, fps: c.frameRate,
    st: L.startTime, sr: L.stretch, ip: L.inPoint, op: L.outPoint, remap: L.timeRemapEnabled
  });
}

function as_setTime(t) {
  var c = _comp();
  if (c) c.time = t;
  return 'ok';
}

/* ------------------------------------------------------------- captions
   A caption rig:
     Captions – <name>                 null holding every control (Effect Controls)
       · Line 1 … · Line N             one text layer per line, top to bottom (N = 1–4)
       · BG Line 1 … · BG Line N       rounded box behind each line
       · BG Block                      one rounded box around all lines
   Captions with fewer lines than N fill the bottom lines, so text stays
   anchored to the null. Word highlight: each word has a marker whose comment
   starts with its index in that line ("-1" clears), read by a Range Selector.
   Rigs from before 2.6 used "· Top" / "· Bottom"; Update converts them. */

function _hasLayer(c, n) {
  for (var i = 1; i <= c.numLayers; i++) if (c.layer(i).name === n) return true;
  return false;
}
function _uniqueName(c, base) {
  var n = base, k = 2;
  while (_hasLayer(c, n)) { n = base + ' ' + k; k++; }
  return n;
}
function _fx(L, type, name, val) {
  var e = L.property('ADBE Effect Parade').addProperty(type);
  e.name = name;
  if (val !== undefined) e.property(1).setValue(val);
  return e;
}

function _hlExpr(plusOne) {
  return [
    'var m = thisLayer.marker, i = -1;',
    'if (m.numKeys > 0) {',
    '  var k = m.nearestKey(time).index;',
    '  if (m.key(k).time > time) k--;',
    '  if (k > 0) i = parseInt(m.key(k).comment, 10);',
    '}',
    'i < 0 ? 0 : i' + (plusOne ? ' + 1' : '') + ';'
  ].join('\n');
}

// Shared prelude for background expressions: box(name) returns the comp-space
// bounds [x1, y1, x2, y2] of a caption line, or null when that line is blank.
function _expr(prop, code, label) {
  try { prop.expression = code; }
  catch (e) { throw new Error(label + ': ' + e.toString()); }
}

function _addHighlight(L) {
  var anims = L.property('ADBE Text Properties').property('ADBE Text Animators');
  anims.addProperty('ADBE Text Animator');
  var idx = anims.numProperties;
  // Add everything first; adding invalidates earlier references (see _bgShape).
  anims.property(idx).property('ADBE Text Animator Properties').addProperty('ADBE Text Fill Color');
  anims.property(idx).property('ADBE Text Selectors').addProperty('ADBE Text Selector');
  var anim = L.property('ADBE Text Properties').property('ADBE Text Animators').property(idx);
  anim.name = 'Word Highlight';
  var fill = anim.property('ADBE Text Animator Properties').property('ADBE Text Fill Color');
  _expr(fill, 'thisLayer.parent.effect("Highlight Color")("Color");', L.name + ' highlight color');
  var sel = anim.property('ADBE Text Selectors').property(1);
  var adv = sel.property('ADBE Text Range Advanced');
  adv.property('ADBE Text Range Units').setValue(2);   // Index
  adv.property('ADBE Text Range Type2').setValue(3);   // Based On: Words
  _expr(sel.property('ADBE Text Index Start'), _hlExpr(false), L.name + ' highlight start');
  _expr(sel.property('ADBE Text Index End'), _hlExpr(true), L.name + ' highlight end');
  try {
    adv.property('ADBE Text Selector Max Amount').expression =
      'thisLayer.parent.effect("Word Highlight")("Checkbox") == 1 ? 100 : 0;';
  } catch (e) { /* older AE: highlight stays on; delete the animator to turn it off */ }
}

// list: [{t, v}] sorted by time; later entries at the same time win.
function _setTexts(L, list) {
  var st = L.property('ADBE Text Properties').property('ADBE Text Document');
  var td = st.value;
  for (var i = 0; i < list.length; i++) {
    td.text = list[i].v;
    st.setValueAtTime(list[i].t, td);
  }
}
function _setMarkers(L, list) {
  var m = L.property('ADBE Marker');
  for (var i = 0; i < list.length; i++) m.setValueAtTime(list[i].t, new MarkerValue(list[i].v));
}
function _sortKeys(list) {
  // Stable by time, then by order added (clears are added before words).
  for (var i = 0; i < list.length; i++) list[i].o = i;
  list.sort(function (a, b) { return a.t !== b.t ? a.t - b.t : a.o - b.o; });
  // One key per time: the last one added at that time wins.
  var out = [];
  for (var j = 0; j < list.length; j++) {
    if (out.length && Math.abs(out[out.length - 1].t - list[j].t) < 1e-6) out[out.length - 1] = list[j];
    else out.push(list[j]);
  }
  return out;
}

// Writes Source Text keys (one per caption) and word markers to the line layers.
// Returns the number of words placed.

// Shared prelude for box expressions. box(name) returns the comp-space bounds
// [x1, y1, x2, y2] of a caption line, or null when that line is blank. With
// Uniform Height on, the vertical extent comes from the font size rather than
// the glyphs, so capitals and descenders don't change the box height.
function _boxPrelude() {
  return [
    'var C = thisLayer.parent;',
    'var uni = true;',
    'try { uni = C.effect("Uniform Height")("Checkbox") == 1; } catch (e) {}',
    'function box(n) {',
    '  var L = thisComp.layer(n);',
    '  var s = L.text.sourceText.value;',
    '  s = (s && s.text !== undefined) ? s.text : String(s);',
    '  if (s.replace(/\\s/g, "") === "") return null;',
    '  var r = L.sourceRectAtTime(time, false);',
    '  var y1 = r.top, y2 = r.top + r.height;',
    '  if (uni) {',
    '    var fs = r.height;',
    '    try { fs = L.text.sourceText.style.fontSize; } catch (e) {}',
    '    y1 = -0.76 * fs; y2 = 0.24 * fs;',
    '  }',
    '  var a = L.toComp([r.left, y1]), b = L.toComp([r.left + r.width, y2]);',
    '  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];',
    '}',
    'function merge(p, q) {',
    '  if (!p) return q;',
    '  if (!q) return p;',
    '  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])];',
    '}',
    'function mergeAll(a) { var o = null; for (var i = 0; i < a.length; i++) o = merge(o, a[i]); return o; }'
  ].join('\n') + '\n';
}

function _bgShape(c, name, ctrl, boxExpr, perLine) {
  var S = c.layers.addShape();
  S.name = name;
  var grp = S.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group');
  grp.name = 'Box';
  var cont = grp.property('ADBE Vectors Group');
  // Adding a property invalidates references to its siblings in AE, so add
  // everything first, then fetch fresh references.
  cont.addProperty('ADBE Vector Shape - Rect');
  cont.addProperty('ADBE Vector Graphic - Fill');
  cont = S.property('ADBE Root Vectors Group').property(1).property('ADBE Vectors Group');
  var rect = cont.property('ADBE Vector Shape - Rect');
  var fill = cont.property('ADBE Vector Graphic - Fill');
  S.parent = ctrl;
  var pre = _boxPrelude() + 'var B = ' + boxExpr + ';\n';
  _expr(rect.property('ADBE Vector Rect Size'), pre +
    'B ? [B[2] - B[0] + 2 * C.effect("Padding X")("Slider"), B[3] - B[1] + 2 * C.effect("Padding Y")("Slider")] : [0, 0];',
    name + ' size');
  _expr(rect.property('ADBE Vector Rect Position'), pre +
    'B ? fromComp([(B[0] + B[2]) / 2, (B[1] + B[3]) / 2]) : [0, 0];', name + ' position');
  _expr(rect.property('ADBE Vector Rect Roundness'), 'thisLayer.parent.effect("Roundness")("Slider");', name + ' roundness');
  _expr(fill.property('ADBE Vector Fill Color'), 'thisLayer.parent.effect("BG Color")("Color");', name + ' color');
  _expr(S.property('ADBE Transform Group').property('ADBE Opacity'), pre +
    'var on = C.effect("Background")("Checkbox") == 1 && C.effect("Per Line")("Checkbox") == ' + (perLine ? 1 : 0) + ';\n' +
    'on && B ? C.effect("BG Opacity")("Slider") : 0;', name + ' opacity');
  return S;
}

// Text style carried into new line layers: from the panel for a new rig, or
// read from an existing line layer when updating.
function _applyStyle(td, st) {
  var set = function (k) { if (st[k] !== undefined && st[k] !== null) { try { td[k] = st[k]; } catch (e) { /* not settable here */ } } };
  set('fontSize');
  if (st.font) { try { td.font = st.font; } catch (e) { /* font missing: AE keeps its default */ } }
  set('applyFill'); if (st.applyFill !== false) set('fillColor');
  set('applyStroke'); if (st.applyStroke) { set('strokeColor'); set('strokeWidth'); set('strokeOverFill'); }
  set('tracking'); set('allCaps'); set('smallCaps'); set('fauxBold'); set('fauxItalic');
  td.justification = ParagraphJustification.CENTER_JUSTIFY;
}
function _styleOf(L) {
  var p = L.property('ADBE Text Properties').property('ADBE Text Document');
  var td = p.numKeys ? p.keyValue(1) : p.value;
  // Prefer a key with real text; blank keys can carry default styling.
  for (var k = 1; k <= p.numKeys; k++) {
    var v = p.keyValue(k);
    if (String(v.text).replace(/\s/g, '') !== '') { td = v; break; }
  }
  var st = {}, keys = ['font', 'fontSize', 'applyFill', 'fillColor', 'applyStroke', 'strokeColor',
    'strokeWidth', 'strokeOverFill', 'tracking', 'allCaps', 'smallCaps', 'fauxBold', 'fauxItalic'];
  for (var i = 0; i < keys.length; i++) { try { st[keys[i]] = td[keys[i]]; } catch (e) { /* unavailable */ } }
  return st;
}

function _textLayer(c, name, style, ctrl, k, n) {
  var L = c.layers.addText(' ');
  L.name = name;
  var st = L.property('ADBE Text Properties').property('ADBE Text Document');
  var td = st.value;
  _applyStyle(td, style);
  td.text = ' ';
  st.setValue(td);
  L.parent = ctrl;
  var pos = L.property('ADBE Transform Group').property('ADBE Position');
  if (k === n) pos.setValue([0, 0]);
  else _expr(pos, '[0, -' + (n - k) + ' * thisLayer.parent.effect("Line Spacing")("Slider")];', name + ' position');
  return L;
}

// Adds any controls the null doesn't have yet (new rigs get all of them;
// older rigs pick up newer ones such as Uniform Height on Update).
function _ensureFx(ctrl, c, d) {
  var k = c.height / 1080, bx = d.box || {}, fs = Math.round(c.height * (d.fontScale || 0.05));
  var num = function (v, dflt) { return typeof v === 'number' && isFinite(v) ? v : dflt; };
  var col = d.color || [1, 0.635, 0.231];
  var list = [
    ['ADBE Checkbox Control', 'Background', d.bg === 'off' ? 0 : 1],
    ['ADBE Checkbox Control', 'Per Line', d.bg === 'block' ? 0 : 1],
    ['ADBE Checkbox Control', 'Uniform Height', bx.uniform === false ? 0 : 1],
    ['ADBE Slider Control', 'Padding X', Math.round(num(bx.padX, 16) * k)],
    ['ADBE Slider Control', 'Padding Y', Math.round(num(bx.padY, 16) * k)],
    ['ADBE Slider Control', 'Roundness', Math.round(num(bx.round, 16) * k)],
    ['ADBE Color Control', 'BG Color', [0, 0, 0, 1]],
    ['ADBE Slider Control', 'BG Opacity', num(bx.opacity, 70)],
    ['ADBE Slider Control', 'Line Spacing', Math.round(num(bx.spacing, 90) * k)],
    ['ADBE Checkbox Control', 'Word Highlight', d.highlight === false ? 0 : 1],
    ['ADBE Color Control', 'Highlight Color', [col[0], col[1], col[2], 1]]
  ];
  for (var i = 0; i < list.length; i++) {
    if (!ctrl.property('ADBE Effect Parade').property(list[i][1])) _fx(ctrl, list[i][0], list[i][1], list[i][2]);
  }
}

// Builds N line layers plus their boxes under the rig's null.
// Final stack: null, Line 1…N, BG Line 1…N, BG Block.
function _buildLines(c, ctrl, base, n, style, made) {
  var lines = [], i;
  for (i = 1; i <= n; i++) { lines.push(_textLayer(c, base + ' · Line ' + i, style, ctrl, i, n)); made.push(lines[i - 1]); }
  var names = [];
  for (i = 1; i <= n; i++) names.push('box(' + _q(base + ' · Line ' + i) + ')');
  var block = _bgShape(c, base + ' · BG Block', ctrl, 'mergeAll([' + names.join(', ') + '])', false);
  made.push(block);
  var bgs = [];
  for (i = 1; i <= n; i++) { bgs.push(_bgShape(c, base + ' · BG Line ' + i, ctrl, names[i - 1], true)); made.push(bgs[i - 1]); }
  block.moveAfter(ctrl);
  for (i = n - 1; i >= 0; i--) bgs[i].moveAfter(ctrl);
  for (i = n - 1; i >= 0; i--) lines[i].moveAfter(ctrl);
  return lines;
}

// Writes Source Text keys (one per caption) and word markers to the line
// layers L (top to bottom). Returns the number of words placed.
function _writeCaptionKeys(d, L) {
  var N = L.length, BLANK = ' ', T = [], M = [], k, i, j;
  for (k = 0; k < N; k++) { T.push([]); M.push([]); }
  if (d.cards[0].start > 0) for (k = 0; k < N; k++) T[k].push({ t: 0, v: BLANK });
  var nWords = 0;
  for (i = 0; i < d.cards.length; i++) {
    var card = d.cards[i], ls = card.lines.slice(-N), off = N - ls.length;
    for (k = 0; k < N; k++) {
      T[k].push({ t: card.start, v: k >= off ? ls[k - off].text : BLANK });
      M[k].push({ t: card.start, v: '-1' }); // clear highlight from the previous caption
    }
    for (j = 0; j < ls.length; j++) {
      k = j + off;
      for (var w = 0; w < ls[j].words.length; w++) M[k].push({ t: ls[j].words[w].t, v: w + ' ' + ls[j].words[w].w });
      nWords += ls[j].words.length;
      if (j + 1 < ls.length) M[k].push({ t: ls[j + 1].words[0].t, v: '-1' }); // done when the next line starts
    }
    var next = d.cards[i + 1];
    if (!next || next.start - card.end > 0.001) for (k = 0; k < N; k++) T[k].push({ t: card.end, v: BLANK });
  }
  for (k = 0; k < N; k++) { _setTexts(L[k], _sortKeys(T[k])); _setMarkers(L[k], _sortKeys(M[k])); }
  return nWords;
}

function _defaultStyle(c, d) {
  return { fontSize: Math.round(c.height * (d.fontScale || 0.05)), font: d.font || null,
    applyFill: true, fillColor: [1, 1, 1], applyStroke: false };
}

function as_makeCaptions(path) {
  var c = _comp();
  if (!c) return _j({ ok: false, err: "Open a comp first." });
  var d;
  try { d = _readJSON(path); } catch (e) { return _j({ ok: false, err: e.toString() }); }
  if (!d.cards || !d.cards.length) return _j({ ok: false, err: "No words fall inside the layer's in and out points." });
  var n = Math.max(1, Math.min(4, d.lines || 2));
  app.beginUndoGroup('AudioScribe: Create captions');
  var made = [];
  try {
    var base = _uniqueName(c, d.name);
    var ctrl = c.layers.addNull();
    made.push(ctrl);
    ctrl.name = base;
    ctrl.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([0, 0]);
    ctrl.property('ADBE Transform Group').property('ADBE Position').setValue([c.width / 2, c.height * d.yPos]);
    _ensureFx(ctrl, c, d);
    ctrl.moveToBeginning();
    var lines = _buildLines(c, ctrl, base, n, _defaultStyle(c, d), made);
    var nWords = _writeCaptionKeys(d, lines);
    for (var i = 0; i < lines.length; i++) _addHighlight(lines[i]);
    ctrl.selected = true;
    return _j({ ok: true, cards: d.cards.length, words: nWords, name: base, lines: n });
  } catch (e) {
    for (var r = made.length - 1; r >= 0; r--) { try { made[r].remove(); } catch (e2) { /* already gone */ } }
    return _j({ ok: false, err: 'Captions failed. ' + e.toString() + (e.line ? ' (host line ' + e.line + ')' : '') });
  } finally {
    app.endUndoGroup();
  }
}

/* ------------------------------------------------------- caption rig styling
   The panel's controls drive the controller null of the selected rig. */

var RIG_FX = { padX: 'Padding X', padY: 'Padding Y', round: 'Roundness', opacity: 'BG Opacity',
  bg: 'Background', perLine: 'Per Line', hl: 'Word Highlight', spacing: 'Line Spacing', uniform: 'Uniform Height' };

function _isRig(L) {
  try {
    var fx = L.property('ADBE Effect Parade');
    return !!(fx && fx.property('Padding X') && fx.property('Per Line') && fx.property('Roundness'));
  } catch (e) { return false; }
}
// A rig's null, or any layer parented to it.
function _rigOf(L) {
  for (var i = 0; i < 3 && L; i++) {
    if (_isRig(L)) return L;
    L = L.parent;
  }
  return null;
}
function _rigVal(R, key) {
  var p = R.property('ADBE Effect Parade').property(RIG_FX[key]);
  return p ? p.property(1).value : null;
}

// The rig's line layers (top to bottom) and every layer that belongs to it.
function _rigParts(R) {
  var c = R.containingComp, base = R.name, pre = base + ' · ', byNum = [], top = null, bot = null, all = [];
  for (var i = 1; i <= c.numLayers; i++) {
    var L = c.layer(i), n = L.name;
    if (n.indexOf(pre) !== 0) continue;
    var rest = n.slice(pre.length), m = rest.match(/^Line (\d+)$/);
    if (m) byNum[parseInt(m[1], 10)] = L;
    else if (rest === 'Top') top = L;
    else if (rest === 'Bottom') bot = L;
    if (m || /^(Top|Bottom|BG Top|BG Bottom|BG Block|BG Line \d+)$/.test(rest)) all.push(L);
  }
  var lines = [];
  for (var k = 1; k < byNum.length; k++) if (byNum[k]) lines.push(byNum[k]);
  if (!lines.length) { if (top) lines.push(top); if (bot) lines.push(bot); }
  return { lines: lines, all: all };
}

function as_getRig() {
  var c = _comp();
  if (!c) return _j({ ok: true, found: false });
  var R = null, sel = c.selectedLayers;
  for (var i = 0; i < sel.length && !R; i++) R = _rigOf(sel[i]);
  if (!R) {
    var all = [];
    for (var j = 1; j <= c.numLayers; j++) if (_isRig(c.layer(j))) all.push(c.layer(j));
    if (all.length === 1) R = all[0];
    else return _j({ ok: true, found: false, many: all.length > 1, h: c.height });
  }
  var parts = _rigParts(R);
  var out = { ok: true, found: true, id: R.id, name: R.name, h: c.height, lines: parts.lines.length };
  for (var k in RIG_FX) if (RIG_FX.hasOwnProperty(k)) out[k] = _rigVal(R, k);
  if (parts.lines.length) {
    try {
      var p = parts.lines[0].property('ADBE Text Properties').property('ADBE Text Document');
      var td = p.numKeys ? p.keyValue(1) : p.value;
      out.font = td.font; out.fontFamily = td.fontFamily; out.fontStyle = td.fontStyle;
    } catch (e) { /* older AE: no font info */ }
  }
  return _j(out);
}

function as_setRig(id, key, value) {
  var R = _layer(id);
  if (!R || !RIG_FX[key]) return _j({ ok: false, err: "That captions rig is gone." });
  var fx = R.property('ADBE Effect Parade').property(RIG_FX[key]);
  if (!fx) return _j({ ok: false, err: "This rig doesn't have a " + RIG_FX[key] + " control yet. Press Update captions to upgrade it." });
  var p = fx.property(1);
  app.beginUndoGroup('AudioScribe: ' + RIG_FX[key]);
  try {
    if (p.numKeys > 0) p.setValueAtTime(R.containingComp.time, value);
    else p.setValue(value);
  } catch (e) {
    return _j({ ok: false, err: e.toString() });
  } finally {
    app.endUndoGroup();
  }
  return _j({ ok: true });
}

// Sets the font on every caption keyframe of the rig's line layers.
function as_setRigFont(id, ps) {
  var R = _layer(id);
  if (!R || !_isRig(R)) return _j({ ok: false, err: "That captions rig is gone." });
  var lines = _rigParts(R).lines;
  app.beginUndoGroup('AudioScribe: Caption font');
  try {
    for (var i = 0; i < lines.length; i++) {
      var p = lines[i].property('ADBE Text Properties').property('ADBE Text Document'), td;
      if (p.numKeys === 0) { td = p.value; td.font = ps; p.setValue(td); continue; }
      for (var k = 1; k <= p.numKeys; k++) { td = p.keyValue(k); td.font = ps; p.setValueAtKey(k, td); }
    }
    var chk = lines.length ? lines[0].property('ADBE Text Properties').property('ADBE Text Document').value.font : ps;
    if (chk !== ps) return _j({ ok: false, err: "After Effects couldn't use that font (" + ps + ")." });
    return _j({ ok: true });
  } catch (e) {
    return _j({ ok: false, err: 'Font change failed. ' + e.toString() });
  } finally {
    app.endUndoGroup();
  }
}

// Installed fonts grouped by family (AE 2024 and later).
function as_getFonts() {
  try {
    if (!app.fonts || !app.fonts.allFonts) return _j({ ok: false, err: 'Font list needs After Effects 2024 or later.' });
    var groups = app.fonts.allFonts, out = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g || !g.length) continue;
      var styles = [];
      for (var j = 0; j < g.length; j++) styles.push([g[j].styleName, g[j].postScriptName]);
      out.push({ f: g[0].familyName, s: styles });
    }
    return _j({ ok: true, fonts: out });
  } catch (e) {
    return _j({ ok: false, err: 'Couldn\'t read fonts: ' + e.toString() });
  }
}

/* ------------------------------------------------------------ update captions
   Rebuilds an existing rig's line and box layers from the current transcript,
   at the panel's line count. Keeps the null (position, every control) and the
   text style (font, size, color, stroke, tracking). Old line layers are set
   aside and only removed once the new ones are built. */

function as_updateCaptions(path, id) {
  var R = _layer(id);
  if (!R || !_isRig(R)) return _j({ ok: false, err: "Select the captions rig to update." });
  var c = R.containingComp;
  var d;
  try { d = _readJSON(path); } catch (e) { return _j({ ok: false, err: e.toString() }); }
  if (!d.cards || !d.cards.length) return _j({ ok: false, err: "No words fall inside the layer's in and out points." });
  var n = Math.max(1, Math.min(4, d.lines || 2));
  var parts = _rigParts(R);
  var style = parts.lines.length ? _styleOf(parts.lines[0]) : _defaultStyle(c, d);
  app.beginUndoGroup('AudioScribe: Update captions');
  var made = [], oldNames = [];
  try {
    for (var i = 0; i < parts.all.length; i++) { oldNames.push(parts.all[i].name); parts.all[i].name = parts.all[i].name + ' (old)'; }
    _ensureFx(R, c, d);
    var lines = _buildLines(c, R, R.name, n, style, made);
    var nWords = _writeCaptionKeys(d, lines);
    for (var j = 0; j < lines.length; j++) _addHighlight(lines[j]);
    for (var k = parts.all.length - 1; k >= 0; k--) parts.all[k].remove();
    return _j({ ok: true, cards: d.cards.length, words: nWords, name: R.name, lines: n });
  } catch (e) {
    for (var r = made.length - 1; r >= 0; r--) { try { made[r].remove(); } catch (e2) { /* gone */ } }
    for (var q = 0; q < parts.all.length; q++) { try { parts.all[q].name = oldNames[q]; } catch (e3) { /* gone */ } }
    return _j({ ok: false, err: 'Update failed. ' + e.toString() + (e.line ? ' (host line ' + e.line + ')' : '') });
  } finally {
    app.endUndoGroup();
  }
}
