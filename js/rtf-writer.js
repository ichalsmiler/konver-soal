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
      else o += '\\u' + (c > 32767 ? c - 65536 : c) + '?';
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

  function pict(img) {
    let w = img.w || 2880, h = img.h || 2160;
    if (w > MAX_IMG_W) { h = Math.round(h * MAX_IMG_W / w); w = MAX_IMG_W; }
    let kind;
    let pw, ph;
    if (img.type === 'png' || img.type === 'jpeg') {
      kind = img.type === 'png' ? '\\pngblip' : '\\jpegblip';
      pw = img.pxW || Math.round(w / 15); ph = img.pxH || Math.round(h / 15);
    } else if (img.type === 'emf') {
      kind = '\\emfblip';
      pw = Math.round(w * 2540 / 1440); ph = Math.round(h * 2540 / 1440);
    } else if (img.type === 'wmf') {
      kind = '\\wmetafile8';
      pw = Math.round(w * 2540 / 1440); ph = Math.round(h * 2540 / 1440);
    } else return '';
    return '{\\pict' + kind + '\\picw' + pw + '\\pich' + ph + '\\picwgoal' + w + '\\pichgoal' + h + '\n' + b64ToHex(img.b64) + '}';
  }

  function runs(segs) {
    let o = '';
    for (const s of segs) {
      if (s.img) { o += pict(s.img); continue; }
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

  function build(questions, cfg) {
    cfg = Object.assign({
      mcTitle: 'Multiple choice', essayTitle: 'Essay', font: 'Times New Roman',
      fontSize: 12, blankLine: true,
    }, cfg);
    const fs = '\\fs' + Math.round(cfg.fontSize * 2);
    const base = '\\f0' + fs;
    const mc = questions.filter(q => q.type === 'mc');
    const essay = questions.filter(q => q.type === 'essay');

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

    const stemParas = (q, ls, n) => {
      q.stem.forEach((p, k) => {
        if (k === 0) { listPara(ls, n + '.', 360, runs(p)); return; }
        const first = p.find(s => !s.img);
        const m = first && p[0] === first ? RE_SUB.exec(first.t) : null;
        if (m) {
          const rest = [Object.assign({}, first, { t: first.t.slice(m[0].length) })].concat(p.slice(1));
          para('\\fi-360\\li720\\lin720\\tx720', esc(m[1]) + '\\tab ' + runs(rest));
        } else {
          para('\\li360\\lin360', runs(p));
        }
      });
      if (!q.stem.length) listPara(ls, n + '.', 360, '');
    };

    if (mc.length) {
      para('', esc(cfg.mcTitle));
      mc.forEach((q, i) => {
        stemParas(q, 1, i + 1);
        q.options.forEach((o, k) => listPara(3 + i, String.fromCharCode(97 + k) + '.', 720, runs(o)));
        para('\\li360\\lin360', 'ANS: ' + esc(q.answer || ''));
        if (cfg.blankLine) para('', '');
      });
    }
    if (essay.length) {
      if (mc.length) para('', '');
      para('', esc(cfg.essayTitle));
      essay.forEach((q, i) => {
        stemParas(q, 2, i + 1);
        para('\\li360\\lin360', 'ANS: ' + esc(q.answer || ''));
        if (cfg.blankLine) para('', '');
      });
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

  const api = { build, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RtfWriter = api;
})(this);
