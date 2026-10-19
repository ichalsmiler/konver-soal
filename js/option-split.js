/*
 * Memotong gambar berisi daftar opsi bertumpuk ("A. ...", "B. ...", ...) menjadi
 * satu gambar per opsi, tanpa label hurufnya. Tidak memakai OCR: gambar dipindai
 * per baris (baris tulisan dipisah baris kosong), lalu kolom label di kiri dibuang.
 * Bila bentuknya tidak meyakinkan, hasilnya null dan gambar dibiarkan utuh.
 */
(function (root) {
  'use strict';

  function load(img) {
    return new Promise(res => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => res(null);
      el.src = 'data:image/' + img.type + ';base64,' + img.b64;
    });
  }

  // Rangkaian indeks bertinta: [{a, b}] (inklusif), celah < minGap digabung.
  function runs(profile, minGap) {
    const out = [];
    let start = -1;
    for (let i = 0; i <= profile.length; i++) {
      const ink = i < profile.length && profile[i] > 0;
      if (ink && start < 0) start = i;
      if (!ink && start >= 0) { out.push({ a: start, b: i - 1 }); start = -1; }
    }
    const merged = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && r.a - last.b - 1 < minGap) last.b = r.b;
      else merged.push(Object.assign({}, r));
    }
    return merged;
  }

  /**
   * @param img   segmen gambar { type: 'png'|'jpeg', b64, w, h }
   * @param count jumlah opsi yang diharapkan
   * @returns { stem: gambar teks soal | null, options: [gambar opsi] }, atau null bila tidak cocok
   */
  async function split(img, count) {
    if (!img || (img.type !== 'png' && img.type !== 'jpeg')) return null;
    const el = await load(img);
    if (!el) return null;
    const W = el.naturalWidth, H = el.naturalHeight;
    if (W < 20 || H < 20 || W * H > 4e6) return null;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(el, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const ink = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      ink[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 < 150 ? 1 : 0;
    }

    // 1) Baris-baris tulisan (dua cara: celah ketat, dan celah kecil digabung untuk pangkat/akar)
    const rowP = new Array(H).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rowP[y] += ink[y * W + x];
    const tight = runs(rowP, 2).filter(b => b.b - b.a >= 3);
    const med = tight.map(b => b.b - b.a + 1).sort((a, b) => a - b)[Math.floor(tight.length / 2)] || 10;
    const loose = runs(rowP, Math.max(2, Math.round(med * 0.3))).filter(b => b.b - b.a >= 3);

    const colRuns = (band, x0 = 0, x1 = W - 1) => {
      const colP = new Array(W).fill(0);
      for (let y = band.a; y <= band.b; y++) for (let x = x0; x <= x1; x++) colP[x] += ink[y * W + x];
      return runs(colP, 1);
    };

    // 2) N baris terbawah = opsi berlabel; baris di atasnya (bila ada) = teks soal.
    const attempt = bands => {
      if (bands.length < count) return null;
      const opt = bands.slice(-count), top = bands.slice(0, -count);
      const hs = opt.map(b => b.b - b.a + 1);
      if (Math.max(...hs) > Math.min(...hs) * 2.5) return null;
      for (let k = 1; k < opt.length; k++) if (opt[k].a - opt[k - 1].b < 2) return null;
      const parts = [], labels = [];
      for (const band of opt) {
        const bh = band.b - band.a + 1;
        const cols = colRuns(band);
        if (cols.length < 2) return null;
        const gapMin = Math.max(2, Math.round(bh * 0.18));
        let cut = -1;
        for (let k = 1; k < cols.length; k++) {
          if (cols[k].a - cols[k - 1].b - 1 >= gapMin) { cut = k; break; }
        }
        if (cut < 0) return null;
        // Tanda baca kecil setelah huruf ("B" . "400") ikut dibuang bersama label.
        const inkHeight = run => {
          let top = -1, bottom = -1;
          for (let y = band.a; y <= band.b; y++) {
            for (let x = run.a; x <= run.b; x++) if (ink[y * W + x]) { if (top < 0) top = y; bottom = y; break; }
          }
          return top < 0 ? 0 : bottom - top + 1;
        };
        while (cut < cols.length - 1 && cols[cut].b - cols[cut].a + 1 <= bh * 0.35 && inkHeight(cols[cut]) <= bh * 0.35 &&
          cols[cut + 1].a - cols[cut].b - 1 >= 1) cut++;
        const labelW = cols[cut - 1].b - cols[0].a + 1;
        if (labelW > bh * 1.8) return null; // bukan label pendek seperti "A." / "(a)"
        labels.push({ x: cols[0].a, w: labelW, bh });
        const x0 = Math.max(0, cols[cut].a - 2), x1 = Math.min(W - 1, cols[cols.length - 1].b + 2);
        parts.push({ x0, y0: Math.max(0, band.a - 2), x1, y1: Math.min(H - 1, band.b + 2) });
      }
      // Label harus sejajar kiri dan selebar kurang lebih sama (A., B., C., ...)
      const avgH = labels.reduce((a, l) => a + l.bh, 0) / labels.length;
      const xs = labels.map(l => l.x), ws = labels.map(l => l.w);
      if (Math.max(...xs) - Math.min(...xs) > avgH * 0.6) return null;
      if (Math.max(...ws) > Math.min(...ws) * 1.8 + 2) return null;
      let stem = null;
      if (top.length) {
        if (opt[0].a - top[top.length - 1].b < 2) return null;
        let x0 = W, x1 = 0;
        for (const b of top) { const c = colRuns(b); if (c.length) { x0 = Math.min(x0, c[0].a); x1 = Math.max(x1, c[c.length - 1].b); } }
        stem = { x0: Math.max(0, x0 - 2), y0: Math.max(0, top[0].a - 2), x1: Math.min(W - 1, x1 + 2), y1: Math.min(H - 1, top[top.length - 1].b + 2) };
      }
      return { stem, parts };
    };
    const found = attempt(tight) || attempt(loose);
    if (!found) return null;

    // 3) Potong, ukuran tampil mengikuti skala gambar asli
    const twPerPx = (img.w || W * 15) / W;
    const crop = p => {
      const w = p.x1 - p.x0 + 1, h = p.y1 - p.y0 + 1;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, w, h);
      cx.drawImage(cv, p.x0, p.y0, w, h, 0, 0, w, h);
      return {
        type: 'png', b64: c.toDataURL('image/png').split(',')[1],
        pxW: w, pxH: h, w: Math.round(w * twPerPx), h: Math.round(h * twPerPx),
      };
    };
    return { stem: found.stem ? crop(found.stem) : null, options: found.parts.map(crop) };
  }

  root.OptionSplit = { split };
})(this);
