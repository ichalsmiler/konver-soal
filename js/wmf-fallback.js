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
   * Palet maks. 256 warna untuk gambar berwarna (agar DIB 4/8-bit, bukan 24-bit: 3-6x lebih kecil).
   * Bila warnanya <= 256 (diagram, grafik) dipakai persis; bila lebih (foto) diringkas dengan median cut.
   * @returns { palette: [[r,g,b]...], index: Uint8Array w*h }
   */
  function makePalette(rgb, w) {
    const n = rgb.length / 3;
    const exact = new Map();
    for (let i = 0; i < n && exact.size <= 256; i++) {
      const k = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
      if (!exact.has(k)) exact.set(k, exact.size);
    }
    const index = new Uint8Array(n);
    if (exact.size <= 256) {
      for (let i = 0; i < n; i++) index[i] = exact.get((rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2]);
      return { palette: Array.from(exact.keys(), k => [k >> 16, (k >> 8) & 255, k & 255]), index };
    }
    // Median cut pada histogram 5-5-5 bit.
    const key15 = i => ((rgb[i * 3] >> 3) << 10) | ((rgb[i * 3 + 1] >> 3) << 5) | (rgb[i * 3 + 2] >> 3);
    const hist = new Uint32Array(32768);
    for (let i = 0; i < n; i++) hist[key15(i)]++;
    const cells = [];
    for (let k = 0; k < 32768; k++) if (hist[k]) cells.push(k);
    const ch = (k, c) => (k >> (10 - c * 5)) & 31;
    let boxes = [cells];
    while (boxes.length < 256) {
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
    const palette = boxes.map(b => {
      let r = 0, g = 0, bl = 0, t = 0;
      for (const k of b) { const c = hist[k]; r += ch(k, 0) * c; g += ch(k, 1) * c; bl += ch(k, 2) * c; t += c; }
      return [r, g, bl].map(v => Math.min(255, Math.round((v / t) * 8 + 4)));
    });
    ditherInto(rgb, w, palette, index);
    return { palette, index };
  }

  // Floyd-Steinberg: sebar selisih warna ke piksel tetangga, agar gradasi foto tidak tampak bergaris.
  function ditherInto(rgb, w, palette, index) {
    const n = rgb.length / 3, h = n / w;
    const cache = new Int16Array(32768).fill(-1);
    const nearest = (r, g, b) => {
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (cache[k] >= 0) return cache[k];
      let best = 0, bd = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return (cache[k] = best);
    };
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
