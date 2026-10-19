/*
 * Parser soal: mengubah daftar baris (hasil baca .docx / teks) menjadi
 * struktur soal { type, stem[], options[], answer } yang rapi.
 *
 * Satu baris = { segs: [{t, b, i, u, sup, sub, mark} | {img}], auto: null | {fmt, label, n, key} }
 * `auto` berisi info penomoran otomatis Word (numbering) bila ada.
 */
(function (root) {
  'use strict';

  const OBJ = '￼'; // satu karakter pengganti gambar agar offset teks tetap konsisten

  // ---------- Utilitas segmen ----------
  const Segs = {
    text(segs) {
      return segs.map(s => (s.img ? OBJ : s.t)).join('');
    },
    slice(segs, a, b = Infinity) {
      const out = [];
      let pos = 0;
      for (const s of segs) {
        const len = s.img ? 1 : s.t.length;
        const st = pos, en = pos + len;
        pos = en;
        if (en <= a || st >= b) continue;
        if (s.img) out.push(s);
        else {
          const t = s.t.slice(Math.max(0, a - st), Math.min(len, b - st));
          if (t) out.push(Object.assign({}, s, { t }));
        }
      }
      return out;
    },
    /** Rapikan spasi (tab/spasi ganda -> satu spasi) dan buang spasi di tepi. */
    tidy(segs) {
      let out = [];
      let prevSpace = true;
      for (const s of segs) {
        if (s.img) { out.push(s); prevSpace = false; continue; }
        let t = s.t.replace(/[\s ]+/g, ' ');
        if (prevSpace) t = t.replace(/^ /, '');
        if (!t) continue;
        prevSpace = t.endsWith(' ');
        out.push(Object.assign({}, s, { t }));
      }
      while (out.length && !out[out.length - 1].img) {
        const last = out[out.length - 1];
        const t = last.t.replace(/\s+$/, '');
        if (t) { out[out.length - 1] = Object.assign({}, last, { t }); break; }
        out.pop();
      }
      // gabungkan segmen bersebelahan dengan format sama
      const merged = [];
      for (const s of out) {
        const p = merged[merged.length - 1];
        if (p && !p.img && !s.img && sameFmt(p, s)) p.t += s.t;
        else merged.push(s.img ? s : Object.assign({}, s));
      }
      return merged;
    },
    isEmpty(segs) {
      return !segs.some(s => s.img || /\S/.test(s.t));
    },
    hasImage(segs) {
      return segs.some(s => s.img);
    },
    /** true bila seluruh teks bermuatan pada segs memiliki properti `key`. */
    allHave(segs, key) {
      const ts = segs.filter(s => !s.img && /\S/.test(s.t));
      return ts.length > 0 && ts.every(s => s[key]);
    },
    /** Ganti teks di awal/akhir (regex harus berjangkar ^ atau $). */
    stripEdge(segs, re) {
      const txt = Segs.text(segs);
      const m = re.exec(txt);
      if (!m) return segs;
      return Segs.slice(segs, 0, m.index).concat(Segs.slice(segs, m.index + m[0].length));
    },
  };

  function sameFmt(a, b) {
    return !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u &&
      !!a.sup === !!b.sup && !!a.sub === !!b.sub && !!a.mark === !!b.mark;
  }

  const letter = i => String.fromCharCode(65 + i);
  const DEC_FMTS = new Set(['decimal', 'decimalZero', 'ordinal', 'cardinalText', 'ordinalText', 'decimalEnclosedParen', 'decimalEnclosedFullstop']);
  const LETTER_FMTS = new Set(['lowerLetter', 'upperLetter']);

  // ---------- Pola ----------
  const RE_KEY_HEADER = /^(?:[A-Z]|[IVX]+)?[.)]?\s*(?:kunci(?:\s+jawaban)?|answer\s*key)(?:\s+(?:soal|pilihan\s+ganda|pg|essay|esai|uraian))?\s*:?$/i;
  const RE_NOTE = /^(?:catatan|keterangan|note|ket)\s*:/i;
  const RE_QNUM = /^(?:soal\s*(?:no(?:mor)?\.?\s*)?)?(\d{1,3})\s*(?:[.)]|\s-\s|\t)\s*(?!\d)/i;
  const RE_OPT = /^\(?([A-Za-z])\s*[.)]\s*|^([A-Za-z])\t\s*/;
  const RE_ANS = /^(ans(?:wer)?|kunci(?:\s+jawaban)?|jawaban(?:\s+(?:yang\s+)?benar)?|jawab|jwb|key)\b\s*([:=.\-]?)\s*(.*)$/i;
  const RE_STEM_END = /(\.{3,}|…)\s*[?.]?\s*$/;
  const RE_ANS_MARK_TAIL = /\s*(?:\*+|\((?:benar|kunci|jawaban|v)\)|[✓✔√])\s*$/i;
  const RE_ANS_MARK_HEAD = /^\s*(?:\*+|[✓✔√])\s*/;
  const RE_ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

  function sectionOf(text) {
    if (text.length > 45) return null;
    const t = text.replace(/^(?:[A-Z]|[IVX]+)[.)]\s*/, '').replace(/[:.]\s*$/, '').trim();
    if (/^(?:soal\s+)?(?:multiple\s*choice|pilihan\s+ganda|pilgan|pg)$/i.test(t) || /^soal(?:-soal)?$/i.test(t)) return 'mc';
    if (/^(?:soal\s+)?(?:essay|esai|esay|uraian|isian(?:\s+singkat)?)$/i.test(t)) return 'essay';
    return null;
  }

  function leadOffset(raw) {
    return raw.length - raw.replace(/^[\s ]+/, '').length;
  }

  function matchQuestion(ln, segs, raw, text) {
    if (ln.auto && DEC_FMTS.has(ln.auto.fmt)) {
      return { num: ln.auto.n, segs, key: ln.auto.key };
    }
    // Baris bernomor huruf otomatis (a., b., ...) adalah opsi, walau teksnya diawali angka ("1. Dekat ...").
    if (ln.auto && LETTER_FMTS.has(ln.auto.fmt)) return null;
    const m = RE_QNUM.exec(text);
    if (!m) return null;
    const off = leadOffset(raw) + m[0].length;
    const rest = Segs.slice(segs, off);
    if (Segs.isEmpty(rest)) return null;
    return { num: parseInt(m[1], 10), segs: rest, key: null };
  }

  function matchOption(ln, segs, raw, text, cur) {
    const expected = String.fromCharCode(97 + cur.options.length);
    if (ln.auto && LETTER_FMTS.has(ln.auto.fmt)) return [segs];
    const m = RE_OPT.exec(text);
    if (!m) return null;
    const L = (m[1] || m[2]).toLowerCase();
    if (L !== expected) return null;
    const lead = leadOffset(raw);
    // Cari opsi berikutnya yang ditulis dalam satu baris: "a. x   b. y   c. z"
    const cuts = [];
    let from = m[0].length;
    let code = expected.charCodeAt(0) + 1;
    for (;;) {
      const l = String.fromCharCode(code);
      const re = new RegExp('(\\s+)\\(?[' + l + l.toUpperCase() + ']\\s*[.)]\\s*', 'g');
      re.lastIndex = from;
      const mm = re.exec(text);
      if (!mm) break;
      cuts.push({ at: mm.index, end: mm.index + mm[0].length, ws: mm[1] });
      from = mm.index + mm[0].length;
      code++;
    }
    const useCuts = cuts.length >= 2 || (cuts.length === 1 && /\t| {2,}/.test(cuts[0].ws));
    if (!useCuts) return [Segs.slice(segs, lead + m[0].length)];
    const parts = [];
    let start = m[0].length;
    for (const c of cuts) {
      parts.push(Segs.slice(segs, lead + start, lead + c.at));
      start = c.end;
    }
    parts.push(Segs.slice(segs, lead + start));
    return parts;
  }

  function matchAnswer(text, cur) {
    const m = RE_ANS.exec(text);
    if (!m) return null;
    const isAns = /^ans/i.test(m[1]);
    const hasSep = !!m[2];
    if (cur.type === 'essay') {
      if (!isAns && !hasSep) return null;
      return { text: m[3].trim() };
    }
    if (!isAns && !hasSep && cur.options.length < 2) return null;
    if (cur.options.length === 0 && !isAns) return null;
    const v = m[3].trim();
    const lm = /^\(?([A-Za-z])\)?(?:[.)]|\s|$)/.exec(v);
    if (lm) return { letter: lm[1].toUpperCase() };
    const norm = s => s.toLowerCase().replace(/[\s\W_]+/g, ' ').trim();
    const idx = cur.options.findIndex(o => norm(Segs.text(o.segs)) === norm(v));
    if (idx >= 0) return { letter: letter(idx) };
    return { letter: null, raw: v };
  }

  function isKeyLine(label, text) {
    const t = ((label ? label + ' ' : '') + text).trim();
    return /^(?:\d{1,3}\s*[.):=\-]?\s*\(?[A-Ea-e]\)?\s*[,;]?\s*){2,}$/.test(t);
  }

  function parseKey(parts) {
    const map = new Map();
    const all = parts.join(' ');
    const re = /(\d{1,3})\s*[.):=\-]?\s*\(?([A-Ea-e])\)?(?![A-Za-z])/g;
    let m;
    while ((m = re.exec(all))) map.set(parseInt(m[1], 10), m[2].toUpperCase());
    return map;
  }

  // ---------- Tabel ----------
  const withLabel = l => (l.auto ? [{ t: l.auto.label + ' ' }].concat(l.segs) : l.segs);
  const joinWith = (parts, sep) => parts.reduce((a, p, i) => a.concat(i ? [{ t: sep }] : [], p), []);

  function cellParas(cell) {
    const out = [];
    for (const l of cell.lines) {
      if (l.table) out.push(...flattenTable(l.table).map(withLabel));
      else out.push(withLabel(l));
    }
    return out.map(p => Segs.tidy(p)).filter(p => !Segs.isEmpty(p));
  }
  const cellText = cell => cell.lines.map(l => Segs.text(l.segs)).join(' ').trim();

  const isLetterCell = (cell, i, cur) => {
    const m = /^\(?([A-Za-z])\s*[.)]?$/.exec(cellText(cell));
    return !!m && m[1].toLowerCase() === String.fromCharCode(97 + cur.options.length + i);
  };

  /** Tabel opsi menyamping: baris pertama A | B | C ..., baris berikutnya isi tiap opsi per kolom. */
  function optionColumns(table, cur) {
    const rows = table.rows;
    if (rows.length < 2 || rows[0].length < 2 || !rows[0].every((c, i) => isLetterCell(c, i, cur))) return null;
    return rows[0].map((_, col) => {
      const parts = rows.slice(1).map(r => (r[col] ? joinWith(cellParas(r[col]), ' ') : [])).filter(p => !Segs.isEmpty(p));
      return joinWith(parts, ' ');
    });
  }

  /** Tabel yang setiap barisnya diawali huruf opsi berurutan (A, B, C...) -> isi opsi. */
  function optionRows(table, cur) {
    const byCol = optionColumns(table, cur);
    if (byCol) return byCol;
    const rows = table.rows;
    if (rows.length < 2) return null;
    const out = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (row.length < 2) return null;
      const m = /^\(?([A-Za-z])\s*[.)]?$/.exec(cellText(row[0]));
      if (!m || m[1].toLowerCase() !== String.fromCharCode(97 + cur.options.length + r)) return null;
      const parts = row.slice(1).map(c => joinWith(cellParas(c), ' ')).filter(p => !Segs.isEmpty(p));
      out.push(joinWith(parts, '; '));
    }
    return out;
  }

  function stemTable(table) {
    return {
      widths: table.widths || [],
      rows: table.rows.map(row => row.map(c => ({ paras: cellParas(c), span: c.span || 1, vm: c.vm || null }))),
    };
  }

  /** Ratakan tabel jadi baris; sel berisi label pendek ("1", "a.") digabung ke sel sesudahnya. */
  function flattenTable(table) {
    const out = [];
    for (const row of table.rows) {
      const cells = row.filter(c => c.vm !== 'cont');
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const next = cells[i + 1];
        const only = c.lines.length && !c.lines.some(l => l.table || Segs.hasImage(l.segs)) ? cellText(c) : null;
        if (only && /^(\d{1,3}|[A-Za-z])[.)]?$/.test(only) && next && next.lines.length && !next.lines[0].table) {
          const lbl = /[.)]$/.test(only) ? only : only + '.';
          next.lines = next.lines.slice();
          next.lines[0] = Object.assign({}, next.lines[0], { segs: [{ t: lbl + ' ' }].concat(next.lines[0].segs) });
          continue;
        }
        out.push(...c.lines);
      }
    }
    return out;
  }

  const isTable = p => !!(p && p.table);

  // ---------- Parser utama ----------
  function parse(lines, options) {
    const cfg = Object.assign({ optCount: 5 }, options);
    const questions = [];
    const ignored = [];
    const keyParts = [];
    let cur = null;
    let type = 'mc';
    let mode = 'q';
    let expected = 1;
    let qListKey = null;

    const newQ = (num, segs, key) => {
      cur = {
        type, srcNum: num, stem: [], options: [], answer: null, answerText: null,
        notes: [], flags: {}, autoKey: key || null,
      };
      if (segs && !Segs.isEmpty(segs)) cur.stem.push({ segs, raw: segs, auto: null });
      questions.push(cur);
      expected = (num != null ? num : expected) + 1;
      if (key && !qListKey) qListKey = key;
    };

    const queue = lines.slice();
    while (queue.length) {
      const ln = queue.shift();

      // Tabel: opsi (baris A–E), bagian dari soal, atau tata letak yang diratakan.
      if (ln.table) {
        const t = ln.table;
        if (mode === 'q' && cur && !cur.flags.answerSeen) {
          if (cur.type === 'mc' && cur.options.length === 0) {
            const opts = optionRows(t, cur);
            if (opts) { for (const s of opts) cur.options.push({ segs: s }); continue; }
          }
          if (cur.type === 'essay' || cur.options.length === 0) {
            cur.stem.push({ table: stemTable(t) });
            continue;
          }
        }
        queue.unshift(...flattenTable(t));
        continue;
      }

      const segs = ln.segs || [];
      const raw = Segs.text(segs).replace(/ /g, ' ');
      const text = raw.trim();
      const label = ln.auto ? ln.auto.label : '';
      if (!text) {
        // Nomor soal otomatis tanpa teks: isi soalnya (mis. gambar) ada di paragraf berikutnya.
        if (mode === 'q' && ln.auto && DEC_FMTS.has(ln.auto.fmt)) {
          const sameList = ln.auto.key === qListKey;
          if (!cur || cur.options.length >= 2 || cur.flags.answerSeen || (ln.auto.n === expected && sameList)) {
            newQ(ln.auto.n, null, ln.auto.key);
          }
        }
        continue;
      }
      if (ln.math && cur) cur.flags.math = true;
      if (ln.drawing && cur) cur.flags.drawing = true;
      if (ln.pictures && cur) cur.flags.pictures = true;
      if (ln.legacy && cur) cur.flags.legacy = true;
      if (RE_ARABIC.test(text) && cur) cur.flags.arabic = true;

      if (mode === 'key') { keyParts.push((label ? label + ' ' : '') + text); continue; }
      if (mode === 'stop') { ignored.push((label ? label + ' ' : '') + text); continue; }

      if (!ln.auto && RE_KEY_HEADER.test(text) && text.length < 50) { mode = 'key'; cur = null; continue; }
      if (cur && cur.options.length >= 2 && isKeyLine(label, text)) {
        mode = 'key'; keyParts.push((label ? label + ' ' : '') + text); continue;
      }
      if (cur && (cur.options.length || cur.answer != null) && RE_NOTE.test(text)) {
        mode = 'stop'; ignored.push(text); continue;
      }
      const sec = !ln.auto || !DEC_FMTS.has(ln.auto.fmt) ? sectionOf(text) : null;
      if (sec) {
        // "Soal" bernomor sebelum judul bagian pertama tanpa opsi/kunci = petunjuk pengerjaan.
        if (questions.length && questions.every(q => !q.options.length && !q.flags.answerSeen)) {
          for (const q of questions) for (const p of q.stem) if (!isTable(p)) ignored.push(Segs.text(p.segs).trim());
          questions.length = 0;
          expected = 1;
          qListKey = null;
        }
        type = sec; cur = null; continue;
      }

      // Kunci jawaban di bawah soal
      if (cur) {
        const a = matchAnswer(text, cur);
        if (a) {
          if (cur.type === 'essay') { cur.answerText = a.text; cur.answer = a.text; }
          else if (a.letter) cur.answer = a.letter;
          else { cur.answer = null; cur.flags.badAnswer = a.raw; }
          if (cur.type === 'mc' && cur.answer == null && !a.raw) cur.flags.badAnswer = '';
          cur.flags.answerSeen = true;
          continue;
        }
      }

      // Nomor soal baru?
      const q = matchQuestion(ln, segs, raw, text);
      if (q) {
        const restText = Segs.text(q.segs).trim();
        // "1. B" setelah soal selesai = tabel kunci tanpa judul
        if (cur && cur.options.length >= 2 && /^\(?[A-Ea-e]\)?\.?$/.test(restText)) {
          mode = 'key'; keyParts.push(q.num + '. ' + restText); continue;
        }
        const sameList = q.key && q.key === qListKey;
        const startNew = !cur || cur.options.length >= 2 || cur.flags.answerSeen ||
          (q.num === expected && (sameList || RE_STEM_END.test(restText) || cur.type === 'essay')) ||
          // penomoran mulai lagi dari 1 setelah daftar bernomor (mis. petunjuk) = soal pertama
          (q.num === 1 && expected > 2 && !cur.options.length && RE_STEM_END.test(restText));
        if (startNew) { newQ(q.num, q.segs, q.key); continue; }
      }

      // Opsi jawaban?
      if (cur && cur.type === 'mc' && !cur.flags.answerSeen) {
        const parts = matchOption(ln, segs, raw, text, cur);
        if (parts) {
          for (const p of parts) cur.options.push({ segs: p });
          continue;
        }
      }

      // Huruf tunggal setelah opsi = kunci
      if (cur && cur.type === 'mc' && cur.options.length >= 2 && cur.answer == null &&
        /^\(?[A-Za-z]\)?\.?$/.test(text)) {
        cur.answer = text.replace(/[^A-Za-z]/g, '').toUpperCase();
        cur.flags.answerSeen = true;
        continue;
      }

      if (!cur) { ignored.push((label ? label + ' ' : '') + text); continue; }

      const para = { segs: label ? [{ t: label + ' ' }].concat(segs) : segs, raw: segs, auto: ln.auto || null };
      if (cur.type === 'essay') {
        if (cur.flags.answerSeen) {
          cur.answerText = ((cur.answerText || '') + ' ' + text).trim();
          cur.answer = cur.answerText;
        } else cur.stem.push(para);
      } else if (cur.options.length === 0 && !cur.flags.answerSeen) {
        cur.stem.push(para);
      } else if (cur.options.length >= 2 || cur.flags.answerSeen) {
        newQ(null, null, null);
        cur.stem.push(para);
        cur.notes.push('Soal tanpa nomor, dipisahkan otomatis');
      } else {
        const last = cur.options[cur.options.length - 1];
        last.segs = last.segs.concat([{ t: ' ' }], para.segs);
      }
    }

    const key = parseKey(keyParts);
    const result = questions.map((q, i) => finalize(q, i, key, cfg)).filter(Boolean);
    // Daftar bernomor di akhir dokumen yang mulai lagi dari 1 dan tanpa kunci = catatan, bukan soal.
    for (let j = result.length - 1; j > 0; j--) {
      if (result[j].srcNum !== 1) continue;
      const tail = result.slice(j);
      if (result[j - 1].answer && tail.every(q => q.type === 'mc' && !q.answer)) {
        for (const q of tail) {
          for (const p of q.stem) if (!isTable(p)) ignored.push(Segs.text(p).trim());
          for (const o of q.options) ignored.push(Segs.text(o).trim());
        }
        result.length = j;
      }
      break;
    }
    const counter = { mc: 0, essay: 0 };
    for (const q of result) {
      const n = ++counter[q.type];
      if (q.srcNum != null && q.srcNum !== n) q.notes.push('Nomor asli ' + q.srcNum + ', dinomori ulang jadi ' + n);
    }
    return { questions: result, ignored, keyCount: key.size };
  }

  // Tebal yang hanya jadi penanda kunci dihapus agar tidak membocorkan jawaban.
  function unbold(opt) {
    opt.segs = opt.segs.map(s => (s.img ? s : Object.assign({}, s, { b: false })));
    return true;
  }

  function finalize(q, index, key, cfg) {
    const notes = q.notes.slice();

    // Opsi tanpa huruf (mis. bullet atau baris polos) -> ambil dari akhir stem
    if (q.type === 'mc' && q.options.length === 0 && q.stem.length >= 3) {
      let i = q.stem.length;
      const lastKey = q.stem[i - 1].auto && q.stem[i - 1].auto.key;
      if (lastKey) while (i > 1 && q.stem[i - 1].auto && q.stem[i - 1].auto.key === lastKey) i--;
      let count = q.stem.length - i;
      if (!(lastKey && count >= 2 && count <= 8)) {
        let tail = 0; // hanya paragraf di akhir (bukan tabel) yang boleh jadi opsi
        while (tail < q.stem.length - 1 && !isTable(q.stem[q.stem.length - 1 - tail])) tail++;
        count = q.answer ? Math.min(cfg.optCount, tail) : 0;
        i = q.stem.length - count;
      }
      if (count >= 2) {
        q.options = q.stem.splice(i).map(p => ({ segs: p.raw }));
        notes.push('Opsi tanpa huruf a–e dideteksi otomatis, mohon dicek');
      }
    }

    // Tanda kunci di opsi: "*", "(benar)", ✓, teks tebal/berwarna/stabilo
    const opts = q.options.map(o => ({ segs: o.segs, marked: false }));
    for (const o of opts) {
      const t = Segs.text(o.segs);
      if (RE_ANS_MARK_TAIL.test(t) || RE_ANS_MARK_HEAD.test(t)) {
        o.marked = true;
        o.segs = Segs.stripEdge(Segs.stripEdge(o.segs, RE_ANS_MARK_TAIL), RE_ANS_MARK_HEAD);
      }
    }
    if (q.type === 'mc' && q.answer == null) {
      const pick = (pred, why) => {
        const hits = opts.map((o, i) => (pred(o) ? i : -1)).filter(i => i >= 0);
        if (hits.length === 1 && opts.length >= 2) {
          q.answer = letter(hits[0]);
          notes.push('Kunci diambil dari ' + why);
          return true;
        }
        return false;
      };
      pick(o => o.marked, 'tanda pada opsi') ||
        pick(o => Segs.allHave(o.segs, 'mark'), 'opsi yang diwarnai/distabilo') ||
        (pick(o => Segs.allHave(o.segs, 'b'), 'opsi yang dicetak tebal') && unbold(opts[q.answer.charCodeAt(0) - 65]));
    }
    if (q.type === 'mc' && q.answer == null) {
      const k = key.get(q.srcNum != null ? q.srcNum : index + 1);
      if (k) { q.answer = k; notes.push('Kunci diambil dari daftar kunci jawaban'); }
    }

    const clean = s => Segs.tidy(s.map(x => (x.mark ? Object.assign({}, x, { mark: false }) : x)));
    const stem = q.stem
      .map(p => (isTable(p) ? p : clean(p.segs)))
      .filter(s => isTable(s) || !Segs.isEmpty(s));
    const options = opts.map(o => clean(o.segs));

    if (!stem.length && !options.length) return null;
    if (q.flags.badAnswer != null && q.answer == null) {
      notes.push('Baris kunci tidak dikenali' + (q.flags.badAnswer ? ': "' + q.flags.badAnswer + '"' : ''));
    }
    if (q.flags.drawing) notes.push('Ilustrasi shape Word diubah menjadi gambar — mohon dicek');
    if (q.flags.pictures) notes.push('Gambar berlabel (A, B, ...) digabung jadi satu gambar agar label tetap sejajar');
    if (q.flags.legacy) notes.push('Ada shape Word lama (VML) yang tidak ikut terbaca — ganti dengan gambar');
    if (q.flags.math) notes.push('Ada persamaan Word, diubah jadi teks biasa — sebaiknya pakai gambar');
    if (q.flags.arabic) notes.push('Ada tulisan Arab — sesuai ketentuan sebaiknya pakai gambar');
    return {
      type: q.type,
      srcNum: q.srcNum,
      stem,
      options,
      answer: q.type === 'mc' ? q.answer : (q.answerText || ''),
      notes,
    };
  }

  /** Daftar masalah yang perlu diperbaiki sebelum ekspor. */
  function validate(q, cfg) {
    const optCount = (cfg && cfg.optCount) || 5;
    const issues = [];
    if (!q.stem.length || q.stem.every(p => !isTable(p) && Segs.isEmpty(p))) issues.push('Teks soal kosong');
    if (q.type === 'mc') {
      if (!q.options.length) issues.push('Tidak ada opsi jawaban');
      else if (q.options.length !== optCount) issues.push('Jumlah opsi ' + q.options.length + ' (standar ' + optCount + ')');
      q.options.forEach((o, i) => { if (Segs.isEmpty(o)) issues.push('Opsi ' + letter(i) + ' kosong'); });
      const seen = new Map();
      q.options.forEach((o, i) => {
        const t = Segs.text(o).trim().toLowerCase();
        if (!t || Segs.hasImage(o)) return;
        if (seen.has(t)) issues.push('Opsi ' + letter(seen.get(t)) + ' dan ' + letter(i) + ' sama');
        else seen.set(t, i);
      });
      if (!q.answer) issues.push('Kunci jawaban belum ada');
      else if (q.options.length && q.answer.charCodeAt(0) - 65 >= q.options.length) {
        issues.push('Kunci ' + q.answer + ' tidak ada di opsi');
      }
    }
    return issues;
  }

  const api = { parse, validate, Segs, letter, isTable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExamParser = api;
})(this);
