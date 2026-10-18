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

  function Styles(doc) {
    const map = {};
    if (doc) {
      for (const s of kids(doc.documentElement, 'style')) {
        const pPr = kid(s, 'pPr');
        const numPr = kid(pPr, 'numPr');
        map[attr(s, 'styleId')] = {
          basedOn: attr(kid(s, 'basedOn'), 'val'),
          numId: numPr ? attr(kid(numPr, 'numId'), 'val') : null,
          ilvl: numPr ? attr(kid(numPr, 'ilvl'), 'val') : null,
        };
      }
    }
    this.numPr = function (id) {
      let numId = null, ilvl = null;
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
      return f;
    }

    function addImage(out, rid, w, h) {
      const seg = { img: null };
      out.push(seg);
      pending.push(makeImage(zip, rels, rid, w, h).then(img => { seg.img = img; }));
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
      const ctx = { math: false };
      const out = [];
      walkInline(p, out, ctx);
      const auto = numId && numId !== '0' ? numbering.next(numId, parseInt(ilvl || '0', 10)) : null;
      const lines = [];
      let segs = [];
      for (const s of out) {
        if (s === BREAK) { lines.push(segs); segs = []; } else segs.push(s);
      }
      lines.push(segs);
      return lines.map((segs, i) => ({ segs, auto: i === 0 ? auto : null, math: ctx.math }));
    }

    function block(el, outLines) {
      for (const c of kids(el)) {
        if (c.localName === 'p') outLines.push(...paragraph(c));
        else if (c.localName === 'tbl') table(c, outLines);
        else if (c.localName === 'sdt') block(kid(c, 'sdtContent'), outLines);
        else if (c.localName === 'customXml') block(c, outLines);
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

    const lines = [];
    block(findDeep(doc, 'body'), lines);
    await Promise.all(pending);
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
