(function () {
  'use strict';

  const { Segs, validate, letter, isTable } = ExamParser;
  const $ = s => document.querySelector(s);
  const state = { name: '', questions: [], ignored: [], filter: 'all' };
  let uid = 0;
  const imgs = new Map();

  const cfg = () => ({
    optCount: parseInt($('#cfgOpt').value, 10),
    mcTitle: $('#cfgTitle').value.trim() || 'Multiple choice',
    fontSize: parseInt($('#cfgSize').value, 10),
    blankLine: $('#cfgBlank').checked,
  });

  const ICON = {
    up: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="m12 7-6 6 1.4 1.4 4.6-4.6 4.6 4.6L18 13l-6-6Z"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="m12 17 6-6-1.4-1.4-4.6 4.6-4.6-4.6L6 11l6 6Z"/></svg>',
    add: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h1.6v-8H10Zm2.4 0v8H14v-8h-1.6Z"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/></svg>',
  };

  // ---------- Muat file ----------
  function textLines(txt) {
    return txt.replace(/^﻿/, '').split(/\r?\n/).map(t => ({ segs: [{ t }], auto: null }));
  }

  async function loadFile(file) {
    hideError();
    try {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      let lines;
      if (ext === 'docx') lines = await DocxReader.read(await file.arrayBuffer());
      else if (ext === 'txt') lines = textLines(await file.text());
      else if (ext === 'doc') throw new Error('File .doc (Word 97–2003) belum didukung. Buka file di Word, lalu Simpan Sebagai → Dokumen Word (.docx).');
      else if (ext === 'rtf') throw new Error('Untuk file .rtf, buka di Word lalu Simpan Sebagai .docx, kemudian unggah lagi.');
      else throw new Error('Format file tidak dikenali. Gunakan .docx.');
      processLines(lines, file.name);
    } catch (e) {
      console.error(e);
      showError(e.message || 'Gagal membaca file.');
    }
  }

  function processLines(lines, name) {
    const res = ExamParser.parse(lines, { optCount: cfg().optCount });
    if (!res.questions.length) {
      showError('Tidak ada soal yang terdeteksi. Pastikan setiap soal diawali nomor (mis. "1.") dan opsi diawali huruf (a., b., ...).');
      return;
    }
    state.questions = res.questions.map(q => Object.assign({ id: ++uid }, q));
    state.ignored = res.ignored;
    state.name = name;
    $('#start').hidden = true;
    $('#work').hidden = false;
    $('#topActions').hidden = false;
    $('#fileChip').textContent = name;
    $('#fileChip').title = name;
    renderAll();
    const bad = state.questions.filter(q => validate(q, cfg()).length).length;
    toast(state.questions.length + ' soal terdeteksi' + (bad ? ' · ' + bad + ' perlu dicek' : ''));
    window.scrollTo(0, 0);
  }

  function showError(msg) { const e = $('#startError'); e.textContent = msg; e.hidden = false; }
  function hideError() { $('#startError').hidden = true; }

  // ---------- Segmen <-> HTML ----------
  const escHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function regImg(img) {
    if (!img._id) { img._id = 'im' + (++uid); }
    imgs.set(img._id, img);
    return img._id;
  }

  function segsToHtml(segs) {
    return segs.map(s => {
      if (s.img) {
        const id = regImg(s.img);
        if (s.img.type === 'png' || s.img.type === 'jpeg') {
          const w = Math.round((s.img.w || 1500) / 15);
          return '<img data-img="' + id + '" src="data:image/' + s.img.type + ';base64,' + s.img.b64 + '" style="width:' + w + 'px" alt="">';
        }
        return '<span class="ph" contenteditable="false" data-img="' + id + '">Gambar ' + s.img.type.toUpperCase() + '</span>';
      }
      let h = escHtml(s.t);
      if (s.sub) h = '<sub>' + h + '</sub>';
      if (s.sup) h = '<sup>' + h + '</sup>';
      if (s.u) h = '<u>' + h + '</u>';
      if (s.i) h = '<i>' + h + '</i>';
      if (s.b) h = '<b>' + h + '</b>';
      return h;
    }).join('');
  }

  const BLOCK = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|UL|OL|TABLE|TR)$/;
  function htmlToParas(rootEl) {
    const paras = [[]];
    const cur = () => paras[paras.length - 1];
    const brk = () => { if (cur().length) paras.push([]); };
    (function walk(node, f) {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          if (n.nodeValue) cur().push(Object.assign({ t: n.nodeValue }, f));
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        const id = n.getAttribute('data-img');
        if (id && imgs.has(id)) { cur().push({ img: imgs.get(id) }); continue; }
        if (tag === 'BR') { paras.push([]); continue; }
        if (tag === 'TABLE') { brk(); paras.push(tableFromHtml(n)); paras.push([]); continue; }
        const g = Object.assign({}, f);
        if (tag === 'B' || tag === 'STRONG' || /bold|[6-9]00/.test(n.style.fontWeight)) g.b = true;
        if (tag === 'I' || tag === 'EM' || n.style.fontStyle === 'italic') g.i = true;
        if (tag === 'U' || /underline/.test(n.style.textDecoration)) g.u = true;
        if (tag === 'SUP') g.sup = true;
        if (tag === 'SUB') g.sub = true;
        const block = BLOCK.test(tag);
        if (block) brk();
        walk(n, g);
        if (block) brk();
      }
    })(rootEl, {});
    return paras
      .map(p => (isTable(p) ? p : Segs.tidy(p)))
      .filter(p => isTable(p) || !Segs.isEmpty(p));
  }

  // ---------- Tabel <-> HTML ----------
  function tableHtml(t) {
    const cols = t.rows.map(row => { let c = 0; return row.map(cell => { const s = c; c += cell.span || 1; return s; }); });
    let h = '<table class="tbl" data-widths="' + escHtml(JSON.stringify(t.widths || [])) + '"><tbody>';
    t.rows.forEach((row, r) => {
      h += '<tr>';
      row.forEach((cell, i) => {
        if (cell.vm === 'cont') return;
        let rs = 1;
        if (cell.vm === 'restart') {
          for (let k = r + 1; k < t.rows.length; k++) {
            const j = cols[k].indexOf(cols[r][i]);
            if (j < 0 || t.rows[k][j].vm !== 'cont') break;
            rs++;
          }
        }
        h += '<td' + (cell.span > 1 ? ' colspan="' + cell.span + '"' : '') + (rs > 1 ? ' rowspan="' + rs + '"' : '') + '>' +
          (cell.paras.length ? cell.paras.map(p => '<div>' + (segsToHtml(p) || '<br>') + '</div>').join('') : '<br>') + '</td>';
      });
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }

  function tableFromHtml(el) {
    let widths = [];
    try { widths = JSON.parse(el.getAttribute('data-widths') || '[]'); } catch (e) { widths = []; }
    const rows = [];
    const pending = [], pendingSpan = [];
    for (const tr of Array.from(el.rows)) {
      const row = [];
      const cells = Array.from(tr.cells);
      let col = 0, ci = 0;
      for (;;) {
        if (pending[col] > 0) {
          row.push({ paras: [], span: pendingSpan[col], vm: 'cont' });
          pending[col]--;
          col += pendingSpan[col];
          continue;
        }
        if (ci >= cells.length) break;
        const td = cells[ci++];
        const span = td.colSpan || 1, rs = td.rowSpan || 1;
        row.push({ paras: htmlToParas(td).filter(p => !isTable(p)), span, vm: rs > 1 ? 'restart' : null });
        if (rs > 1) { pending[col] = rs - 1; pendingSpan[col] = span; }
        col += span;
      }
      if (row.length) rows.push(row);
    }
    return { table: { rows, widths } };
  }

  // ---------- Render ----------
  function numbers() {
    const c = { mc: 0, essay: 0 }, map = new Map();
    for (const q of state.questions) map.set(q.id, ++c[q.type]);
    return map;
  }

  function renderAll() {
    const box = $('#questions');
    box.innerHTML = '';
    const nums = numbers();
    const settings = cfg();
    // Urutan mengikuti dokumen asli; judul bagian muncul tiap kali jenis soal berganti.
    let prevType = null;
    for (const q of state.questions) {
      if (q.type !== prevType) {
        const h = document.createElement('div');
        h.className = 'section-title';
        h.textContent = q.type === 'mc' ? settings.mcTitle : 'Essay';
        box.appendChild(h);
        prevType = q.type;
      }
      box.appendChild(card(q, nums.get(q.id), settings));
    }
    renderSide();
    applyFilter();
  }

  function card(q, n, settings) {
    const el = document.createElement('article');
    el.className = 'q';
    el.dataset.id = q.id;
    el.id = 'q' + q.id;
    const stemItems = q.stem.length ? q.stem : [[]];
    let stemHtml = stemItems.map(p => (isTable(p) ? tableHtml(p.table) : '<div>' + (segsToHtml(p) || '<br>') + '</div>')).join('');
    if (isTable(stemItems[stemItems.length - 1])) stemHtml += '<div><br></div>'; // tempat kursor setelah tabel
    let body = '<div class="q-head">' +
      '<span class="q-num">' + n + '.</span>' +
      '<select class="q-type" data-act="type" aria-label="Jenis soal"><option value="mc"' + (q.type === 'mc' ? ' selected' : '') + '>Pilihan ganda</option><option value="essay"' + (q.type === 'essay' ? ' selected' : '') + '>Essay</option></select>' +
      '<div class="q-tools">' +
      '<button class="icon-btn" data-act="up" title="Naikkan">' + ICON.up + '</button>' +
      '<button class="icon-btn" data-act="down" title="Turunkan">' + ICON.down + '</button>' +
      '<button class="icon-btn" data-act="addq" title="Sisipkan soal di bawah">' + ICON.add + '</button>' +
      '<button class="icon-btn del" data-act="del" title="Hapus soal">' + ICON.del + '</button>' +
      '</div></div>' +
      '<div class="edit stem" contenteditable="true" data-field="stem" aria-label="Teks soal">' + stemHtml + '</div>';
    if (q.type === 'mc') {
      body += '<ol class="opts">' + q.options.map((o, i) => {
        const L = letter(i);
        return '<li class="opt"><button class="key' + (q.answer === L ? ' on' : '') + '" data-act="key" data-i="' + i + '" title="Jadikan kunci">' + L.toLowerCase() + '</button>' +
          '<div class="edit" contenteditable="true" data-field="opt" data-i="' + i + '" aria-label="Opsi ' + L + '">' + segsToHtml(o) + '</div>' +
          '<button class="icon-btn del" data-act="rmopt" data-i="' + i + '" title="Hapus opsi">' + ICON.x + '</button></li>';
      }).join('') + '</ol>' +
        '<div class="q-foot"><button class="link-btn" data-act="addopt">+ Opsi</button>' +
        '<span class="ans">ANS: <b>' + (q.answer || '—') + '</b></span></div>';
    } else {
      body += '<label class="essay-ans">ANS: <input data-field="essay" value="' + escHtml(q.answer || '') + '" placeholder="Jawaban / pedoman penskoran (opsional)"></label>';
    }
    body += '<div class="badges"></div>';
    el.innerHTML = body;
    paintBadges(el, q, settings);
    return el;
  }

  function paintBadges(el, q, settings) {
    const issues = validate(q, settings);
    el.classList.toggle('has-issue', issues.length > 0);
    el.querySelector('.badges').innerHTML =
      issues.map(t => '<span class="badge warn">' + escHtml(t) + '</span>').join('') +
      q.notes.map(t => '<span class="badge info">' + escHtml(t) + '</span>').join('');
    const ans = el.querySelector('.ans b');
    if (ans) ans.textContent = q.answer || '—';
  }

  function renderSide() {
    const settings = cfg();
    const nums = numbers();
    const bad = [];
    for (const q of state.questions) {
      const iss = validate(q, settings);
      if (iss.length) bad.push({ q, iss });
    }
    const total = state.questions.length;
    $('#stats').innerHTML =
      '<div class="stat"><b>' + total + '</b><span>Soal</span></div>' +
      '<div class="stat ok"><b>' + (total - bad.length) + '</b><span>Siap</span></div>' +
      '<div class="stat warn"><b>' + bad.length + '</b><span>Perlu dicek</span></div>';
    $('#issueList').innerHTML = bad.length
      ? bad.map(({ q, iss }) => '<button data-go="' + q.id + '"><b>' + (q.type === 'mc' ? 'No. ' : 'Essay ') + nums.get(q.id) + '</b>' + escHtml(iss.join(' · ')) + '</button>').join('')
      : '<span class="none">Semua soal sudah lengkap.</span>';
    $('#ignoredCount').textContent = state.ignored.length;
    $('#ignoredList').innerHTML = state.ignored.map(t => '<li>' + escHtml(t) + '</li>').join('') || '<li>Tidak ada</li>';
  }

  function applyFilter() {
    const only = state.filter === 'issues';
    document.querySelectorAll('.q').forEach(el => {
      el.hidden = only && !el.classList.contains('has-issue');
    });
  }

  let sideTimer = null;
  function refreshMeta(q) {
    const el = document.getElementById('q' + q.id);
    if (el) paintBadges(el, q, cfg());
    clearTimeout(sideTimer);
    sideTimer = setTimeout(renderSide, 150);
  }

  // ---------- Interaksi ----------
  const find = id => state.questions.find(q => q.id === id);
  const qOf = el => { const c = el.closest('.q'); return c ? find(parseInt(c.dataset.id, 10)) : null; };

  function onAction(btn) {
    const q = qOf(btn);
    if (!q) return;
    const act = btn.dataset.act;
    const i = parseInt(btn.dataset.i, 10);
    const list = state.questions;
    const idx = list.indexOf(q);
    if (act === 'key') {
      q.answer = q.answer === letter(i) ? null : letter(i);
      const el = btn.closest('.q');
      el.querySelectorAll('.key').forEach((k, j) => k.classList.toggle('on', q.answer === letter(j)));
      refreshMeta(q);
      return;
    }
    if (act === 'up' || act === 'down') {
      const j = idx + (act === 'up' ? -1 : 1);
      if (j < 0 || j >= list.length) return;
      list[idx] = list[j]; list[j] = q;
    } else if (act === 'del') {
      if (!confirm('Hapus soal ini?')) return;
      list.splice(idx, 1);
    } else if (act === 'addq') {
      const nq = blankQuestion(q.type);
      list.splice(idx + 1, 0, nq);
      renderAll();
      focusStem(nq);
      return;
    } else if (act === 'addopt') {
      q.options.push([]);
      renderAll();
      const opts = document.querySelectorAll('#q' + q.id + ' [data-field="opt"]');
      if (opts.length) opts[opts.length - 1].focus();
      return;
    } else if (act === 'rmopt') {
      const removed = letter(i);
      q.options.splice(i, 1);
      if (q.answer) {
        if (q.answer === removed) q.answer = null;
        else if (q.answer > removed) q.answer = letter(q.answer.charCodeAt(0) - 66);
      }
    }
    renderAll();
    const el = document.getElementById('q' + q.id);
    if (el && (act === 'up' || act === 'down')) el.scrollIntoView({ block: 'nearest' });
  }

  function blankQuestion(type) {
    return {
      id: ++uid, type, srcNum: null, stem: [], notes: [],
      options: type === 'mc' ? Array.from({ length: cfg().optCount }, () => []) : [],
      answer: type === 'mc' ? null : '',
    };
  }

  function focusStem(q) {
    const el = document.querySelector('#q' + q.id + ' .stem');
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
  }

  function onInput(e) {
    const t = e.target;
    const q = qOf(t);
    if (!q) return;
    const f = t.dataset.field;
    if (f === 'stem') q.stem = htmlToParas(t);
    else if (f === 'opt') {
      const paras = htmlToParas(t).filter(p => !isTable(p));
      q.options[parseInt(t.dataset.i, 10)] = Segs.tidy(paras.reduce((a, p, k) => a.concat(k ? [{ t: ' ' }] : [], p), []));
    } else if (f === 'essay') q.answer = t.value;
    else return;
    refreshMeta(q);
  }

  function onPaste(e) {
    const t = e.target.closest('.edit');
    if (!t) return;
    e.preventDefault();
    const cd = e.clipboardData;
    const file = Array.from(cd.files || []).find(f => /^image\/(png|jpeg|gif|bmp|webp)$/.test(f.type));
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const im = new Image();
        im.onload = () => {
          let type = file.type === 'image/jpeg' ? 'jpeg' : 'png';
          let b64 = reader.result.split(',')[1];
          if (!/^image\/(png|jpeg)$/.test(file.type)) {
            const c = document.createElement('canvas');
            c.width = im.naturalWidth; c.height = im.naturalHeight;
            c.getContext('2d').drawImage(im, 0, 0);
            b64 = c.toDataURL('image/png').split(',')[1];
            type = 'png';
          }
          const img = { type, b64, pxW: im.naturalWidth, pxH: im.naturalHeight, w: im.naturalWidth * 15, h: im.naturalHeight * 15 };
          document.execCommand('insertHTML', false, segsToHtml([{ img }]));
          t.dispatchEvent(new Event('input', { bubbles: true }));
        };
        im.src = reader.result;
      };
      reader.readAsDataURL(file);
      return;
    }
    let text = cd.getData('text/plain') || '';
    if (t.dataset.field === 'opt') text = text.replace(/\s*\r?\n\s*/g, ' ');
    document.execCommand('insertText', false, text);
  }

  function exportRtf() {
    const settings = cfg();
    const bad = state.questions.filter(q => validate(q, settings).length).length;
    if (bad && !confirm(bad + ' soal masih perlu dicek (lihat panel kiri). Tetap ekspor?')) return;
    const rtf = RtfWriter.build(state.questions, settings);
    const blob = new Blob([rtf], { type: 'application/rtf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.name.replace(/\.[^.]+$/, '') || 'soal') + ' (rapi).rtf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('RTF diunduh: ' + a.download);
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---------- Wiring ----------
  const drop = $('#drop');
  $('#fileInput').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('#btnPaste').addEventListener('click', () => {
    const txt = $('#pasteText').value;
    if (!txt.trim()) return;
    hideError();
    processLines(textLines(txt), 'Soal tempel.txt');
  });
  $('#btnExport').addEventListener('click', exportRtf);
  $('#btnReset').addEventListener('click', () => {
    $('#work').hidden = true;
    $('#topActions').hidden = true;
    $('#start').hidden = false;
    $('#fileInput').value = '';
  });
  $('#btnAddQ').addEventListener('click', () => {
    const last = state.questions[state.questions.length - 1];
    const nq = blankQuestion(last ? last.type : 'mc');
    state.questions.push(nq);
    renderAll();
    focusStem(nq);
  });

  const qs = $('#questions');
  qs.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (b) onAction(b);
  });
  qs.addEventListener('change', e => {
    const s = e.target.closest('select[data-act="type"]');
    if (!s) return;
    const q = qOf(s);
    q.type = s.value;
    if (q.type === 'mc') {
      if (!q.options.length) q.options = Array.from({ length: cfg().optCount }, () => []);
      q.answer = /^[A-Z]$/.test(q.answer || '') ? q.answer : null;
    } else {
      q.answer = '';
    }
    renderAll();
    const el = document.getElementById('q' + q.id);
    if (el) el.scrollIntoView({ block: 'center' });
  });
  qs.addEventListener('input', onInput);
  qs.addEventListener('paste', onPaste);
  qs.addEventListener('keydown', e => {
    const t = e.target;
    if (e.key === 'Enter' && t.dataset && t.dataset.field === 'opt') {
      e.preventDefault();
      const all = Array.from(t.closest('.opts').querySelectorAll('[data-field="opt"]'));
      const next = all[all.indexOf(t) + 1];
      if (next) next.focus();
      else t.closest('.q').querySelector('[data-act="addopt"]').click();
    }
  });

  $('#issueList').addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    const el = document.getElementById('q' + b.dataset.go);
    if (!el) return;
    el.hidden = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  });

  document.querySelector('.seg').addEventListener('click', e => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    applyFilter();
  });

  ['cfgOpt', 'cfgTitle'].forEach(id => $('#' + id).addEventListener('change', renderAll));
})();
