/*
 * Persamaan bawaan Word (OMML: m:oMath / m:oMathPara) -> PNG.
 * OMML diubah ke MathML, ditata oleh browser (font Cambria Math) di elemen tersembunyi
 * untuk mengukur ukuran & garis dasarnya, lalu digambar lewat SVG foreignObject ke
 * kanvas 2x. Hitam-putih -> PNG abu-abu 4-bit (kecil). Bila gagal, hasilnya null
 * dan pemanggil memakai teks persamaan apa adanya.
 */
(function (root) {
  'use strict';

  const MML_NS = 'http://www.w3.org/1998/Math/MathML';
  const SCALE = 2;
  const TW_PX = 15;
  const FONT_PX = 16; // 12 pt, sama dengan ukuran huruf RTF
  const PAD = 6;
  const MATH_FONT = '"Cambria Math", "STIX Two Math", "Latin Modern Math", math, serif';

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
  /** Nilai m:val dari properti, mis. prop(dPr, 'begChr'); undefined bila tidak ada. */
  const prop = (pr, name) => { const e = kid(pr, name); return e ? attr(e, 'val') : undefined; };
  const isOn = (pr, name) => { const v = prop(pr, name); return v !== undefined && !/^(0|false|off)$/i.test(v || '1'); };
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- OMML -> MathML ----------
  const FUNCS = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'cosec', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
    'log', 'ln', 'lim', 'exp', 'max', 'min', 'det', 'mod', 'sup', 'inf', 'arg', 'deg', 'dim', 'gcd', 'lg'];
  const OPS = { '-': '−', '*': '∗', "'": '′' };
  const FENCES = '()[]{}|‖⟨⟩⌊⌋⌈⌉';
  // Aksen kombinasi -> versi berdiri sendiri agar tampil baik di atas huruf.
  const ACCENTS = {
    '̂': 'ˆ', '̃': '˜', '̄': '¯', '̅': '¯', '̇': '˙', '̈': '¨',
    '́': '´', '̀': '`', '̌': 'ˇ', '̆': '˘', '⃗': '→', '⃖': '←', '⃡': '↔',
  };

  function tokens(text, sty) {
    const variant = sty === 'p' ? ' mathvariant="normal"' : '';
    const weight = sty === 'b' || sty === 'bi' ? ' style="font-weight:bold"' : '';
    let o = '';
    for (let i = 0; i < text.length;) {
      const rest = text.slice(i);
      let m;
      if ((m = /^\d+(?:[.,]\d+)*\.?/.exec(rest))) {
        o += '<mn' + weight + '>' + esc(m[0]) + '</mn>';
      } else if ((m = /^\p{L}+/u.exec(rest))) {
        // Nama fungsi (sin, log, ...) tegak; huruf lain satu per satu (miring seperti di Word).
        const word = m[0];
        const fn = FUNCS.find(f => word.startsWith(f) && (word.length === f.length || f.length >= 3));
        m = [fn || String.fromCodePoint(word.codePointAt(0))];
        o += '<mi' + (fn ? '' : variant) + weight + '>' + esc(m[0]) + '</mi>';
      } else if ((m = /^\s+/.exec(rest))) {
        o += '<mspace width="' + (0.25 * m[0].length).toFixed(2) + 'em"/>';
      } else {
        const ch = String.fromCodePoint(rest.codePointAt(0));
        m = [ch];
        if (ch === '.') o += '<mn>.</mn>';
        else if (FENCES.includes(ch)) o += '<mo stretchy="false">' + esc(ch) + '</mo>';
        else o += '<mo' + weight + '>' + esc(OPS[ch] || ch) + '</mo>';
      }
      i += m[0].length;
    }
    return o;
  }

  function run(r) {
    const rPr = kids(r, 'rPr').find(e => e.namespaceURI === r.namespaceURI);
    const sty = prop(rPr, 'sty');
    const nor = isOn(rPr, 'nor');
    let o = '';
    for (const c of kids(r)) {
      if (c.localName === 't') {
        const t = c.textContent;
        if (!t) continue;
        o += nor ? '<mtext>' + esc(t) + '</mtext>' : tokens(t, sty);
      } else if (c.localName === 'tab') o += '<mspace width="1em"/>';
    }
    return o;
  }

  const row = el => '<mrow>' + seq(el) + '</mrow>';
  const fence = ch => (ch ? '<mo fence="true" stretchy="true" symmetric="true" lspace="0" rspace="0">' + esc(ch) + '</mo>' : '');

  function node(el) {
    const pr = kid(el, el.localName + 'Pr');
    switch (el.localName) {
      case 'r': return run(el);
      case 'f': {
        const type = prop(pr, 'type');
        if (type === 'lin') return '<mrow>' + seq(kid(el, 'num')) + '<mo>/</mo>' + seq(kid(el, 'den')) + '</mrow>';
        return '<mfrac' + (type === 'noBar' ? ' linethickness="0"' : '') + '>' + row(kid(el, 'num')) + row(kid(el, 'den')) + '</mfrac>';
      }
      case 'rad': {
        const deg = kid(el, 'deg');
        if (isOn(pr, 'degHide') || !deg || !deg.textContent.trim()) return '<msqrt>' + seq(kid(el, 'e')) + '</msqrt>';
        return '<mroot>' + row(kid(el, 'e')) + row(deg) + '</mroot>';
      }
      case 'sSup': return '<msup>' + row(kid(el, 'e')) + row(kid(el, 'sup')) + '</msup>';
      case 'sSub': return '<msub>' + row(kid(el, 'e')) + row(kid(el, 'sub')) + '</msub>';
      case 'sSubSup': return '<msubsup>' + row(kid(el, 'e')) + row(kid(el, 'sub')) + row(kid(el, 'sup')) + '</msubsup>';
      case 'sPre': return '<mmultiscripts>' + row(kid(el, 'e')) + '<mprescripts/>' + row(kid(el, 'sub')) + row(kid(el, 'sup')) + '</mmultiscripts>';
      case 'd': {
        const beg = prop(pr, 'begChr'), end = prop(pr, 'endChr'), sep = prop(pr, 'sepChr');
        const parts = kids(el, 'e').map(row);
        return '<mrow>' + fence(beg === undefined ? '(' : beg) +
          parts.join(sep === '' ? '' : '<mo fence="true" stretchy="true" symmetric="true" separator="true" lspace="0.2em" rspace="0.2em">' + esc(sep === undefined ? '|' : sep) + '</mo>') +
          fence(end === undefined ? ')' : end) + '</mrow>';
      }
      case 'm': {
        const rows = kids(el, 'mr').map(mr => '<mtr>' + kids(mr, 'e').map(e => '<mtd>' + seq(e) + '</mtd>').join('') + '</mtr>');
        return '<mtable>' + rows.join('') + '</mtable>';
      }
      case 'eqArr':
        return '<mtable>' + kids(el, 'e').map(e => '<mtr><mtd style="text-align:left">' + seq(e) + '</mtd></mtr>').join('') + '</mtable>';
      case 'nary': {
        const chr = prop(pr, 'chr') || '∫';
        const integral = /[∫-∳]/.test(chr);
        const under = (prop(pr, 'limLoc') || (integral ? 'subSup' : 'undOvr')) === 'undOvr';
        const sub = isOn(pr, 'subHide') ? null : kid(el, 'sub');
        const sup = isOn(pr, 'supHide') ? null : kid(el, 'sup');
        const op = '<mo largeop="true"' + (under ? ' movablelimits="false"' : '') + '>' + esc(chr) + '</mo>';
        let base;
        if (sub && sup) base = (under ? '<munderover>' : '<msubsup>') + op + row(sub) + row(sup) + (under ? '</munderover>' : '</msubsup>');
        else if (sub) base = (under ? '<munder>' : '<msub>') + op + row(sub) + (under ? '</munder>' : '</msub>');
        else if (sup) base = (under ? '<mover>' : '<msup>') + op + row(sup) + (under ? '</mover>' : '</msup>');
        else base = op;
        return '<mrow>' + base + row(kid(el, 'e')) + '</mrow>';
      }
      case 'func': return '<mrow>' + row(kid(el, 'fName')) + '<mo>⁡</mo>' + row(kid(el, 'e')) + '</mrow>';
      case 'limLow': return '<munder>' + row(kid(el, 'e')) + row(kid(el, 'lim')) + '</munder>';
      case 'limUpp': return '<mover>' + row(kid(el, 'e')) + row(kid(el, 'lim')) + '</mover>';
      case 'acc': {
        const chr = prop(pr, 'chr') || '̂';
        return '<mover accent="true">' + row(kid(el, 'e')) + '<mo stretchy="true">' + esc(ACCENTS[chr] || chr) + '</mo></mover>';
      }
      case 'bar':
        return prop(pr, 'pos') === 'top'
          ? '<mover accent="true">' + row(kid(el, 'e')) + '<mo stretchy="true">¯</mo></mover>'
          : '<munder accentunder="true">' + row(kid(el, 'e')) + '<mo stretchy="true">_</mo></munder>';
      case 'groupChr': {
        const chr = prop(pr, 'chr') || '⏟';
        return prop(pr, 'pos') === 'top'
          ? '<mover>' + row(kid(el, 'e')) + '<mo stretchy="true">' + esc(chr) + '</mo></mover>'
          : '<munder>' + row(kid(el, 'e')) + '<mo stretchy="true">' + esc(chr) + '</mo></munder>';
      }
      case 'borderBox': return '<mrow style="border:1px solid #000;padding:1px 2px">' + seq(kid(el, 'e')) + '</mrow>';
      case 'phant': return prop(pr, 'show') === '0' || prop(pr, 'show') === 'off' ? '<mphantom>' + row(kid(el, 'e')) + '</mphantom>' : row(kid(el, 'e'));
      case 'box': case 'e': case 'oMath': return row(el);
      default:
        // Teks Word biasa di dalam persamaan (w:r) atau elemen lain: ambil isinya.
        if (/Pr$/.test(el.localName) || /^(bookmark|proofErr|commentRange|permStart|permEnd)/.test(el.localName)) return '';
        if (el.localName === 't') return el.textContent ? '<mtext>' + esc(el.textContent) + '</mtext>' : '';
        return seq(el);
    }
  }

  function seq(el) {
    let o = '';
    for (const c of kids(el)) o += node(c);
    return o;
  }

  /** m:oMath -> string MathML. display: true untuk persamaan yang berdiri sendiri. */
  function toMathML(oMath, display) {
    // Selalu sebaris (bukan display="block") agar garis dasarnya bisa diukur; displaystyle mengatur ukuran pecahan/notasi.
    return '<math xmlns="' + MML_NS + '" displaystyle="' + !!display + '">' + seq(oMath) + '</math>';
  }

  /** Teks polos persamaan (cadangan bila gambar gagal dibuat). */
  function text(oMath) {
    let s = '';
    for (const t of oMath.getElementsByTagNameNS('*', 't')) s += t.textContent;
    return s;
  }

  // ---------- MathML -> PNG ----------
  const WRAP_CSS = 'display:inline-block;padding:' + PAD + 'px;font-family:"Times New Roman",serif;font-size:' + FONT_PX + 'px;' +
    'line-height:normal;white-space:nowrap;color:#000;background:#fff';
  const MATH_CSS = 'font-family:' + MATH_FONT + ';font-size:' + FONT_PX + 'px;margin:0';

  function markup(mml) {
    return '<div xmlns="http://www.w3.org/1999/xhtml" style=\'' + WRAP_CSS + '\'>' +
      mml.replace('<math ', '<math style=\'' + MATH_CSS + '\' ') +
      '<span style="display:inline-block;width:0;height:0"></span></div>';
  }

  function loadSvg(svg) {
    return new Promise(res => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => res(null);
      el.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  function isColored(d) {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - g) > 24 || Math.abs(g - b) > 24 || Math.abs(r - b) > 24) return true;
    }
    return false;
  }

  /**
   * Gambar persamaan -> { type:'png', b64, pxW, pxH, w, h (twips), depth (twips di bawah garis dasar), fromMath }
   * atau null bila tidak bisa digambar.
   */
  async function render(oMath, display) {
    if (typeof document === 'undefined' || !document.body) return null;
    const mml = toMathML(oMath, display);
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none';
    host.innerHTML = markup(mml);
    document.body.appendChild(host);
    let box;
    try {
      const wrap = host.firstChild;
      const math = wrap.querySelector('math');
      const probe = wrap.lastChild;
      if (!math || !(math instanceof Element) || math.namespaceURI !== MML_NS) return null;
      const w = wrap.getBoundingClientRect(), m = math.getBoundingClientRect(), p = probe.getBoundingClientRect();
      if (!m.width || !m.height) return null;
      box = { W: Math.ceil(w.width), H: Math.ceil(w.height), base: p.top - w.top };
    } finally {
      host.remove();
    }

    const W = box.W * SCALE, H = box.H * SCALE;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + box.W + ' ' + box.H + '">' +
      '<foreignObject x="0" y="0" width="' + box.W + '" height="' + box.H + '">' + markup(mml) + '</foreignObject></svg>';
    const el = await loadSvg(svg);
    if (!el) return null;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(el, 0, 0, W, H);
    let d;
    try { d = ctx.getImageData(0, 0, W, H).data; } catch (e) { return null; } // kanvas "tainted"

    // Potong ke batas tinta (+ sedikit tepi), garis dasar tetap di dalam gambar.
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null; // kosong
    const base = Math.round(box.base * SCALE);
    const m = SCALE;
    x0 = Math.max(0, x0 - m); x1 = Math.min(W - 1, x1 + m);
    y0 = Math.max(0, Math.min(y0, base - 1) - m); y1 = Math.min(H - 1, Math.max(y1, base) + m);
    // Lebar/tinggi genap agar ukuran tampil (px/2) bulat.
    let cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    cw += cw % 2; ch += ch % 2;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, cw, ch);
    octx.drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);

    let b64 = null;
    try {
      if (!isColored(octx.getImageData(0, 0, cw, ch).data) && root.TableImage && root.TableImage.encodeGray4) {
        b64 = await root.TableImage.encodeGray4(out).catch(() => null);
      }
      if (!b64) b64 = out.toDataURL('image/png').split(',')[1];
    } catch (e) { return null; }
    const tw = v => Math.round(v / SCALE * TW_PX);
    return { type: 'png', b64, pxW: cw, pxH: ch, w: tw(cw), h: tw(ch), depth: tw(y0 + ch - base), fromMath: true };
  }

  const api = { toMathML, text, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmmlImage = api;
})(this);
