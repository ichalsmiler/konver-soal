/*
 * Membuat WMF (Windows Metafile) berisi bitmap, persis seperti cadangan gambar yang
 * ditulis Microsoft Word di RTF ({\nonshppict{\pict\wmetafile8 ...}}).
 * Pembaca RTF lama (mis. ExamView) hanya mengenali gambar WMF ini, bukan PNG/JPEG.
 *
 * Isi: SETMAPMODE, SETWINDOWORG/EXT, SAVEDC, SETSTRETCHBLTMODE, DIBSTRETCHBLT, RESTOREDC, EOF.
 * Tanpa header "placeable" (tidak boleh ada di dalam RTF).
 * Gambar abu-abu memakai DIB 4-bit 16 tingkat abu-abu (seperti Word). Gambar berwarna memakai DIB
 * berpalet: 4-bit bila <= 16 warna, selain itu 8-bit (256 warna; foto diringkas dengan median cut).
 * Dulu DIB 24-bit tanpa palet: 3-6x lebih besar, membuat RTF soal bergambar berukuran belasan MB.
 */
(function (root) {
  'use strict';

  /** true bila semua piksel (praktis) abu-abu. */
  function isGray(rgba) {
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12 || Math.abs(r - b) > 12) return false;
    }
    return true;
  }

  /**
   * @param w, h  ukuran piksel
   * @param rgba  Uint8(Clamped)Array w*h*4 (RGBA, baris dari atas); transparan dianggap putih
   * @returns Uint8Array berisi WMF
   */
  /** Gabungkan RGBA dengan latar putih -> RGB (Uint8Array w*h*3). */
  function flatten(rgba) {
    const n = rgba.length / 4, rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = rgba[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgba[i * 4 + c] * a + 255 * (1 - a));
    }
    return rgb;
  }

  /**
   * Palet untuk gambar berwarna (DIB 4/8-bit, bukan 24-bit):
   *  - <= 16 warna: warna persis, 4-bit
   *  - diagram/grafik (16 warna terbanyak menutup >= 70% piksel; sisanya warna peralihan di tepi
   *    garis/huruf): 16 warna terbanyak, 4-bit
   *  - foto (warna tersebar; pada soal Fisika XII 16 warna terbanyak hanya ±25%):
   *    diringkas ke 256 warna dengan dithering, 8-bit
   * @returns { palette: [[r,g,b]...], index: Uint8Array w*h }
   */
  function makePalette(rgb, w) {
    const n = rgb.length / 3;
    const count = new Map();
    for (let i = 0; i < n; i++) {
      const k = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
      count.set(k, (count.get(k) || 0) + 1);
    }
    const index = new Uint8Array(n);
    if (count.size <= 16) {
      const pos = new Map(Array.from(count.keys(), (k, i) => [k, i]));
      for (let i = 0; i < n; i++) index[i] = pos.get((rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2]);
      return { palette: Array.from(count.keys(), k => [k >> 16, (k >> 8) & 255, k & 255]), index };
    }
    const popular = Array.from(count.entries()).sort((a, b) => b[1] - a[1]).slice(0, 16);
    const top16 = popular.reduce((a, e) => a + e[1], 0);
    if (top16 / n < 0.7) {
      // Foto
      const palette = medianCut(rgb, 256);
      ditherInto(rgb, w, palette, index);
      return { palette, index };
    }
    // Diagram: warna utama (latar + tinta yang benar-benar berbeda) ditambah warna peralihan
    // latar->tinta, seperti 16 tingkat abu-abu Word, agar tepi huruf/garis tetap halus.
    const palette = diagramPalette(count);
    const near = nearestFn(palette);
    for (let i = 0; i < n; i++) index[i] = near(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    return { palette, index };
  }

  /** 16 warna untuk diagram: latar, s.d. 5 tinta berbeda, dan peralihan latar->tinta. */
  function diagramPalette(count) {
    const rgbOf = k => [k >> 16, (k >> 8) & 255, k & 255];
    const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const sorted = Array.from(count.entries()).sort((a, b) => b[1] - a[1]).map(e => rgbOf(e[0]));
    const inks = [];
    for (const c of sorted) {
      if (inks.length >= 5) break;
      if (inks.every(p => dist(p, c) >= 80 * 80)) inks.push(c);
    }
    const bg = inks[0], palette = inks.slice();
    const others = inks.slice(1);
    if (others.length) {
      const steps = Math.min(4, Math.floor((16 - inks.length) / others.length));
      for (const ink of others) {
        for (let s = 1; s <= steps; s++) {
          const t = s / (steps + 1);
          palette.push(bg.map((v, c) => Math.round(v + (ink[c] - v) * t)));
        }
      }
    }
    // Sisa slot: warna yang sering muncul berikutnya dan belum terwakili.
    for (const c of sorted) {
      if (palette.length >= 16) break;
      if (palette.every(p => dist(p, c) >= 24 * 24)) palette.push(c);
    }
    return palette;
  }

  /** Median cut pada histogram 5-5-5 bit; warna palet = rata-rata piksel asli di tiap kotak. */
  function medianCut(rgb, maxColors) {
    const n = rgb.length / 3;
    const key15 = i => ((rgb[i * 3] >> 3) << 10) | ((rgb[i * 3 + 1] >> 3) << 5) | (rgb[i * 3 + 2] >> 3);
    const hist = new Uint32Array(32768);
    for (let i = 0; i < n; i++) hist[key15(i)]++;
    const cells = [];
    for (let k = 0; k < 32768; k++) if (hist[k]) cells.push(k);
    const ch = (k, c) => (k >> (10 - c * 5)) & 31;
    let boxes = [cells];
    while (boxes.length < maxColors) {
      // Belah kotak dengan rentang warna terlebar.
      let best = -1, bestRange = 0, bestCh = 0;
      boxes.forEach((b, bi) => {
        if (b.length < 2) return;
        for (let c = 0; c < 3; c++) {
          let lo = 31, hi = 0;
          for (const k of b) { const v = ch(k, c); if (v < lo) lo = v; if (v > hi) hi = v; }
          if (hi - lo > bestRange) { bestRange = hi - lo; best = bi; bestCh = c; }
        }
      });
      if (best < 0) break;
      const b = boxes[best].sort((x, y) => ch(x, bestCh) - ch(y, bestCh));
      const total = b.reduce((s, k) => s + hist[k], 0);
      let acc = 0, cut = 1;
      for (; cut < b.length - 1; cut++) { acc += hist[b[cut - 1]]; if (acc >= total / 2) break; }
      boxes.splice(best, 1, b.slice(0, cut), b.slice(cut));
    }
    const box = new Uint16Array(32768);
    boxes.forEach((b, bi) => { for (const k of b) box[k] = bi; });
    const sum = boxes.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sum[box[key15(i)]];
      s[0] += rgb[i * 3]; s[1] += rgb[i * 3 + 1]; s[2] += rgb[i * 3 + 2]; s[3]++;
    }
    return sum.map(s => [0, 1, 2].map(c => Math.round(s[c] / s[3])));
  }

  /** Cari warna palet terdekat (di-cache per warna 15-bit). */
  function nearestFn(palette) {
    const cache = new Int16Array(32768).fill(-1);
    return (r, g, b) => {
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (cache[k] >= 0) return cache[k];
      let best = 0, bd = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return (cache[k] = best);
    };
  }

  // Floyd-Steinberg: sebar selisih warna ke piksel tetangga, agar gradasi foto tidak tampak bergaris.
  function ditherInto(rgb, w, palette, index) {
    const n = rgb.length / 3, h = n / w;
    const nearest = nearestFn(palette);
    let cur = new Float32Array(w * 3), next = new Float32Array(w * 3);
    const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let y = 0; y < h; y++) {
      next.fill(0);
      for (let x = 0; x < w; x++) {
        const i = y * w + x, e = [];
        const c = [0, 1, 2].map(k => clamp(rgb[i * 3 + k] + cur[x * 3 + k]));
        const pi = nearest(c[0] | 0, c[1] | 0, c[2] | 0);
        index[i] = pi;
        for (let k = 0; k < 3; k++) e[k] = c[k] - palette[pi][k];
        for (let k = 0; k < 3; k++) {
          if (x + 1 < w) cur[(x + 1) * 3 + k] += e[k] * 7 / 16;
          if (x > 0) next[(x - 1) * 3 + k] += e[k] * 3 / 16;
          next[x * 3 + k] += e[k] * 5 / 16;
          if (x + 1 < w) next[(x + 1) * 3 + k] += e[k] / 16;
        }
      }
      const t = cur; cur = next; next = t;
    }
  }

  function fromRgba(w, h, rgba) {
    const gray = isGray(rgba);
    const rgb = flatten(rgba);
    // Abu-abu: 16 tingkat abu-abu 4-bit (seperti Word). Berwarna: palet 4-bit (<=16 warna) atau 8-bit.
    const pal = gray ? null : makePalette(rgb, w);
    const bpp = gray || pal.palette.length <= 16 ? 4 : 8;
    const colors = gray ? 16 : pal.palette.length;
    const rowLen = Math.ceil((w * bpp) / 32) * 4;
    const paletteSize = colors * 4;
    const dibSize = 40 + paletteSize + rowLen * h;

    const out = new Uint8Array(18 + 10 + 10 + 14 + 6 + 8 + (26 + dibSize) + 8 + 6 + 64);
    let p = 0;
    const u16 = v => { out[p++] = v & 0xFF; out[p++] = (v >> 8) & 0xFF; };
    const u32 = v => { out[p++] = v & 0xFF; out[p++] = (v >>> 8) & 0xFF; out[p++] = (v >>> 16) & 0xFF; out[p++] = (v >>> 24) & 0xFF; };

    const recs = [
      [0x0103, [8]],          // SETMAPMODE MM_ANISOTROPIC
      [0x020B, [0, 0]],       // SETWINDOWORG (y, x)
      [0x020C, [h, w]],       // SETWINDOWEXT (y, x)
      [0x001E, []],           // SAVEDC
      [0x0107, [4]],          // SETSTRETCHBLTMODE HALFTONE
      [0x0B41, null],         // DIBSTRETCHBLT + DIB
      [0x0127, [0xFFFF]],     // RESTOREDC -1
      [0x0000, []],           // EOF
    ];
    const words = r => 3 + (r[1] ? r[1].length : 10 + dibSize / 2);
    const total = 9 + recs.reduce((n, r) => n + words(r), 0);

    // METAHEADER
    u16(1); u16(9); u16(0x0300); u32(total); u16(0); u32(Math.max(...recs.map(words))); u16(0);

    for (const r of recs) {
      u32(words(r)); u16(r[0]);
      if (r[1]) { r[1].forEach(u16); continue; }
      // DIBSTRETCHBLT: ROP SRCCOPY, srcH, srcW, ySrc, xSrc, destH, destW, yDst, xDst
      u32(0x00CC0020); u16(h); u16(w); u16(0); u16(0); u16(h); u16(w); u16(0); u16(0);
      // BITMAPINFOHEADER
      u32(40); u32(w); u32(h); u16(1); u16(bpp); u32(0); u32(rowLen * h); u32(0); u32(0);
      u32(colors); u32(0);
      // Palet: urutan B, G, R, 0
      if (gray) for (let k = 0; k < 16; k++) { const v = k * 17; out[p++] = v; out[p++] = v; out[p++] = v; out[p++] = 0; }
      else pal.palette.forEach(([r, g, b]) => { out[p++] = b; out[p++] = g; out[p++] = r; out[p++] = 0; });
      const start = p;
      out.fill(0, start, start + rowLen * h);
      for (let y = 0; y < h; y++) {
        const row = start + (h - 1 - y) * rowLen; // baris dari bawah
        for (let x = 0; x < w; x++) {
          const s = y * w + x;
          const v = gray
            ? Math.round(((rgb[s * 3] * 299 + rgb[s * 3 + 1] * 587 + rgb[s * 3 + 2] * 114) / 1000) / 17)
            : pal.index[s];
          if (bpp === 8) out[row + x] = v;
          else { const i = row + (x >> 1); out[i] = x & 1 ? (out[i] & 0xF0) | v : (out[i] & 0x0F) | (v << 4); }
        }
      }
      p = start + rowLen * h;
    }
    return out.subarray(0, p);
  }

  function toBase64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  const api = { fromRgba, toBase64, isGray };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WmfFallback = api;
})(this);
