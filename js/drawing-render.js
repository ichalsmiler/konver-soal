/*
 * Merender ilustrasi dari shape Word (DrawingML: grup, kotak, garis/panah, kotak teks,
 * kanvas) beserta baris label di sekitarnya menjadi satu gambar PNG.
 *
 * Scene (dibuat docx-reader):
 *   { anchor, behind, cx, cy, posH: {rel, off, align}, posV: {...}, bg, items: [...] }
 *   item shape: { kind:'shape', x, y, w, h, rot, flipH, flipV, geom, fill, line, text, ins, vAnchor }
 *   item pic:   { kind:'pic', x, y, w, h, img }
 * Satuan posisi EMU; ukuran paragraf dalam twips.
 */
(function (root) {
  'use strict';

  const EMU_PX = 9525;    // 1 px CSS (96 dpi) = 9525 EMU
  const TW_PX = 15;       // 1 px CSS = 15 twips
  const SCALE = 2;        // kerapatan piksel hasil
  const DEFAULT_FONT = '"Times New Roman", Times, serif';

  const ptPx = halfPts => (halfPts || 24) / 2 * 96 / 72;
  const fontCss = (s, defSz) => {
    const px = ptPx(s.sz || defSz) * ((s.sup || s.sub) ? 0.7 : 1);
    const fam = s.font ? '"' + s.font + '", ' + DEFAULT_FONT : DEFAULT_FONT;
    return (s.i ? 'italic ' : '') + (s.b ? 'bold ' : '') + px.toFixed(1) + 'px ' + fam;
  };

  function loadImg(img) {
    if (!img || (img.type !== 'png' && img.type !== 'jpeg')) return Promise.resolve(null);
    return new Promise(res => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => res(null);
      el.src = 'data:image/' + img.type + ';base64,' + img.b64;
    });
  }

  // ---------- Teks ----------
  // Menata satu paragraf (dengan tab): baris pertama mulai di x0, baris berikutnya di x1.
  // Tab berhenti di tabStops (px) atau kelipatan defTab dari tepi kiri (origin).
  function layoutRuns(ctx, segs, x0, x1, maxRight, defSz, tabStops, defTab, origin) {
    origin = origin || 0;
    const lines = [];
    let line = { items: [], h: 0, start: x0 };
    let x = x0;
    const push = () => { lines.push(line); line = { items: [], h: 0, start: x1 }; x = x1; };
    for (const s of segs) {
      if (s.img) continue;
      const parts = s.t.split(/(\t| +)/);
      for (const part of parts) {
        if (!part) continue;
        ctx.font = fontCss(s, defSz);
        if (part === '\t') {
          const rel = x - origin;
          const next = tabStops.find(t => t > rel + 1);
          const nx = origin + (next != null ? next : (Math.floor((rel + 0.5) / defTab) + 1) * defTab);
          // Seperti Word: tab yang melewati batas kanan menutup baris.
          if (nx > maxRight) push();
          else x = nx;
          continue;
        }
        const w = ctx.measureText(part).width;
        if (/^ +$/.test(part)) { x += w; continue; }
        // Kata yang tidak muat pindah ke baris berikutnya (spasi/tab sebelumnya tertinggal di baris ini).
        if (x + w > maxRight && x > line.start + 0.5) push();
        line.items.push({ s, text: part, x, w });
        line.h = Math.max(line.h, ptPx(s.sz || defSz));
        x += w;
      }
    }
    lines.push(line);
    return lines;
  }

  function drawText(ctx, items, baseline, defSz) {
    for (const it of items) {
      const s = it.s;
      ctx.font = fontCss(s, defSz);
      ctx.fillStyle = s.color || '#000';
      const px = ptPx(s.sz || defSz);
      const dy = s.sup ? -px * 0.35 : s.sub ? px * 0.2 : 0;
      ctx.fillText(it.text, it.x, baseline + dy);
      if (s.u) ctx.fillRect(it.x, baseline + 2, it.w, 1);
    }
  }

  function lineHeight(meta, fontPx) {
    if (meta.rule === 'exact') return meta.line / TW_PX;
    const single = fontPx * 1.15;
    if (meta.rule === 'atLeast') return Math.max(meta.line / TW_PX, single);
    return single * ((meta.line || 240) / 240);
  }

  // ---------- Shape ----------
  function pathFor(ctx, geom, w, h) {
    ctx.beginPath();
    const poly = pts => { pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h))); ctx.closePath(); };
    switch (geom) {
      case 'ellipse': case 'flowChartConnector':
        ctx.ellipse(w / 2, h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); break;
      case 'roundRect': case 'flowChartAlternateProcess': {
        const r = Math.min(Math.abs(w), Math.abs(h)) * 0.1667;
        ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath();
        break;
      }
      case 'triangle': case 'flowChartExtract': poly([[0.5, 0], [1, 1], [0, 1]]); break;
      case 'rtTriangle': poly([[0, 0], [1, 1], [0, 1]]); break;
      case 'diamond': case 'flowChartDecision': poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]); break;
      case 'parallelogram': case 'flowChartInputOutput': poly([[0.25, 0], [1, 0], [0.75, 1], [0, 1]]); break;
      case 'trapezoid': poly([[0.25, 0], [0.75, 0], [1, 1], [0, 1]]); break;
      case 'pentagon': poly([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]]); break;
      case 'hexagon': poly([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]); break;
      case 'octagon': poly([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]]); break;
      case 'rightArrow': poly([[0, 0.25], [0.7, 0.25], [0.7, 0], [1, 0.5], [0.7, 1], [0.7, 0.75], [0, 0.75]]); break;
      case 'leftArrow': poly([[1, 0.25], [0.3, 0.25], [0.3, 0], [0, 0.5], [0.3, 1], [0.3, 0.75], [1, 0.75]]); break;
      case 'upArrow': poly([[0.25, 1], [0.25, 0.3], [0, 0.3], [0.5, 0], [1, 0.3], [0.75, 0.3], [0.75, 1]]); break;
      case 'downArrow': poly([[0.25, 0], [0.25, 0.7], [0, 0.7], [0.5, 1], [1, 0.7], [0.75, 0.7], [0.75, 0]]); break;
      case 'leftRightArrow': poly([[0, 0.5], [0.2, 0], [0.2, 0.25], [0.8, 0.25], [0.8, 0], [1, 0.5], [0.8, 1], [0.8, 0.75], [0.2, 0.75], [0.2, 1]]); break;
      case 'upDownArrow': poly([[0.5, 0], [1, 0.2], [0.75, 0.2], [0.75, 0.8], [1, 0.8], [0.5, 1], [0, 0.8], [0.25, 0.8], [0.25, 0.2], [0, 0.2]]); break;
      case 'chevron': poly([[0, 0], [0.7, 0], [1, 0.5], [0.7, 1], [0, 1], [0.3, 0.5]]); break;
      case 'plus': poly([[0.33, 0], [0.67, 0], [0.67, 0.33], [1, 0.33], [1, 0.67], [0.67, 0.67], [0.67, 1], [0.33, 1], [0.33, 0.67], [0, 0.67], [0, 0.33], [0.33, 0.33]]); break;
      case 'star5': {
        const pts = [];
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.19 : 0.5;
          pts.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a) * 1.05]);
        }
        poly(pts);
        break;
      }
      case 'can': case 'flowChartMagneticDisk': {
        const ry = Math.abs(h) * 0.12;
        ctx.ellipse(w / 2, ry, w / 2, ry, 0, Math.PI, 0); ctx.lineTo(w, h - ry);
        ctx.ellipse(w / 2, h - ry, w / 2, ry, 0, 0, Math.PI); ctx.closePath();
        ctx.moveTo(0, ry); ctx.ellipse(w / 2, ry, w / 2, ry, 0, Math.PI, 3 * Math.PI, true);
        break;
      }
      default: ctx.rect(0, 0, w, h);
    }
  }

  const LINE_GEOMS = /^(line|straightConnector1|bentConnector\d|curvedConnector\d|lineInv)$/;

  function arrowHead(ctx, x, y, angle, size, type) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    if (type === 'oval') { ctx.arc(-size / 2, 0, size / 2, 0, Math.PI * 2); ctx.fill(); }
    else if (type === 'diamond') { ctx.moveTo(0, 0); ctx.lineTo(-size / 2, -size / 3); ctx.lineTo(-size, 0); ctx.lineTo(-size / 2, size / 3); ctx.closePath(); ctx.fill(); }
    else if (type === 'arrow') { ctx.moveTo(-size, -size / 2.2); ctx.lineTo(0, 0); ctx.lineTo(-size, size / 2.2); ctx.stroke(); }
    else { ctx.moveTo(0, 0); ctx.lineTo(-size, -size / 2.2); ctx.lineTo(-size * (type === 'stealth' ? 0.7 : 1), 0); ctx.lineTo(-size, size / 2.2); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }

  function applyLine(ctx, line) {
    ctx.strokeStyle = line.color;
    ctx.fillStyle = line.color;
    ctx.lineWidth = Math.max(0.75, (line.w || 9525) / EMU_PX);
    const lw = ctx.lineWidth;
    const dash = { dash: [4, 3], sysDash: [3, 1], dot: [1, 2], sysDot: [1, 1], dashDot: [4, 2, 1, 2], lgDash: [8, 3], lgDashDot: [8, 3, 1, 3], sysDashDot: [3, 1, 1, 1] }[line.dash];
    ctx.setLineDash(dash ? dash.map(d => d * lw) : []);
  }

  function drawShape(ctx, sh, ox, oy, defSz) {
    const x = ox + sh.x / EMU_PX, y = oy + sh.y / EMU_PX, w = sh.w / EMU_PX, h = sh.h / EMU_PX;
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    if (sh.rot) ctx.rotate(sh.rot * Math.PI / 180);
    ctx.scale(sh.flipH ? -1 : 1, sh.flipV ? -1 : 1);
    ctx.translate(-w / 2, -h / 2);

    if (LINE_GEOMS.test(sh.geom)) {
      if (sh.line) {
        applyLine(ctx, sh.line);
        ctx.beginPath();
        let pts;
        if (/^bentConnector/.test(sh.geom)) pts = [[0, 0], [w / 2, 0], [w / 2, h], [w, h]];
        else if (sh.geom === 'lineInv') pts = [[0, h], [w, 0]];
        else pts = [[0, 0], [w, h]];
        pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.stroke();
        ctx.setLineDash([]);
        const size = Math.max(6, ctx.lineWidth * 4);
        const sz = k => size * ({ sm: 0.7, med: 1, lg: 1.4 }[k] || 1);
        if (sh.line.head && sh.line.head.type !== 'none') {
          const [a, b] = [pts[1], pts[0]];
          arrowHead(ctx, b[0], b[1], Math.atan2(b[1] - a[1], b[0] - a[0]), sz(sh.line.head.len), sh.line.head.type);
        }
        if (sh.line.tail && sh.line.tail.type !== 'none') {
          const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
          arrowHead(ctx, b[0], b[1], Math.atan2(b[1] - a[1], b[0] - a[0]), sz(sh.line.tail.len), sh.line.tail.type);
        }
      }
    } else {
      pathFor(ctx, sh.geom, w, h);
      if (sh.fill) { ctx.fillStyle = sh.fill; ctx.fill(); }
      if (sh.line) { applyLine(ctx, sh.line); ctx.stroke(); ctx.setLineDash([]); }
    }
    ctx.restore();

    if (sh.text && sh.text.length) drawBoxText(ctx, sh, x, y, w, h, defSz);
  }

  function drawBoxText(ctx, sh, x, y, w, h, defSz) {
    const ins = sh.ins || { l: 91440, t: 45720, r: 91440, b: 45720 };
    const left = x + ins.l / EMU_PX, right = x + w - ins.r / EMU_PX;
    const laid = [];
    let total = 0;
    for (const p of sh.text) {
      const ind = (p.indLeft || 0) / TW_PX, first = (p.firstLine || 0) / TW_PX;
      const lines = layoutRuns(ctx, p.segs, left + ind + first, left + ind, right, p.sz || defSz,
        (p.tabs || []).map(t => t / TW_PX), 48, left);
      for (const ln of lines) {
        const lh = Math.max(ln.h, ptPx(p.sz || defSz)) * 1.15;
        if ((p.jc === 'center' || p.jc === 'right') && ln.items.length) {
          const start = ln.items[0].x;
          const last = ln.items[ln.items.length - 1];
          const contentW = last.x + last.w - start;
          const target = p.jc === 'center' ? left + (right - left - contentW) / 2 : right - contentW;
          ln.items.forEach(it => { it.x += target - start; });
        }
        laid.push({ ln, lh, sz: p.sz || defSz });
        total += lh;
      }
    }
    let ty = y + ins.t / EMU_PX;
    const avail = h - (ins.t + ins.b) / EMU_PX;
    if (sh.vAnchor === 'ctr') ty += Math.max(0, (avail - total) / 2);
    else if (sh.vAnchor === 'b') ty += Math.max(0, avail - total);
    for (const { ln, lh, sz } of laid) {
      drawText(ctx, ln.items, ty + lh * 0.8, sz);
      ty += lh;
    }
  }

  async function drawScene(ctx, scene, ox, oy, defSz) {
    if (scene.bg) { ctx.fillStyle = scene.bg; ctx.fillRect(ox, oy, scene.cx / EMU_PX, scene.cy / EMU_PX); }
    for (const it of scene.items) {
      if (it.kind === 'pic') {
        const el = await loadImg(it.img);
        if (el) ctx.drawImage(el, ox + it.x / EMU_PX, oy + it.y / EMU_PX, it.w / EMU_PX, it.h / EMU_PX);
      } else drawShape(ctx, it, ox, oy, defSz);
    }
  }

  // ---------- Hasil gambar ----------
  function cropBox(canvas) {
    const { width: W, height: H } = canvas;
    const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, color = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r < 250 || g < 250 || b < 250) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (!color && (Math.abs(r - g) > 24 || Math.abs(g - b) > 24 || Math.abs(r - b) > 24)) color = true;
        }
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1, color };
  }

  async function finish(canvas) {
    const box = cropBox(canvas);
    if (!box) return null;
    const pad = 4 * SCALE;
    const sx = Math.max(0, box.x0 - pad), sy = Math.max(0, box.y0 - pad);
    const w = Math.min(canvas.width, box.x1 + pad + 1) - sx, h = Math.min(canvas.height, box.y1 + pad + 1) - sy;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(canvas, sx, sy, w, h, 0, 0, w, h);
    let b64 = null;
    if (!box.color && root.TableImage && root.TableImage.encodeGray4) b64 = await root.TableImage.encodeGray4(out).catch(() => null);
    if (!b64) b64 = out.toDataURL('image/png').split(',')[1];
    return { type: 'png', b64, pxW: w, pxH: h, w: Math.round(w / SCALE * TW_PX), h: Math.round(h / SCALE * TW_PX) };
  }

  function newCanvas(wPx, hPx) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(wPx * SCALE);
    c.height = Math.ceil(hPx * SCALE);
    const ctx = c.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, wPx, hPx);
    ctx.textBaseline = 'alphabetic';
    return { c, ctx };
  }

  /** Satu scene saja (shape inline atau di dalam tabel). */
  async function renderScene(scene, defSz) {
    const { c, ctx } = newCanvas(scene.cx / EMU_PX + 8, scene.cy / EMU_PX + 8);
    await drawScene(ctx, scene, 4, 4, defSz || 24);
    return finish(c);
  }

  /**
   * Blok ilustrasi: beberapa paragraf (label teks + paragraf jangkar shape).
   * block = { page: {textW, marginL, defTab}, paras: [{ lines: [segs], meta, draw, floats: [scene] }] }
   */
  async function renderBlock(block) {
    const page = block.page;
    const textW = page.textW / TW_PX;
    const defTab = (page.defTab || 720) / TW_PX;
    const measure = document.createElement('canvas').getContext('2d');

    // 1) Tata letak paragraf
    let y = 0;
    const textOps = [], floats = [];
    for (const p of block.paras) {
      const m = p.meta;
      y += (m.before || 0) / TW_PX;
      const top = y;
      for (const s of p.floats) floats.push({ scene: s, top, m });
      const tabs = (m.tabs || []).map(t => t / TW_PX);
      p.lines.forEach((segs, li) => {
        const x1 = (m.indLeft || 0) / TW_PX;
        const x0 = x1 + (li === 0 ? (m.firstLine || 0) / TW_PX : 0);
        const laid = layoutRuns(measure, segs, x0, x1, textW, m.sz, tabs, defTab, 0);
        for (const ln of laid) {
          const fontPx = Math.max(ln.h, ptPx(m.sz));
          const lh = lineHeight(m, fontPx);
          if (p.draw && ln.items.length) {
            if (m.jc === 'center' || m.jc === 'right') {
              const start = ln.items[0].x, last = ln.items[ln.items.length - 1];
              const contentW = last.x + last.w - start;
              const target = m.jc === 'center' ? x1 + (textW - x1 - contentW) / 2 : textW - contentW;
              ln.items.forEach(it => { it.x += target - start; });
            }
            textOps.push({ items: ln.items, baseline: y + lh * 0.8, sz: m.sz });
          }
          y += lh;
        }
      });
      y += (m.after || 0) / TW_PX;
    }

    // 2) Posisi shape mengambang
    const place = (pos, size, base, span, marginPx) => {
      if (!pos) return base;
      if (pos.align) {
        if (pos.align === 'center') return base + (span - size) / 2;
        if (pos.align === 'right' || pos.align === 'bottom') return base + span - size;
        return base;
      }
      const off = (pos.off || 0) / EMU_PX;
      if (pos.rel === 'page') return off - marginPx;
      return base + off;
    };
    let maxX = textW, maxY = y;
    for (const f of floats) {
      const s = f.scene;
      const w = s.cx / EMU_PX, h = s.cy / EMU_PX;
      f.x = place(s.posH, w, (s.posH && s.posH.rel === 'character') ? (f.m.indLeft || 0) / TW_PX : 0, textW, (page.marginL || 1440) / TW_PX);
      // Posisi relatif paragraf/baris dihitung tepat; relatif halaman/margin tidak diketahui
      // di potongan ini, jadi diletakkan di atas paragraf jangkarnya.
      const relPara = s.posV && /^(paragraph|line)$/.test(s.posV.rel);
      f.y = relPara ? place(s.posV, h, f.top, h, 0) : f.top;
      maxX = Math.max(maxX, f.x + w);
      maxY = Math.max(maxY, f.y + h);
    }

    // 3) Gambar: shape di belakang, teks, shape di depan
    const minX = Math.min(0, ...floats.map(f => f.x));
    const minY = Math.min(0, ...floats.map(f => f.y));
    const { c, ctx } = newCanvas(maxX - minX + 8, maxY - minY + 8);
    ctx.translate(4 - minX, 4 - minY);
    for (const f of floats) if (f.scene.behind) await drawScene(ctx, f.scene, f.x, f.y, f.m.sz);
    for (const op of textOps) drawText(ctx, op.items, op.baseline, op.sz);
    for (const f of floats) if (!f.scene.behind) await drawScene(ctx, f.scene, f.x, f.y, f.m.sz);
    return finish(c);
  }

  root.DrawingRender = { renderBlock, renderScene };
})(this);
