/*
 * Pembaca .docx di browser (butuh JSZip + DOMParser).
 * Menghasilkan baris-baris { segs, auto, math } untuk ExamParser.
 *  - Penomoran otomatis Word (numbering.xml + style) dihitung ulang jadi label "1.", "a.", dst.
 *  - Format tebal/miring/garis bawah/superscript/subscript dipertahankan.
 *  - Warna/stabilo ditandai `mark` (dipakai untuk mendeteksi kunci).
 *  - Gambar (PNG/JPEG/GIF/BMP/EMF/WMF) diambil beserta ukurannya.
 *  - Soft line break (Shift+Enter) dipecah jadi baris terpisah.
 */
(function (root) {
  'use strict';

  const kids = (el, name) => {
    const out = [];
    if (!el) return out;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (!name || c.localName === name) out.push(c);
    }
    return out;
  };
  const kid = (el, name) => kids(el, name)[0] || null;
  const attr = (el, name) => {
    if (!el) return null;
    for (const a of el.attributes) if (a.localName === name) return a.value;
    return null;
  };
  const findDeep = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const BREAK = { brk: true };

  // ---------- Penomoran ----------
  function toRoman(n) {
    const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let o = '';
    for (const [v, s] of map) while (n >= v) { o += s; n -= v; }
    return o;
  }
  function toLetter(n) {
    const c = String.fromCharCode(97 + ((n - 1) % 26));
    return c.repeat(Math.floor((n - 1) / 26) + 1);
  }
  function fmtNum(n, fmt) {
    switch (fmt) {
      case 'lowerLetter': return toLetter(n);
      case 'upperLetter': return toLetter(n).toUpperCase();
      case 'lowerRoman': return toRoman(n);
      case 'upperRoman': return toRoman(n).toUpperCase();
      case 'decimalZero': return (n < 10 ? '0' : '') + n;
      case 'none': return '';
      default: return String(n);
    }
  }

  function readLvl(lvl) {
    return {
      start: parseInt(attr(kid(lvl, 'start'), 'val') || '1', 10),
      fmt: attr(kid(lvl, 'numFmt'), 'val') || 'decimal',
      text: attr(kid(lvl, 'lvlText'), 'val') || '',
    };
  }

  function Numbering(doc) {
    const abs = {}, nums = {};
    if (doc) {
      const r = doc.documentElement;
      for (const an of kids(r, 'abstractNum')) {
        const levels = {};
        for (const lvl of kids(an, 'lvl')) levels[attr(lvl, 'ilvl')] = readLvl(lvl);
        abs[attr(an, 'abstractNumId')] = levels;
      }
      for (const n of kids(r, 'num')) {
        const o = { abs: attr(kid(n, 'abstractNumId'), 'val'), starts: {}, defs: {} };
        for (const lo of kids(n, 'lvlOverride')) {
          const il = attr(lo, 'ilvl');
          const so = kid(lo, 'startOverride');
          if (so) o.starts[il] = parseInt(attr(so, 'val'), 10);
          const l = kid(lo, 'lvl');
          if (l) o.defs[il] = readLvl(l);
        }
        nums[attr(n, 'numId')] = o;
      }
    }
    const state = {};
    const seen = new Set();

    this.next = function (numId, ilvl) {
      const n = nums[numId];
      if (!n || !abs[n.abs]) return null;
      const lv = i => n.defs[i] || abs[n.abs][i] || { start: 1, fmt: 'decimal', text: '%' + (i + 1) + '.' };
      const st = state[n.abs] || (state[n.abs] = { c: [], pending: {} });
      if (!seen.has(numId)) {
        seen.add(numId);
        for (const il in n.starts) { st.pending[il] = n.starts[il]; st.c[il] = null; }
      }
      if (st.pending[ilvl] != null) { st.c[ilvl] = st.pending[ilvl]; delete st.pending[ilvl]; }
      else if (st.c[ilvl] == null) st.c[ilvl] = lv(ilvl).start;
      else st.c[ilvl]++;
      for (let j = ilvl + 1; j < 9; j++) st.c[j] = null;
      const def = lv(ilvl);
      let label;
      if (def.fmt === 'bullet') label = '•';
      else {
        label = def.text.replace(/%(\d)/g, (_, k) => {
          const i = parseInt(k, 10) - 1;
          const v = st.c[i] != null ? st.c[i] : lv(i).start;
          return fmtNum(v, lv(i).fmt);
        }).trim();
      }
      return { fmt: def.fmt, n: st.c[ilvl], label, ilvl, key: n.abs + ':' + ilvl };
    };
  }

  // Properti tata letak paragraf (twips / half-point) untuk merender ilustrasi.
  function applyPPr(o, pPr) {
    if (!pPr) return o;
    const ind = kid(pPr, 'ind');
    if (ind) {
      const left = attr(ind, 'left') || attr(ind, 'start');
      if (left != null) o.indLeft = parseInt(left, 10) || 0;
      if (attr(ind, 'firstLine') != null) o.firstLine = parseInt(attr(ind, 'firstLine'), 10) || 0;
      if (attr(ind, 'hanging') != null) o.firstLine = -(parseInt(attr(ind, 'hanging'), 10) || 0);
    }
    const sp = kid(pPr, 'spacing');
    if (sp) {
      if (attr(sp, 'before') != null) o.before = parseInt(attr(sp, 'before'), 10) || 0;
      if (attr(sp, 'after') != null) o.after = parseInt(attr(sp, 'after'), 10) || 0;
      if (attr(sp, 'line') != null) { o.line = parseInt(attr(sp, 'line'), 10) || 240; o.rule = attr(sp, 'lineRule') || 'auto'; }
    }
    const jc = attr(kid(pPr, 'jc'), 'val');
    if (jc) o.jc = jc === 'both' || jc === 'start' ? 'left' : jc === 'end' ? 'right' : jc;
    const tabs = kid(pPr, 'tabs');
    if (tabs) o.tabs = kids(tabs, 'tab').filter(t => attr(t, 'val') !== 'clear').map(t => parseInt(attr(t, 'pos'), 10) || 0).sort((a, b) => a - b);
    return o;
  }
  let themeFonts = { minor: 'Calibri', major: 'Calibri Light' };
  /** Nama font dari w:rFonts (langsung atau lewat font tema). */
  function fontOf(rFonts) {
    if (!rFonts) return null;
    const direct = attr(rFonts, 'ascii') || attr(rFonts, 'hAnsi');
    if (direct) return direct;
    const theme = attr(rFonts, 'asciiTheme') || attr(rFonts, 'hAnsiTheme');
    return theme ? (/^major/.test(theme) ? themeFonts.major : themeFonts.minor) : null;
  }
  function applyRPr(o, rPr) {
    if (!rPr) return o;
    const sz = attr(kid(rPr, 'sz'), 'val');
    if (sz) o.sz = parseInt(sz, 10);
    const font = fontOf(kid(rPr, 'rFonts'));
    if (font) o.font = font;
    return o;
  }

  function Styles(doc) {
    const map = {};
    let defaultPara = null;
    const base = { indLeft: 0, firstLine: 0, before: 0, after: 0, line: 240, rule: 'auto', jc: 'left', sz: 24, tabs: [] };
    if (doc) {
      const dd = kid(doc.documentElement, 'docDefaults');
      applyPPr(base, kid(kid(dd, 'pPrDefault'), 'pPr'));
      applyRPr(base, kid(kid(dd, 'rPrDefault'), 'rPr'));
      for (const s of kids(doc.documentElement, 'style')) {
        const pPr = kid(s, 'pPr');
        const numPr = kid(pPr, 'numPr');
        const id = attr(s, 'styleId');
        if (attr(s, 'type') === 'paragraph' && /^(1|true)$/.test(attr(s, 'default') || '')) defaultPara = id;
        map[id] = {
          basedOn: attr(kid(s, 'basedOn'), 'val'),
          numId: numPr ? attr(kid(numPr, 'numId'), 'val') : null,
          ilvl: numPr ? attr(kid(numPr, 'ilvl'), 'val') : null,
          pPr, rPr: kid(s, 'rPr'),
        };
      }
    }
    /** Properti paragraf gabungan: default dokumen <- rantai style <- pPr paragraf. */
    this.paraProps = function (id, pPr) {
      const chain = [];
      for (let k = id || defaultPara, i = 0; k && map[k] && i < 10; k = map[k].basedOn, i++) chain.unshift(map[k]);
      const o = Object.assign({}, base, { tabs: base.tabs.slice() });
      for (const st of chain) { applyPPr(o, st.pPr); applyRPr(o, st.rPr); }
      applyPPr(o, pPr);
      applyRPr(o, kid(pPr, 'rPr'));
      return o;
    };
    this.numPr = function (id) {
      let numId = null, ilvl = null;
      if (!id) id = defaultPara;
      for (let i = 0; id && map[id] && i < 10; i++, id = map[id].basedOn) {
        if (numId == null && map[id].numId != null) numId = map[id].numId;
        if (ilvl == null && map[id].ilvl != null) ilvl = map[id].ilvl;
      }
      return { numId, ilvl };
    };
  }

  // ---------- Gambar ----------
  function emuToTw(v) { return Math.round(parseInt(v, 10) / 635) || 0; }
  function cssToTw(style, prop) {
    const m = new RegExp(prop + '\\s*:\\s*([\\d.]+)\\s*(pt|in|cm|mm|px)?', 'i').exec(style || '');
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const f = { pt: 20, in: 1440, cm: 566.93, mm: 56.693, px: 15 }[(m[2] || 'px').toLowerCase()];
    return Math.round(v * f);
  }

  function loadImageSize(dataUrl) {
    return new Promise(res => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = dataUrl;
    });
  }

  async function makeImage(zip, rels, rid, wTw, hTw) {
    const target = rels[rid];
    if (!target) return null;
    let path = target.replace(/^\//, '');
    if (!/^word\//.test(path)) path = 'word/' + path.replace(/^\.\.\//, '');
    const f = zip.file(path);
    if (!f) return null;
    const ext = path.split('.').pop().toLowerCase();
    let b64 = await f.async('base64');
    let type = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', emf: 'emf', wmf: 'wmf', gif: 'gif', bmp: 'bmp' }[ext];
    if (!type) return null;
    const img = { type, b64, w: wTw, h: hTw };
    if (type === 'gif' || type === 'bmp') {
      const el = await loadImageSize('data:image/' + type + ';base64,' + b64);
      if (!el) return null;
      const c = document.createElement('canvas');
      c.width = el.naturalWidth; c.height = el.naturalHeight;
      c.getContext('2d').drawImage(el, 0, 0);
      img.type = 'png';
      img.b64 = c.toDataURL('image/png').split(',')[1];
    }
    if (img.type === 'png' || img.type === 'jpeg') {
      const el = await loadImageSize('data:image/' + img.type + ';base64,' + img.b64);
      if (el) {
        img.pxW = el.naturalWidth; img.pxH = el.naturalHeight;
        if (!img.w) { img.w = el.naturalWidth * 15; img.h = el.naturalHeight * 15; }
      }
    }
    if (!img.w) { img.w = 2880; img.h = 2160; }
    return img;
  }

  // ---------- Warna DrawingML ----------
  const SCHEME = {
    dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', tx1: '000000', bg1: 'FFFFFF', tx2: '44546A', bg2: 'E7E6E6',
    accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47',
    hlink: '0563C1', folHlink: '954F72', phClr: '4472C4',
  };
  const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500' };

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb(h, s, l) {
    if (!s) return [l * 255, l * 255, l * 255];
    const f = (p, q, t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
  }

  /** Warna dari elemen pembungkus (solidFill, fillRef, ...) -> '#rrggbb' atau null. */
  function colorOf(holder) {
    if (!holder) return null;
    const c = kids(holder).find(e => /^(srgbClr|schemeClr|prstClr|sysClr|scrgbClr)$/.test(e.localName));
    if (!c) return null;
    let hex = c.localName === 'srgbClr' ? attr(c, 'val')
      : c.localName === 'schemeClr' ? SCHEME[attr(c, 'val')]
      : c.localName === 'prstClr' ? PRESET[attr(c, 'val')]
      : c.localName === 'sysClr' ? (attr(c, 'lastClr') || '000000') : '000000';
    if (!hex) hex = '000000';
    let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const mod = name => { const e = kid(c, name); return e ? parseInt(attr(e, 'val'), 10) / 100000 : null; };
    const shade = mod('shade'), tint = mod('tint'), lumMod = mod('lumMod'), lumOff = mod('lumOff');
    if (shade != null) { r *= shade; g *= shade; b *= shade; }
    if (tint != null) { r += (255 - r) * (1 - tint); g += (255 - g) * (1 - tint); b += (255 - b) * (1 - tint); }
    if (lumMod != null || lumOff != null) {
      const [h, s, l] = rgbToHsl(r, g, b);
      [r, g, b] = hslToRgb(h, s, Math.min(1, Math.max(0, l * (lumMod != null ? lumMod : 1) + (lumOff || 0))));
    }
    const hx = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
    return '#' + hx(r) + hx(g) + hx(b);
  }

  // ---------- Pembacaan dokumen ----------
  async function read(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('File bukan dokumen Word (.docx) yang valid.');
    const get = async p => (zip.file(p) ? xml(await zip.file(p).async('string')) : null);
    const doc = xml(await docFile.async('string'));
    const relsDoc = await get('word/_rels/document.xml.rels');
    const rels = {};
    if (relsDoc) for (const r of kids(relsDoc.documentElement, 'Relationship')) rels[attr(r, 'Id')] = attr(r, 'Target');
    const theme = await get('word/theme/theme1.xml');
    const latin = name => { const f = findDeep(theme, name); const l = kid(f, 'latin'); return l ? attr(l, 'typeface') : null; };
    themeFonts = { minor: (theme && latin('minorFont')) || 'Calibri', major: (theme && latin('majorFont')) || 'Calibri Light' };
    const numbering = new Numbering(await get('word/numbering.xml'));
    const styles = new Styles(await get('word/styles.xml'));
    const pending = [];

    function runFmt(rPr) {
      const f = {};
      if (!rPr) return f;
      const on = name => { const e = kid(rPr, name); if (!e) return false; const v = attr(e, 'val'); return v == null || !/^(0|false|off|none)$/i.test(v); };
      if (on('b')) f.b = true;
      if (on('i')) f.i = true;
      if (on('u')) f.u = true;
      const va = attr(kid(rPr, 'vertAlign'), 'val');
      if (va === 'superscript') f.sup = true;
      if (va === 'subscript') f.sub = true;
      const color = attr(kid(rPr, 'color'), 'val');
      const hl = attr(kid(rPr, 'highlight'), 'val');
      const shd = attr(kid(rPr, 'shd'), 'fill');
      if ((color && !/^(auto|000000)$/i.test(color)) || (hl && hl !== 'none') ||
        (shd && !/^(auto|ffffff)$/i.test(shd))) f.mark = true;
      // ukuran & jenis huruf hanya dipakai saat menggambar ilustrasi
      const sz = attr(kid(rPr, 'sz'), 'val');
      if (sz) f.sz = parseInt(sz, 10);
      const font = fontOf(kid(rPr, 'rFonts'));
      if (font) f.font = font;
      return f;
    }

    function addImage(out, rid, w, h) {
      const seg = { img: null };
      out.push(seg);
      pending.push(makeImage(zip, rels, rid, w, h).then(img => { seg.img = img; }));
    }

    // ----- Shape DrawingML -> scene -----
    const DML_SHAPES = /wordprocessingGroup|wordprocessingShape|wordprocessingCanvas/;
    const num = (el, name, def) => { const v = attr(el, name); return v == null ? def : parseInt(v, 10) || 0; };

    function xfrmBox(xfrm, T) {
      const off = kid(xfrm, 'off'), ext = kid(xfrm, 'ext');
      const x = num(off, 'x', 0), y = num(off, 'y', 0), w = num(ext, 'cx', 0), h = num(ext, 'cy', 0);
      return {
        x: T.ox + x * T.sx, y: T.oy + y * T.sy, w: w * T.sx, h: h * T.sy,
        rot: num(xfrm, 'rot', 0) / 60000, flipH: attr(xfrm, 'flipH') === '1', flipV: attr(xfrm, 'flipV') === '1',
      };
    }
    function groupT(grpSpPr, box) {
      const xfrm = kid(grpSpPr, 'xfrm');
      const chOff = kid(xfrm, 'chOff'), chExt = kid(xfrm, 'chExt'), ext = kid(xfrm, 'ext');
      const cw = num(chExt, 'cx', 0) || num(ext, 'cx', 1), ch = num(chExt, 'cy', 0) || num(ext, 'cy', 1);
      const sx = box.w / (cw || 1), sy = box.h / (ch || 1);
      return { ox: box.x - num(chOff, 'x', 0) * sx, oy: box.y - num(chOff, 'y', 0) * sy, sx, sy };
    }

    function txbxParas(txbxContent) {
      const out = [];
      for (const p of kids(txbxContent, 'p')) {
        const props = styles.paraProps(attr(kid(kid(p, 'pPr'), 'pStyle'), 'val'), kid(p, 'pPr'));
        const segs = [];
        walkInline(p, segs, { math: false, floats: [] });
        const para = () => ({ segs: cur, jc: props.jc, sz: props.sz, indLeft: props.indLeft, firstLine: props.firstLine, tabs: props.tabs });
        let cur = [];
        for (const s of segs) {
          if (s === BREAK) { out.push(para()); cur = []; }
          else if (!('img' in s) && !s.scene) cur.push(Object.assign({ sz: props.sz, font: props.font }, s));
        }
        out.push(para());
      }
      return out;
    }

    function shapeItem(wsp, box) {
      const spPr = kid(wsp, 'spPr');
      const style = kid(wsp, 'style');
      const geom = attr(kid(spPr, 'prstGeom'), 'prst') || (kid(spPr, 'custGeom') ? 'rect' : 'rect');
      let fill = null;
      if (kid(spPr, 'noFill')) fill = null;
      else if (kid(spPr, 'solidFill')) fill = colorOf(kid(spPr, 'solidFill'));
      else if (kid(spPr, 'gradFill')) fill = colorOf(findDeep(kid(spPr, 'gradFill'), 'gs'));
      else if (kid(spPr, 'pattFill')) fill = colorOf(kid(kid(spPr, 'pattFill'), 'fgClr'));
      else if (style && num(kid(style, 'fillRef'), 'idx', 0) > 0) fill = colorOf(kid(style, 'fillRef'));
      const ln = kid(spPr, 'ln');
      let line = null;
      if (!(ln && kid(ln, 'noFill'))) {
        let color = ln && kid(ln, 'solidFill') ? colorOf(kid(ln, 'solidFill')) : null;
        if (!color && style && num(kid(style, 'lnRef'), 'idx', 0) > 0) color = colorOf(kid(style, 'lnRef'));
        if (!color && ln) color = '#000000';
        if (color) {
          const end = name => { const e = kid(ln, name); return e && attr(e, 'type') ? { type: attr(e, 'type'), len: attr(e, 'len') || 'med' } : null; };
          line = { color, w: num(ln, 'w', 0) || 12700, dash: attr(kid(ln, 'prstDash'), 'val'), head: ln ? end('headEnd') : null, tail: ln ? end('tailEnd') : null };
        }
      }
      const bodyPr = kid(wsp, 'bodyPr');
      const txbx = findDeep(kid(wsp, 'txbx'), 'txbxContent');
      return Object.assign({ kind: 'shape', geom, fill, line }, box, {
        text: txbx ? txbxParas(txbx) : null,
        ins: { l: num(bodyPr, 'lIns', 91440), t: num(bodyPr, 'tIns', 45720), r: num(bodyPr, 'rIns', 91440), b: num(bodyPr, 'bIns', 45720) },
        vAnchor: attr(bodyPr, 'anchor') || 't',
      });
    }

    function picItem(pic, box) {
      const blip = findDeep(pic, 'blip');
      const item = Object.assign({ kind: 'pic', img: null }, box);
      if (blip) pending.push(makeImage(zip, rels, attr(blip, 'embed'), 0, 0).then(img => { item.img = img; }));
      return item;
    }

    function groupItems(container, T, items) {
      for (const c of kids(container)) {
        if (c.localName === 'wsp') items.push(shapeItem(c, xfrmBox(kid(kid(c, 'spPr'), 'xfrm'), T)));
        else if (c.localName === 'pic') items.push(picItem(c, xfrmBox(kid(kid(c, 'spPr'), 'xfrm'), T)));
        else if (c.localName === 'grpSp') {
          const gp = kid(c, 'grpSpPr');
          groupItems(c, groupT(gp, xfrmBox(kid(gp, 'xfrm'), T)), items);
        }
      }
    }

    function sceneOf(drawing) {
      const holder = kid(drawing, 'anchor') || kid(drawing, 'inline');
      const gd = findDeep(holder, 'graphicData');
      if (!holder || !gd || !DML_SHAPES.test(attr(gd, 'uri') || '')) return null;
      const ext = kid(holder, 'extent');
      const cx = num(ext, 'cx', 0), cy = num(ext, 'cy', 0);
      const pos = name => {
        const p = kid(holder, name);
        if (!p) return null;
        const off = kid(p, 'posOffset'), al = kid(p, 'align');
        return { rel: attr(p, 'relativeFrom'), off: off ? parseInt(off.textContent, 10) || 0 : null, align: al ? al.textContent.trim() : null };
      };
      const scene = {
        anchor: holder.localName === 'anchor', behind: attr(holder, 'behindDoc') === '1',
        cx, cy, posH: pos('positionH'), posV: pos('positionV'), bg: null, items: [],
      };
      const rootEl = kids(gd)[0];
      const full = { x: 0, y: 0, w: cx, h: cy, rot: 0, flipH: false, flipV: false };
      if (!rootEl) return null;
      if (rootEl.localName === 'wgp') groupItems(rootEl, groupT(kid(rootEl, 'grpSpPr'), full), scene.items);
      else if (rootEl.localName === 'wsp') {
        const xf = kid(kid(rootEl, 'spPr'), 'xfrm');
        scene.items.push(shapeItem(rootEl, Object.assign({}, full, xf ? { rot: num(xf, 'rot', 0) / 60000, flipH: attr(xf, 'flipH') === '1', flipV: attr(xf, 'flipV') === '1' } : {})));
      } else if (rootEl.localName === 'wpc') {
        const bg = kid(rootEl, 'bg');
        if (bg && kid(bg, 'solidFill')) scene.bg = colorOf(kid(bg, 'solidFill'));
        groupItems(rootEl, { ox: 0, oy: 0, sx: 1, sy: 1 }, scene.items);
      }
      return scene.items.length ? scene : null;
    }

    function walkRun(r, out, ctx) {
      const f = runFmt(kid(r, 'rPr'));
      for (const c of kids(r)) {
        switch (c.localName) {
          case 't': out.push(Object.assign({ t: c.textContent }, f)); break;
          case 'tab': case 'ptab': out.push(Object.assign({ t: '\t' }, f)); break;
          case 'br': case 'cr': out.push(BREAK); break;
          case 'noBreakHyphen': out.push(Object.assign({ t: '-' }, f)); break;
          case 'softHyphen': break;
          case 'sym': {
            const code = parseInt(attr(c, 'char') || '0', 16);
            const font = attr(c, 'font') || '';
            out.push(Object.assign({ t: String.fromCharCode(/symbol/i.test(font) ? symbolChar(code) : code) }, f));
            break;
          }
          case 'drawing': {
            const scene = sceneOf(c);
            if (scene) {
              // Shape/grup Word: mengambang -> digambar bersama paragraf sekitarnya; inline -> gambar sendiri
              if (scene.anchor && ctx.floats) ctx.floats.push(scene);
              else out.push({ scene });
              break;
            }
            const blip = findDeep(c, 'blip');
            const ext = findDeep(c, 'extent');
            if (blip) addImage(out, attr(blip, 'embed') || attr(blip, 'link'), emuToTw(attr(ext, 'cx')), emuToTw(attr(ext, 'cy')));
            break;
          }
          case 'pict': case 'object': {
            const im = findDeep(c, 'imagedata');
            if (im) {
              const shape = im.parentNode;
              const style = shape ? shape.getAttribute('style') : '';
              addImage(out, attr(im, 'id'), cssToTw(style, 'width'), cssToTw(style, 'height'));
            } else if (/^(group|rect|roundrect|oval|line|polyline|shape|arc|curve)$/.test((kids(c)[0] || {}).localName || '')) {
              ctx.legacy = true; // shape VML lama (tanpa versi DrawingML) belum bisa digambar
            }
            break;
          }
          case 'AlternateContent': {
            const choice = kid(c, 'Choice');
            if (choice) {
              const fake = { children: kids(choice) };
              for (const ch of fake.children) {
                if (ch.localName === 'drawing' || ch.localName === 'pict' || ch.localName === 'object') {
                  const tmp = r.ownerDocument.createElementNS(r.namespaceURI, 'w:r');
                  tmp.appendChild(ch.cloneNode(true));
                  walkRun(tmp, out, ctx);
                }
              }
            }
            break;
          }
          default: break;
        }
      }
    }

    function walkInline(el, out, ctx) {
      for (const c of kids(el)) {
        switch (c.localName) {
          case 'r': walkRun(c, out, ctx); break;
          case 'hyperlink': case 'ins': case 'smartTag': case 'customXml': case 'moveTo':
          case 'fldSimple': case 'bdo': case 'dir':
            walkInline(c, out, ctx); break;
          case 'sdt': walkInline(kid(c, 'sdtContent'), out, ctx); break;
          case 'oMath': case 'oMathPara': {
            ctx.math = true;
            const ts = c.getElementsByTagNameNS('*', 't');
            let s = '';
            for (const t of ts) s += t.textContent;
            if (s) out.push({ t: s, i: true });
            break;
          }
          default: break;
        }
      }
    }

    function paragraph(p) {
      const pPr = kid(p, 'pPr');
      const numPr = kid(pPr, 'numPr');
      let numId = numPr ? attr(kid(numPr, 'numId'), 'val') : null;
      let ilvl = numPr ? attr(kid(numPr, 'ilvl'), 'val') : null;
      const sty = styles.numPr(attr(kid(pPr, 'pStyle'), 'val'));
      if (numId == null) numId = sty.numId;
      if (ilvl == null) ilvl = sty.ilvl;
      const ctx = { math: false, floats: [], legacy: false };
      const out = [];
      walkInline(p, out, ctx);
      const auto = numId && numId !== '0' ? numbering.next(numId, parseInt(ilvl || '0', 10)) : null;
      const meta = styles.paraProps(attr(kid(pPr, 'pStyle'), 'val'), pPr);
      for (const s of out) {
        if (s === BREAK || 'img' in s || s.scene) continue;
        if (!s.sz) s.sz = meta.sz;
        if (!s.font && meta.font) s.font = meta.font;
      }
      const lines = [];
      let segs = [];
      for (const s of out) {
        if (s === BREAK) { lines.push(segs); segs = []; } else segs.push(s);
      }
      lines.push(segs);
      return {
        lines: lines.map((segs, i) => ({ segs, auto: i === 0 ? auto : null, math: ctx.math, legacy: ctx.legacy })),
        meta, floats: ctx.floats,
      };
    }

    // Di dalam sel tabel dsb.: shape mengambang digambar sendiri di bawah paragrafnya.
    function block(el, outLines) {
      for (const c of kids(el)) {
        if (c.localName === 'p') {
          const para = paragraph(c);
          outLines.push(...para.lines);
          for (const scene of para.floats) outLines.push({ segs: [{ scene, sz: para.meta.sz }], auto: null, drawing: true });
        }
        else if (c.localName === 'tbl') table(c, outLines);
        else if (c.localName === 'sdt') block(kid(c, 'sdtContent'), outLines);
        else if (c.localName === 'customXml') block(c, outLines);
      }
    }

    // Isi body: paragraf dikumpulkan dulu agar shape mengambang bisa digambar bersama label di sekitarnya.
    function bodyEntries(el, entries) {
      for (const c of kids(el)) {
        if (c.localName === 'p') entries.push(paragraph(c));
        else if (c.localName === 'tbl') { const l = []; table(c, l); entries.push({ lines: l, barrier: true, floats: [] }); }
        else if (c.localName === 'sdt') bodyEntries(kid(c, 'sdtContent'), entries);
        else if (c.localName === 'customXml') bodyEntries(c, entries);
      }
    }

    const segText = segs => segs.map(s => s.t || '').join('');
    /** 'empty' | true (baris label pendek, boleh ikut digambar) | false (bagian soal yang harus tetap teks). */
    function labelKind(e) {
      if (!e || e.barrier) return false;
      if (e.lines.some(l => l.auto || l.segs.some(s => s.img !== undefined || s.scene))) return false;
      const t = e.lines.map(l => segText(l.segs)).join(' ').replace(/\s+/g, ' ').trim();
      if (!t) return 'empty';
      if (t.length > 40) return false;
      if (/^(\(?\d{1,3}\s*[.)]|\(?[a-eA-E]\s*[.)]|soal\b|ans\b|kunci|jawab|catatan)/i.test(t)) return false;
      if (/([:!?]|\.{3,}|…)$/.test(t)) return false;
      return true;
    }

    async function buildBlocks(entries, page) {
      // Tahap 1: tentukan rentang paragraf tiap ilustrasi.
      const blocks = [];
      let lastEnd = -1;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.floats || !e.floats.length || i <= lastEnd) continue;
        // Jangkar berupa teks soal (bernomor/panjang) tetap teks; shape digambar di bawahnya.
        const anchorKind = labelKind(e);
        let s = i, end = i;
        if (anchorKind) while (s - 1 > lastEnd && i - (s - 1) <= 8 && labelKind(entries[s - 1])) s--;
        while (end + 1 < entries.length && end + 1 - i <= 8 && labelKind(entries[end + 1])) end++;
        while (s < i && labelKind(entries[s]) === 'empty' && !entries[s].floats.length) s++;
        while (end > i && labelKind(entries[end]) === 'empty' && !entries[end].floats.length) end--;
        blocks.push({ s, end, anchor: i, anchorKind });
        lastEnd = end;
      }
      // Tahap 2: susun hasil, rentang ilustrasi diganti satu gambar.
      const out = [];
      let b = 0;
      for (let i = 0; i < entries.length; i++) {
        const blk = blocks[b];
        if (!blk || i < blk.s) { out.push(...entries[i].lines); continue; }
        const paras = [];
        for (let k = blk.s; k <= blk.end; k++) {
          const en = entries[k];
          paras.push({ lines: en.lines.map(l => l.segs), meta: en.meta, draw: !(k === blk.anchor && !blk.anchorKind), floats: en.floats });
        }
        let img = null;
        try { img = await DrawingRender.renderBlock({ page, paras }); } catch (err) { console.error(err); }
        if (!blk.anchorKind) out.push(...entries[blk.anchor].lines);
        if (img) out.push({ segs: [{ img }], auto: null, drawing: true });
        i = blk.end;
        b++;
      }
      return out;
    }

    async function renderInlineScenes(lines) {
      for (const l of lines) {
        if (l.table) { for (const r of l.table.rows) for (const c of r) await renderInlineScenes(c.lines); continue; }
        for (let k = 0; k < l.segs.length; k++) {
          const s = l.segs[k];
          if (!s.scene) continue;
          let img = null;
          try { img = await DrawingRender.renderScene(s.scene, s.sz); } catch (err) { console.error(err); }
          l.segs[k] = { img };
          l.drawing = true;
        }
      }
    }

    // Tabel dikirim utuh sebagai satu "baris" { table }; parser yang menentukan
    // apakah tabel ini isi soal, tabel opsi, atau tata letak yang perlu diratakan.
    function table(tbl, outLines) {
      const widths = kids(kid(tbl, 'tblGrid'), 'gridCol').map(g => parseInt(attr(g, 'w') || '0', 10) || 0);
      const rows = [];
      for (const tr of kids(tbl, 'tr')) {
        const row = [];
        for (const tc of kids(tr, 'tc')) {
          const tcPr = kid(tc, 'tcPr');
          const span = parseInt(attr(kid(tcPr, 'gridSpan'), 'val') || '1', 10) || 1;
          const vmEl = kid(tcPr, 'vMerge');
          const vm = vmEl ? (attr(vmEl, 'val') === 'restart' ? 'restart' : 'cont') : null;
          const lines = [];
          block(tc, lines);
          row.push({ lines, span, vm });
        }
        if (row.length) rows.push(row);
      }
      if (rows.length) outLines.push({ segs: [], auto: null, table: { rows, widths } });
    }

    function dropMissingImages(lines) {
      for (const l of lines) {
        l.segs = l.segs.filter(s => !('img' in s) || s.img);
        if (l.table) for (const r of l.table.rows) for (const c of r) dropMissingImages(c.lines);
      }
    }

    const body = findDeep(doc, 'body');
    const sect = kids(body, 'sectPr').pop() || findDeep(body, 'sectPr');
    const pgW = num(kid(sect, 'pgSz'), 'w', 11906);
    const mar = kid(sect, 'pgMar');
    const settingsDoc = await get('word/settings.xml');
    const page = {
      marginL: num(mar, 'left', 1440),
      textW: pgW - num(mar, 'left', 1440) - num(mar, 'right', 1440),
      defTab: num(kid(settingsDoc && settingsDoc.documentElement, 'defaultTabStop'), 'val', 720),
    };

    const entries = [];
    bodyEntries(body, entries);
    await Promise.all(pending);
    const lines = await buildBlocks(entries, page);
    await renderInlineScenes(lines);
    dropMissingImages(lines);
    return lines;
  }

  // Simbol font "Symbol" (F0xx) -> Unicode untuk karakter yang umum di soal.
  function symbolChar(code) {
    const c = code & 0xFF;
    const map = {
      0x61: 0x3B1, 0x62: 0x3B2, 0x67: 0x3B3, 0x64: 0x3B4, 0x65: 0x3B5, 0x71: 0x3B8, 0x6C: 0x3BB, 0x6D: 0x3BC,
      0x70: 0x3C0, 0x72: 0x3C1, 0x73: 0x3C3, 0x74: 0x3C4, 0x66: 0x3C6, 0x77: 0x3C9, 0x44: 0x394, 0x57: 0x3A9,
      0x53: 0x3A3, 0xB1: 0xB1, 0xB4: 0xD7, 0xB8: 0xF7, 0xA3: 0x2264, 0xB3: 0x2265, 0xB9: 0x2260, 0xBB: 0x2248,
      0xAE: 0x2192, 0xAC: 0x2190, 0xB0: 0xB0, 0xD6: 0x221A, 0xA5: 0x221E, 0xB7: 0x2022, 0xBA: 0x2261,
    };
    return map[c] || c;
  }

  const api = { read };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DocxReader = api;
})(this);
