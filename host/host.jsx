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
   Builds a caption rig:
     Captions – <name>            null with the controls (Effect Controls)
       · Top / · Bottom           text layers, one per caption line
       · BG Top / · BG Bottom     rounded box behind each line
       · BG Block                 one rounded box around all lines
   "Per Line" switches between the per-line boxes and the block box.
   Word highlight: each word has a marker whose comment starts with its index
   in that line ("-1" clears), read by a Range Selector expression. */

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
function _boxPrelude() {
  return [
    'function box(n) {',
    '  var L = thisComp.layer(n);',
    '  var s = L.text.sourceText.value;',
    '  s = (s && s.text !== undefined) ? s.text : String(s);',
    '  if (s.replace(/\\s/g, "") === "") return null;',
    '  var r = L.sourceRectAtTime(time, false);',
    '  var a = L.toComp([r.left, r.top]), b = L.toComp([r.left + r.width, r.top + r.height]);',
    '  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];',
    '}',
    'function merge(p, q) {',
    '  if (!p) return q;',
    '  if (!q) return p;',
    '  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])];',
    '}',
    'var C = thisLayer.parent;'
  ].join('\n') + '\n';
}

function _expr(prop, code, label) {
  try { prop.expression = code; }
  catch (e) { throw new Error(label + ': ' + e.toString()); }
}

function _bgShape(c, name, ctrl, boxExpr, perLine) {
  var S = c.layers.addShape();
  S.name = name;
  var grp = S.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group');
  grp.name = 'Box';
  var cont = grp.property('ADBE Vectors Group');
  var rect = cont.addProperty('ADBE Vector Shape - Rect');
  var fill = cont.addProperty('ADBE Vector Graphic - Fill');
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

function _textLayer(c, name, fontSize, ctrl) {
  var L = c.layers.addText(' ');
  L.name = name;
  var st = L.property('ADBE Text Properties').property('ADBE Text Document');
  var td = st.value;
  td.fontSize = fontSize;
  td.applyFill = true;
  td.fillColor = [1, 1, 1];
  td.applyStroke = false;
  td.justification = ParagraphJustification.CENTER_JUSTIFY;
  td.text = ' ';
  st.setValue(td);
  L.parent = ctrl;
  L.property('ADBE Transform Group').property('ADBE Position').setValue([0, 0]);
  return L;
}

function _addHighlight(L) {
  var anims = L.property('ADBE Text Properties').property('ADBE Text Animators');
  var anim = anims.addProperty('ADBE Text Animator');
  anim.name = 'Word Highlight';
  var fill = anim.property('ADBE Text Animator Properties').addProperty('ADBE Text Fill Color');
  _expr(fill, 'thisLayer.parent.effect("Highlight Color")("Color");', L.name + ' highlight color');
  var sel = anim.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
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

function as_makeCaptions(path) {
  var c = _comp();
  if (!c) return _j({ ok: false, err: "Open a comp first." });
  var d;
  try { d = _readJSON(path); } catch (e) { return _j({ ok: false, err: e.toString() }); }
  if (!d.cards || !d.cards.length) return _j({ ok: false, err: "No words fall inside the layer's in and out points." });

  app.beginUndoGroup('AudioScribe: Create captions');
  var made = [];
  try {
    var two = d.lines === 2;
    var fs = Math.round(c.height * d.fontScale);
    var base = _uniqueName(c, d.name);
    var BLANK = ' ';

    var ctrl = c.layers.addNull();
    made.push(ctrl);
    ctrl.name = base;
    ctrl.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([0, 0]);
    ctrl.property('ADBE Transform Group').property('ADBE Position').setValue([c.width / 2, c.height * d.yPos]);
    _fx(ctrl, 'ADBE Checkbox Control', 'Background', d.bg !== 'off' ? 1 : 0);
    _fx(ctrl, 'ADBE Checkbox Control', 'Per Line', d.bg === 'block' ? 0 : 1);
    _fx(ctrl, 'ADBE Slider Control', 'Padding X', Math.round(fs * 0.5));
    _fx(ctrl, 'ADBE Slider Control', 'Padding Y', Math.round(fs * 0.25));
    _fx(ctrl, 'ADBE Slider Control', 'Roundness', Math.round(fs * 0.35));
    _fx(ctrl, 'ADBE Color Control', 'BG Color', [0, 0, 0, 1]);
    _fx(ctrl, 'ADBE Slider Control', 'BG Opacity', 70);
    _fx(ctrl, 'ADBE Slider Control', 'Line Spacing', Math.round(fs * 1.35));
    _fx(ctrl, 'ADBE Checkbox Control', 'Word Highlight', d.highlight ? 1 : 0);
    _fx(ctrl, 'ADBE Color Control', 'Highlight Color', [d.color[0], d.color[1], d.color[2], 1]);

    var nTop = base + ' · Top', nBot = base + ' · Bottom';
    // Text layers first: the boxes' expressions look them up by name.
    var bot = _textLayer(c, nBot, fs, ctrl);
    made.push(bot);
    var top = null;
    if (two) {
      top = _textLayer(c, nTop, fs, ctrl);
      made.push(top);
      _expr(top.property('ADBE Transform Group').property('ADBE Position'),
        '[0, -thisLayer.parent.effect("Line Spacing")("Slider")];', nTop + ' position');
    }
    var bgBlock = _bgShape(c, base + ' · BG Block', ctrl,
      two ? 'merge(box(' + _q(nTop) + '), box(' + _q(nBot) + '))' : 'box(' + _q(nBot) + ')', false);
    made.push(bgBlock);
    var bgBot = _bgShape(c, base + ' · BG Bottom', ctrl, 'box(' + _q(nBot) + ')', true);
    made.push(bgBot);
    var bgTop = null;
    if (two) { bgTop = _bgShape(c, base + ' · BG Top', ctrl, 'box(' + _q(nTop) + ')', true); made.push(bgTop); }
    // Final stack, top to bottom: null, Top, Bottom, BG Top, BG Bottom, BG Block.
    bgBlock.moveToBeginning();
    bgBot.moveToBeginning();
    if (bgTop) bgTop.moveToBeginning();
    bot.moveToBeginning();
    if (top) top.moveToBeginning();
    ctrl.moveToBeginning();

    var tTop = [], tBot = [], mTop = [], mBot = [];
    if (d.cards[0].start > 0) {
      tBot.push({ t: 0, v: BLANK });
      if (two) tTop.push({ t: 0, v: BLANK });
    }
    var nWords = 0;
    for (var i = 0; i < d.cards.length; i++) {
      var card = d.cards[i], ls = card.lines;
      var lb = ls[ls.length - 1], lt = ls.length > 1 ? ls[0] : null;
      tBot.push({ t: card.start, v: lb.text });
      if (two) tTop.push({ t: card.start, v: lt ? lt.text : BLANK });
      // Clear any highlight left over from the previous card first.
      mBot.push({ t: card.start, v: '-1' });
      if (two) mTop.push({ t: card.start, v: '-1' });
      if (lt) {
        for (var a = 0; a < lt.words.length; a++) mTop.push({ t: lt.words[a].t, v: a + ' ' + lt.words[a].w });
        mTop.push({ t: lb.words[0].t, v: '-1' });
        nWords += lt.words.length;
      }
      for (var b = 0; b < lb.words.length; b++) mBot.push({ t: lb.words[b].t, v: b + ' ' + lb.words[b].w });
      nWords += lb.words.length;
      var next = d.cards[i + 1];
      if (!next || next.start - card.end > 0.001) {
        tBot.push({ t: card.end, v: BLANK });
        if (two) tTop.push({ t: card.end, v: BLANK });
      }
    }
    _setTexts(bot, _sortKeys(tBot));
    _setMarkers(bot, _sortKeys(mBot));
    _addHighlight(bot);
    if (two) {
      _setTexts(top, _sortKeys(tTop));
      _setMarkers(top, _sortKeys(mTop));
      _addHighlight(top);
    }
    ctrl.selected = true;
    return _j({ ok: true, cards: d.cards.length, words: nWords, name: base });
  } catch (e) {
    // Don't leave half a rig behind.
    for (var r = made.length - 1; r >= 0; r--) { try { made[r].remove(); } catch (e2) { /* already gone */ } }
    return _j({ ok: false, err: 'Captions failed. ' + e.toString() + (e.line ? ' (host line ' + e.line + ')' : '') });
  } finally {
    app.endUndoGroup();
  }
}
