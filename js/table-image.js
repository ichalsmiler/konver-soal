/*
 * Mengubah tabel soal menjadi gambar PNG yang ringkas namun tetap terbaca.
 *  - Lebar kolom dihitung dari isi (sepadat mungkin), maksimal selebar teks soal.
 *  - Huruf Times New Roman ±11 pt, digambar 2x lebih rapat agar tajam saat dicetak.
 *  - Mendukung tebal, miring, garis bawah, superscript/subscript, gambar di sel,
 *    sel gabungan (colspan/rowspan).
 * Hasil: { type: 'png', b64, w, h (twips), pxW, pxH } siap dipakai RtfWriter.
 */
(function (root) {
  'use strict';

  const FAMILY = '"Times New Roman", Times, serif';
  const SIZE = 15;                       // px CSS (≈ 11 pt)
  const LINE = Math.round(SIZE * 1.25);  // tinggi baris teks
  const PAD_X = 5, PAD_Y = 3;            // padding sel
  const MAX_W = 570;                     // lebar maksimal (px CSS) ≈ lebar teks soal di A4
  const SCALE = 2;                       // kerapatan piksel
  const TWIPS_PER_PX = 15;

  const fontOf = s => (s.i ? 'italic ' : '') + (s.b ? 'bold ' : '') +
    ((s.sup || s.sub) ? Math.round(SIZE * 0.7) : SIZE) + 'px ' + FAMILY;

  function loadImage(img) {
    if (!img || (img.type !== 'png' && img.type !== 'jpeg')) return Promise.resolve(null);
    return new Promise(res => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => res(null);
      el.src = 'data:image/' + img.type + ';base64,' + img.b64;
    });
  }

  // Satu "unit" = kata utuh (bisa terdiri dari beberapa segmen, mis. H + ₂ + O).
  function units(ctx, paras, imgEls) {
    const paraUnits = [];
    for (const p of paras) {
      const list = [];
      let cur = null;
      const flush = () => { if (cur) { list.push(cur); cur = null; } };
      for (const s of p) {
        if (s.img) {
          flush();
          const el = imgEls.get(s.img);
          const w = Math.round((s.img.w || 1500) / TWIPS_PER_PX);
          const h = Math.round((s.img.h || 1125) / TWIPS_PER_PX);
          list.push({ toks: [{ img: el, w, h }], w, h });
          continue;
        }
        for (const part of s.t.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { flush(); continue; }
          ctx.font = fontOf(s);
          const w = ctx.measureText(part).width;
          if (!cur) cur = { toks: [], w: 0, h: LINE };
          cur.toks.push({ text: part, s, w });
          cur.w += w;
        }
      }
      flush();
      paraUnits.push(list);
    }
    return paraUnits;
  }

  function measure(paraUnits, spaceW) {
    let min = 0, nat = 0;
    for (const list of paraUnits) {
      let line = 0;
      list.forEach((u, i) => { min = Math.max(min, u.w); line += (i ? spaceW : 0) + u.w; });
      nat = Math.max(nat, line);
    }
    return { min: Math.ceil(min) + 2 * PAD_X, nat: Math.ceil(nat) + 2 * PAD_X };
  }

  function layout(paraUnits, width, spaceW) {
    const inner = Math.max(1, width - 2 * PAD_X);
    const lines = [];
    for (const list of paraUnits) {
      let line = { items: [], w: 0, h: LINE };
      if (!list.length) { lines.push(line); continue; }
      for (const u of list) {
        const need = line.items.length ? spaceW + u.w : u.w;
        if (line.items.length && line.w + need > inner) {
          lines.push(line);
          line = { items: [], w: 0, h: LINE };
        }
        const x = line.items.length ? line.w + spaceW : 0;
        let w = u.w, h = u.h;
        if (u.toks[0].img !== undefined && w > inner) { h = Math.round(h * inner / w); w = inner; }
        line.items.push({ u, x, w, h });
        line.w = x + w;
        line.h = Math.max(line.h, h);
      }
      lines.push(line);
    }
    return { lines, h: lines.reduce((a, l) => a + l.h, 0) + 2 * PAD_Y };
  }

  async function render(table) {
    const rows = table.rows;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = SIZE + 'px ' + FAMILY;
    const spaceW = ctx.measureText(' ').width;

    // Muat gambar di dalam sel
    const imgEls = new Map();
    const loads = [];
    for (const row of rows) for (const c of row) for (const p of c.paras || []) for (const s of p) {
      if (s.img && !imgEls.has(s.img)) { imgEls.set(s.img, null); loads.push(loadImage(s.img).then(el => imgEls.set(s.img, el))); }
    }
    await Promise.all(loads);

    // Posisi kolom tiap sel
    const ncol = Math.max(1, ...rows.map(r => r.reduce((n, c) => n + (c.span || 1), 0)));
    const grid = rows.map(row => {
      let col = 0;
      return row.map(c => {
        const cell = { c, col, span: c.span || 1, pu: c.vm === 'cont' ? [] : units(ctx, c.paras || [], imgEls) };
        col += cell.span;
        return cell;
      });
    });
    // rowspan dari vMerge
    grid.forEach((row, r) => row.forEach(cell => {
      cell.rs = 1;
      if (cell.c.vm !== 'restart') return;
      for (let k = r + 1; k < grid.length; k++) {
        const below = grid[k].find(x => x.col === cell.col);
        if (!below || below.c.vm !== 'cont') break;
        cell.rs++;
      }
    }));

    // Lebar kolom: sepadat isi, maksimal MAX_W
    const minW = Array(ncol).fill(2 * PAD_X + 8), natW = Array(ncol).fill(2 * PAD_X + 8);
    const spanned = [];
    for (const row of grid) for (const cell of row) {
      if (cell.c.vm === 'cont') continue;
      cell.m = measure(cell.pu, spaceW);
      if (cell.span === 1) {
        minW[cell.col] = Math.max(minW[cell.col], cell.m.min);
        natW[cell.col] = Math.max(natW[cell.col], cell.m.nat);
      } else spanned.push(cell);
    }
    for (const cell of spanned) {
      const cols = [...Array(cell.span).keys()].map(i => Math.min(cell.col + i, ncol - 1));
      const last = cols[cols.length - 1];
      const sMin = cols.reduce((a, i) => a + minW[i], 0), sNat = cols.reduce((a, i) => a + natW[i], 0);
      if (sMin < cell.m.min) minW[last] += cell.m.min - sMin;
      if (sNat < cell.m.nat) natW[last] += cell.m.nat - sNat;
    }
    const sum = a => a.reduce((x, y) => x + y, 0);
    let widths;
    const orig = (table.widths || []).slice(0, ncol);
    if (table.fixedWidths && orig.length === ncol && orig.every(w => w > 0)) {
      // Lebar kolom asli (twips) agar beberapa tabel opsi tampil seragam.
      const px = orig.map(w => w / 15);
      const k = Math.min(1, MAX_W / sum(px));
      widths = px.map((w, i) => Math.max(Math.floor(w * k), minW[i]));
    } else if (sum(natW) <= MAX_W) widths = natW.slice();
    else if (sum(minW) >= MAX_W) widths = minW.slice();
    else {
      const extra = MAX_W - sum(minW);
      const flex = sum(natW.map((n, i) => n - minW[i])) || 1;
      widths = minW.map((m, i) => Math.floor(m + extra * (natW[i] - m) / flex));
    }
    const colX = [0];
    widths.forEach((w, i) => colX.push(colX[i] + w));
    const cellW = cell => colX[Math.min(cell.col + cell.span, ncol)] - colX[cell.col];

    // Tinggi baris
    const rowH = Array(grid.length).fill(LINE + 2 * PAD_Y);
    for (let r = 0; r < grid.length; r++) for (const cell of grid[r]) {
      if (cell.c.vm === 'cont') continue;
      cell.lay = layout(cell.pu, cellW(cell), spaceW);
      if (cell.rs === 1) rowH[r] = Math.max(rowH[r], cell.lay.h);
    }
    for (let r = 0; r < grid.length; r++) for (const cell of grid[r]) {
      if (!cell.lay || cell.rs === 1) continue;
      const have = sum(rowH.slice(r, r + cell.rs));
      if (have < cell.lay.h) rowH[r + cell.rs - 1] += cell.lay.h - have;
    }
    const rowY = [0];
    rowH.forEach((h, i) => rowY.push(rowY[i] + h));

    // Gambar
    const W = colX[ncol] + 1, H = rowY[grid.length] + 1;
    canvas.width = Math.ceil(W * SCALE);
    canvas.height = Math.ceil(H * SCALE);
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';

    for (let r = 0; r < grid.length; r++) for (const cell of grid[r]) {
      if (cell.c.vm === 'cont') continue;
      const x = colX[cell.col], y = rowY[r];
      const w = cellW(cell), h = sum(rowH.slice(r, r + cell.rs));
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      let ty = y + Math.max(PAD_Y, (h - cell.lay.h) / 2 + PAD_Y);
      for (const line of cell.lay.lines) {
        const base = ty + line.h - Math.round((LINE - SIZE) / 2) - Math.round(SIZE * 0.2);
        for (const it of line.items) {
          let tx = x + PAD_X + it.x;
          for (const t of it.u.toks) {
            if (t.img !== undefined) {
              if (t.img) ctx.drawImage(t.img, tx, ty + (line.h - it.h) / 2, it.w, it.h);
              tx += it.w;
              continue;
            }
            ctx.font = fontOf(t.s);
            const dy = t.s.sup ? -Math.round(SIZE * 0.35) : t.s.sub ? Math.round(SIZE * 0.2) : 0;
            ctx.fillText(t.text, tx, base + dy);
            if (t.s.u) ctx.fillRect(tx, base + 2, t.w, 1);
            tx += t.w;
          }
        }
        ty += line.h;
      }
    }

    const b64 = await encodeGray4(canvas).catch(() => null) || canvas.toDataURL('image/png').split(',')[1];
    return {
      type: 'png', b64,
      pxW: canvas.width, pxH: canvas.height,
      w: Math.round(W * TWIPS_PER_PX), h: Math.round(H * TWIPS_PER_PX),
    };
  }

  // ---------- PNG grayscale 4-bit (jauh lebih kecil dari PNG RGBA bawaan canvas) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  async function encodeGray4(canvas) {
    if (typeof CompressionStream === 'undefined') return null;
    const w = canvas.width, h = canvas.height;
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const rowBytes = Math.ceil(w / 2);
    const raw = new Uint8Array((rowBytes + 1) * h);
    let prev = new Uint8Array(rowBytes), cur = new Uint8Array(rowBytes);
    const sub = new Uint8Array(rowBytes), up = new Uint8Array(rowBytes);
    for (let y = 0; y < h; y++) {
      cur.fill(0);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const g = Math.round((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 / 17); // 0..15
        cur[x >> 1] |= x & 1 ? g : g << 4;
      }
      // Pilih filter baris terbaik (None / Sub / Up)
      let sNone = 0, sSub = 0, sUp = 0;
      for (let i = 0; i < rowBytes; i++) {
        sub[i] = (cur[i] - (i ? cur[i - 1] : 0)) & 0xFF;
        up[i] = (cur[i] - prev[i]) & 0xFF;
        sNone += cur[i] < 128 ? cur[i] : 256 - cur[i];
        sSub += sub[i] < 128 ? sub[i] : 256 - sub[i];
        sUp += up[i] < 128 ? up[i] : 256 - up[i];
      }
      const o = y * (rowBytes + 1);
      if (sUp <= sSub && sUp <= sNone) { raw[o] = 2; raw.set(up, o + 1); }
      else if (sSub <= sNone) { raw[o] = 1; raw.set(sub, o + 1); }
      else { raw[o] = 0; raw.set(cur, o + 1); }
      const t = prev; prev = cur; cur = t;
    }
    const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h);
    ihdr[8] = 4;  // bit depth
    ihdr[9] = 0;  // grayscale
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
    const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { png.set(p, off); off += p.length; }
    let bin = '';
    for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  root.TableImage = { render, encodeGray4 };
})(this);
