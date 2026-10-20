/*
 * Penulis RTF dengan format ujian:
 *
 *   Multiple choice
 *   1.  Teks soal ....
 *       a.  opsi
 *       ...
 *       e.  opsi
 *     ANS: B
 *
 * Nomor soal dan huruf opsi memakai numbering Word asli (list), opsi
 * dimulai ulang dari "a" di setiap soal, sama seperti file contoh.
 */
(function (root) {
  'use strict';

  const MAX_IMG_W = 8500; // twips (~15 cm)

  // Karakter khusus Windows-1252 (0x80–0x9F) -> kode byte, seperti yang ditulis Word (\'96 dst.).
  const CP1252 = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
    0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91,
    0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
    0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
  };
  // Cadangan yang masih terbaca untuk pembaca RTF tanpa Unicode (bukan "?").
  const FALLBACK = {
    0x2212: '-', 0x2010: '-', 0x2011: '-', 0x2012: '-', 0x2015: '-', 0x2264: '<=', 0x2265: '>=', 0x2260: '=/=',
    0x2248: '~', 0x2261: '=', 0x221A: 'akar', 0x221E: 'tak hingga', 0x2192: '->', 0x2190: '<-', 0x2194: '<->',
    0x21CC: '<=>', 0x21CB: '<=>', 0x21D2: '=>', 0x2032: "'", 0x2033: '"', 0x2219: '.', 0x22C5: '.', 0x2206: 'delta',
    0x0394: 'Delta', 0x03B1: 'alfa', 0x03B2: 'beta', 0x03B3: 'gamma', 0x03B4: 'delta', 0x03B8: 'theta',
    0x03BB: 'lambda', 0x03BC: 'mu', 0x03C0: 'pi', 0x03C1: 'rho', 0x03C3: 'sigma', 0x03C9: 'omega', 0x03A9: 'Ohm',
    0x00A0: ' ', 0x2002: ' ', 0x2003: ' ', 0x2009: ' ', 0x200B: '',
  };
  // Angka/tanda superskrip & subskrip Unicode (H₂O, Fe³⁺) ditulis sebagai teks biasa berformat \super/\sub.
  const SUPER = { 0x2070: '0', 0x2071: 'i', 0x2074: '4', 0x2075: '5', 0x2076: '6', 0x2077: '7', 0x2078: '8', 0x2079: '9',
    0x207A: '+', 0x207B: '-', 0x207C: '=', 0x207D: '(', 0x207E: ')', 0x207F: 'n' };
  const SUB = { 0x2080: '0', 0x2081: '1', 0x2082: '2', 0x2083: '3', 0x2084: '4', 0x2085: '5', 0x2086: '6', 0x2087: '7',
    0x2088: '8', 0x2089: '9', 0x208A: '+', 0x208B: '-', 0x208C: '=', 0x208D: '(', 0x208E: ')' };

  // Spasi/strip Unicode yang padanan teksnya tampil sama persis.
  const SAME_AS_TEXT = [0x2212, 0x2010, 0x2011, 0x2012, 0x2015, 0x00A0, 0x2002, 0x2003, 0x2009, 0x200B, 0xFFFC];

  /** true bila karakter bisa ditulis apa adanya (tanpa \uN) dan terbaca benar oleh pengimpor ujian. */
  function isPlain(ch) {
    const c = ch.codePointAt(0);
    return c < 0x100 || !!CP1252[c] || !!SUPER[c] || !!SUB[c] || SAME_AS_TEXT.includes(c);
  }

  // Cadangan otomatis dari dekomposisi Unicode: ⅔ -> "2/3", ℃ -> "°C", ﬁ -> "fi".
  // Hanya dipakai bila hasilnya bisa ditulis sebagai Latin-1/CP1252; selain itu "?".
  function decompose(ch) {
    const d = ch.normalize('NFKD').replace(/⁄/g, '/').replace(/[̀-ͯ]/g, '');
    if (!d || d === ch) return '?';
    for (const x of d) {
      const c = x.charCodeAt(0);
      if (x.length > 1 || (c >= 0x80 && c < 0xA0) || (c > 0xFF && !CP1252[c])) return '?';
    }
    return d;
  }

  function esc(s) {
    let o = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const c = s.charCodeAt(i);
      if (ch === '\\' || ch === '{' || ch === '}') o += '\\' + ch;
      else if (ch === '\t') o += '\\tab ';
      else if (ch === '\n') o += '\\line ';
      else if (c === 0xFFFC) continue;
      else if (c < 0x80) o += ch;
      else if (c >= 0xA0 && c <= 0xFF) o += "\\'" + c.toString(16);          // Latin-1: ° ± × ÷ ² ³ ½ é ...
      else if (CP1252[c]) o += "\\'" + CP1252[c].toString(16);                // – — … “ ” ‘ ’ • €
      else if (SUPER[c] || SUB[c]) {
        // Gabungkan deretan yang sejenis: CH₃₂ -> {\sub 32}.
        const map = SUPER[c] ? SUPER : SUB;
        let run = map[c];
        while (i + 1 < s.length && map[s.charCodeAt(i + 1)]) run += map[s.charCodeAt(++i)];
        o += '{' + (map === SUPER ? '\\super ' : '\\sub ') + esc(run) + '}';
      }
      else {
        // Unicode lain: pengimpor ujian (ExamView/Moodle) mengubah setiap \uN menjadi "?" dan
        // tetap menampilkan cadangannya ("?<=>"), jadi bila ada padanan terbaca tulis padanannya saja.
        const fb = FALLBACK[c] != null ? FALLBACK[c] : decompose(ch);
        if (fb !== '?') { o += esc(fb); continue; }
        o += '\\u' + (c > 32767 ? c - 65536 : c) + ' ?';
      }
    }
    return o;
  }

  function b64ToHex(b64) {
    let bin;
    if (typeof atob === 'function') bin = atob(b64);
    else bin = Buffer.from(b64, 'base64').toString('binary');
    const hex = '0123456789abcdef';
    const parts = [];
    let line = '';
    for (let i = 0; i < bin.length; i++) {
      const c = bin.charCodeAt(i);
      line += hex[c >> 4] + hex[c & 15];
      if (line.length >= 128) { parts.push(line); line = ''; }
    }
    if (line) parts.push(line);
    return parts.join('\n');
  }

  // WMF dari dokumen sering diawali header "placeable" (22 byte, 0x9AC6CDD7) yang tidak
  // boleh ada di dalam RTF (ExamView menolak: error -12). Buang header itu.
  function stripPlaceable(b64) {
    const bin = typeof atob === 'function' ? atob(b64.slice(0, 8)) : Buffer.from(b64.slice(0, 8), 'base64').toString('binary');
    if (bin.charCodeAt(0) !== 0xD7 || bin.charCodeAt(1) !== 0xCD || bin.charCodeAt(2) !== 0xC6 || bin.charCodeAt(3) !== 0x9A) return b64;
    const all = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const rest = all.slice(22);
    return typeof btoa === 'function' ? btoa(rest) : Buffer.from(rest, 'binary').toString('base64');
  }

  function pict(img) {
    let w = img.w || 2880, h = img.h || 2160;
    if (w > MAX_IMG_W) { h = Math.round(h * MAX_IMG_W / w); w = MAX_IMG_W; }
    const goal = '\\picwgoal' + w + '\\pichgoal' + h;
    const himetric = '\\picw' + Math.round(w * 2540 / 1440) + '\\pich' + Math.round(h * 2540 / 1440);
    if (img.type === 'png' || img.type === 'jpeg') {
      const blip = '{\\pict' + (img.type === 'png' ? '\\pngblip' : '\\jpegblip') +
        '\\picw' + (img.pxW || Math.round(w / 15)) + '\\pich' + (img.pxH || Math.round(h / 15)) + goal + '\n' + b64ToHex(img.b64) + '}';
      // Seperti Word: PNG/JPEG untuk program modern + cadangan WMF untuk pembaca lama (ExamView).
      if (img.wmf) return '{\\*\\shppict' + blip + '}{\\nonshppict{\\pict\\wmetafile8' + himetric + goal + '\n' + b64ToHex(img.wmf) + '}}';
      return blip;
    }
    if (img.type === 'emf') return '{\\pict\\emfblip' + himetric + goal + '\n' + b64ToHex(img.b64) + '}';
    if (img.type === 'wmf') return '{\\pict\\wmetafile8' + himetric + goal + '\n' + b64ToHex(stripPlaceable(img.b64)) + '}';
    return '';
  }

  function runs(segs, isOption) {
    let o = '';
    const withText = segs.some(s => !s.img && /\S/.test(s.t || ''));
    // Opsi yang hanya berisi gambar tinggi (foto, tabel opsi): huruf a./b. sejajar tengah gambar.
    const centerOption = isOption && !withText;
    for (const s of segs) {
      if (s.img) {
        // Persamaan (dari WMF/EMF) yang sebaris dengan teks diturunkan agar tengahnya sejajar teks.
        const hPt = (s.img.h || 0) / 20;
        // Persamaan Word (OMML): bagian di bawah garis dasar diketahui persis, juga sejajar dengan huruf opsi.
        if (s.img.fromMath && s.img.depth > 10) {
          o += '{\\dn' + Math.round(s.img.depth / 10) + ' ' + pict(s.img) + '}';
        } else if (s.img.fromMath && s.img.depth < -10) {
          // Simbol superskrip yang dijadikan gambar: dinaikkan dari garis dasar.
          o += '{\\up' + Math.round(-s.img.depth / 10) + ' ' + pict(s.img) + '}';
        } else if ((withText && s.img.fromMetafile && hPt > 14) || (centerOption && !s.img.fromMath && hPt > 18)) {
          o += '{\\dn' + Math.round((hPt / 2 - 4) * 2) + ' ' + pict(s.img) + '}';
        } else o += pict(s.img);
        continue;
      }
      if (!s.t) continue;
      let f = '';
      if (s.b) f += '\\b';
      if (s.i) f += '\\i';
      if (s.u) f += '\\ul';
      if (s.sup) f += '\\super';
      if (s.sub) f += '\\sub';
      o += f ? '{' + f + ' ' + esc(s.t) + '}' : esc(s.t);
    }
    return o;
  }

  // Sub-butir di dalam soal, mis. "1) ...", "I. ...", "a) ..."
  const RE_SUB = /^((?:\d{1,2}|[IVXivx]{1,4}|[a-z]|•|-)[.)]?)\s+/;

  function listDef(id, nfc, indent) {
    return '{\\list\\listtemplateid' + id + '\\listsimple{\\listlevel\\levelnfc' + nfc + '\\levelnfcn' + nfc +
      '\\leveljc0\\leveljcn0\\levelfollow0\\levelstartat1\\levelspace0\\levelindent0{\\leveltext\\\'02\\\'00.;}' +
      '{\\levelnumbers\\\'01;}\\fi-360\\li' + indent + '\\lin' + indent + ' }{\\listname ;}\\listid' + id + '}';
  }

  // Tabel di dalam soal: menjorok sejajar teks soal, bergaris, lebar kolom mengikuti asli.
  const TABLE_LEFT = 360;
  const TABLE_MAX_W = 9026 - TABLE_LEFT; // lebar teks A4 dengan margin 2,54 cm
  const BORDER = '\\brdrs\\brdrw10';

  function table(t, base) {
    const cols = Math.max(1, ...t.rows.map(r => r.reduce((n, c) => n + (c.span || 1), 0)));
    let widths = (t.widths || []).slice(0, cols);
    if (widths.length < cols || widths.some(w => !w)) widths = Array(cols).fill(Math.floor(TABLE_MAX_W / cols));
    const total = widths.reduce((a, b) => a + b, 0);
    if (total > TABLE_MAX_W) widths = widths.map(w => Math.floor(w * TABLE_MAX_W / total));

    const out = [];
    for (const row of t.rows) {
      let def = '\\trowd\\trgaph108\\trleft' + TABLE_LEFT +
        '\\trbrdrt' + BORDER + '\\trbrdrl' + BORDER + '\\trbrdrb' + BORDER + '\\trbrdrr' + BORDER +
        '\\trbrdrh' + BORDER + '\\trbrdrv' + BORDER;
      let x = TABLE_LEFT, col = 0, content = '';
      for (const c of row) {
        const span = c.span || 1;
        for (let s = 0; s < span; s++) x += widths[Math.min(col++, widths.length - 1)];
        def += (c.vm === 'restart' ? '\\clvmgf' : c.vm === 'cont' ? '\\clvmrg' : '') +
          '\\clvertalc\\clbrdrt' + BORDER + '\\clbrdrl' + BORDER + '\\clbrdrb' + BORDER + '\\clbrdrr' + BORDER +
          '\\cellx' + x;
        const paras = c.vm === 'cont' || !c.paras.length ? [[]] : c.paras;
        content += paras.map((p, i) => '\\pard\\plain\\intbl\\ql\\sa0\\sl240\\slmult1' + base + ' ' + runs(p) +
          (i < paras.length - 1 ? '\\par' : '\\cell')).join('\n') + '\n';
      }
      out.push(def + '\n' + content + '\\row');
    }
    return out.join('\n') + '\n\\pard\\plain' + base;
  }

  function build(questions, cfg) {
    cfg = Object.assign({
      mcTitle: 'Multiple choice', essayTitle: 'Essay', font: 'Times New Roman',
      fontSize: 12, blankLine: true,
    }, cfg);
    const fs = '\\fs' + Math.round(cfg.fontSize * 2);
    const base = '\\f0' + fs;
    const mc = questions.filter(q => q.type === 'mc');

    // listid 1 = nomor PG, 2 = nomor essay, 1000+i = opsi soal ke-i
    const lists = [listDef(1, 0, 360), listDef(2, 0, 360)];
    const overrides = ['{\\listoverride\\listid1\\listoverridecount0\\ls1}', '{\\listoverride\\listid2\\listoverridecount0\\ls2}'];
    mc.forEach((q, i) => {
      lists.push(listDef(1000 + i, 4, 720));
      overrides.push('{\\listoverride\\listid' + (1000 + i) + '\\listoverridecount0\\ls' + (3 + i) + '}');
    });

    const body = [];
    const para = (fmt, content) => body.push('\\pard\\plain\\ql\\sa0\\sl240\\slmult1' + fmt + base + ' ' + content + '\\par');
    const listPara = (ls, label, indent, content) =>
      body.push('{\\listtext\\pard\\plain' + base + ' ' + label + '\\tab}\\pard\\plain\\ql\\sa0\\sl240\\slmult1\\fi-360\\li' + indent +
        '\\lin' + indent + '\\ls' + ls + '\\ilvl0' + base + ' ' + content + '\\par');

    // Baris soal bertab yang berurutan (mis. "Kas<tab>Rp.5.000.000") mendapat tab stop yang sama
    // agar kolom nilainya rata, dihitung dari isi terpanjang tiap kolom.
    const tabStopsFor = stem => {
      const stops = new Array(stem.length).fill('');
      const textOf = p => (Array.isArray(p) ? p.map(s => (s.img ? '￼' : s.t)).join('') : '');
      let k = 1;
      while (k < stem.length) {
        if (!textOf(stem[k]).includes('\t') || RE_SUB.test(textOf(stem[k]))) { k++; continue; }
        let e = k;
        while (e + 1 < stem.length && textOf(stem[e + 1]).includes('\t') && !RE_SUB.test(textOf(stem[e + 1]))) e++;
        const widths = [];
        for (let j = k; j <= e; j++) {
          textOf(stem[j]).split('\t').slice(0, -1).forEach((c, ci) => { widths[ci] = Math.max(widths[ci] || 0, c.length); });
        }
        let x = 360;
        const tx = widths.map(len => { x = Math.min(9000, x + Math.max(720, len * 115 + 360)); return '\\tx' + x; }).join('');
        for (let j = k; j <= e; j++) stops[j] = tx;
        k = e + 1;
      }
      return stops;
    };

    const stemParas = (q, ls, n) => {
      const stops = tabStopsFor(q.stem);
      q.stem.forEach((p, k) => {
        if (p.table) {
          if (k === 0) listPara(ls, n + '.', 360, '');
          body.push(table(p.table, base));
          return;
        }
        const imageOnly = p.length > 0 && p.some(s => s.img) && p.every(s => s.img || !/\S/.test(s.t));
        if (k === 0) {
          // Soal yang diawali gambar: nomor di baris sendiri, gambar di bawahnya (bukan di pojok bawah gambar).
          if (imageOnly) { listPara(ls, n + '.', 360, ''); para('\\li360\\lin360\\sb60\\sa60', runs(p)); }
          else listPara(ls, n + '.', 360, runs(p));
          return;
        }
        const first = p.find(s => !s.img);
        const m = first && p[0] === first ? RE_SUB.exec(first.t) : null;
        if (m) {
          const rest = [Object.assign({}, first, { t: first.t.slice(m[0].length) })].concat(p.slice(1));
          para('\\fi-360\\li720\\lin720\\tx720', esc(m[1]) + '\\tab ' + runs(rest));
        } else {
          para('\\li360\\lin360' + stops[k] + (imageOnly ? '\\sb60\\sa60' : ''), runs(p));
        }
      });
      if (!q.stem.length) listPara(ls, n + '.', 360, '');
    };

    // Urutan mengikuti dokumen asli. Judul bagian ditulis setiap kali jenis soal
    // berganti; nomor PG dan essay masing-masing berlanjut (sama dengan preview).
    let prevType = null;
    let nMc = 0, nEssay = 0;
    for (const q of questions) {
      if (q.type !== prevType) {
        if (prevType && !cfg.blankLine) para('', '');
        para('', esc(q.type === 'mc' ? cfg.mcTitle : cfg.essayTitle));
        prevType = q.type;
      }
      if (q.type === 'mc') {
        const i = nMc++;
        stemParas(q, 1, i + 1);
        q.options.forEach((o, k) => listPara(3 + i, String.fromCharCode(97 + k) + '.', 720, runs(o, true)));
      } else {
        stemParas(q, 2, ++nEssay);
      }
      para('\\li360\\lin360', 'ANS: ' + esc(q.answer || ''));
      if (cfg.blankLine) para('', '');
    }

    return '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\\deflang1057\n' +
      '{\\fonttbl{\\f0\\froman\\fcharset0 ' + esc(cfg.font) + ';}}\n' +
      '{\\colortbl;\\red0\\green0\\blue0;}\n' +
      '{\\*\\listtable\n' + lists.join('\n') + '}\n' +
      '{\\*\\listoverridetable\n' + overrides.join('\n') + '}\n' +
      '\\paperw11906\\paperh16838\\margl1440\\margr1440\\margt1440\\margb1440\\widowctrl\n' +
      '\\sectd\\pgwsxn11906\\pghsxn16838\n' +
      body.join('\n') + '\n}';
  }

  const api = { build, esc, isPlain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RtfWriter = api;
})(this);
