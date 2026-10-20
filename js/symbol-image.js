/*
 * Simbol yang tidak terbaca oleh pengimpor ujian (ExamView/Moodle mengubah setiap \uN
 * menjadi "?"), mis. ⇌ ⅔ ≤ α √ atau tulisan Arab, digambar menjadi PNG kecil (grayscale)
 * seukuran teks. Garis dasar gambar disejajarkan dengan teks lewat `depth`, sama seperti
 * persamaan OMML.
 */
(function (root) {
  'use strict';

  const SCALE = 4;  // kerapatan piksel (simbol kecil perlu tajam)
  const TW_PX = 15; // twips per piksel CSS
  const FALLBACK_FONTS = '"Cambria Math", "Segoe UI Symbol", "Segoe UI", "Noto Sans Math", "Noto Naskh Arabic", serif';
  const cache = new Map();

  /**
   * text -> { type:'png', b64, pxW, pxH, w, h (twips), depth (twips di bawah garis dasar), fromMath }
   * atau null bila tidak bisa digambar. opt: { font, size (pt), b, i, sup, sub }
   */
  function render(text, opt) {
    if (typeof document === 'undefined') return Promise.resolve(null);
    opt = opt || {};
    const key = [text, opt.font, opt.size, !!opt.b, !!opt.i, !!opt.sup, !!opt.sub].join('|');
    if (!cache.has(key)) cache.set(key, draw(text, opt).catch(() => null));
    return cache.get(key);
  }

  async function draw(text, opt) {
    const size = opt.size || 12;
    const emPx = size * 4 / 3 * SCALE; // pt -> px CSS (96/72), dikali kerapatan
    const px = emPx * (opt.sup || opt.sub ? 0.65 : 1);
    const family = (opt.font ? '"' + opt.font.replace(/"/g, '') + '", ' : '') + FALLBACK_FONTS;
    const font = (opt.i ? 'italic ' : '') + (opt.b ? 'bold ' : '') + px.toFixed(1) + 'px ' + family;

    const c = document.createElement('canvas');
    let ctx = c.getContext('2d');
    ctx.font = font;
    const m = ctx.measureText(text);
    const asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
    const left = Math.ceil(m.actualBoundingBoxLeft), right = Math.ceil(m.actualBoundingBoxRight);
    if (!(asc + desc > 0) || !(left + right > 0)) return null;

    // Lebar mengikuti lebar huruf (agar jarak dengan teks di sekitarnya wajar), tinggi mengikuti tinta.
    const pad = SCALE;
    const x0 = Math.min(0, -left), x1 = Math.max(m.width, right);
    let W = Math.ceil(x1 - x0) + 2 * pad, H = asc + desc + 2 * pad;
    W += W % 2; H += H % 2;
    c.width = W; c.height = H;
    ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, pad - x0, pad + asc);

    let b64 = null;
    if (root.TableImage && root.TableImage.encodeGray4) b64 = await root.TableImage.encodeGray4(c).catch(() => null);
    if (!b64) b64 = c.toDataURL('image/png').split(',')[1];

    const below = H - pad - asc; // piksel di bawah garis dasar
    const shift = opt.sup ? -0.35 * emPx : opt.sub ? 0.15 * emPx : 0;
    const tw = v => Math.round(v / SCALE * TW_PX);
    return { type: 'png', b64, pxW: W, pxH: H, w: tw(W), h: tw(H), depth: tw(below + shift), fromMath: true, symbol: text };
  }

  root.SymbolImage = { render };
})(this);
