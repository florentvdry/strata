// Squarified treemap layout (Bruls, Huizing & van Wijk).
// `values` must be sorted biggest first. Returns [x, y, w, h] per value.
export function squarify(values, x, y, w, h) {
  const out = new Array(values.length);
  let total = 0;
  for (const v of values) total += v;
  if (total <= 0 || w <= 0 || h <= 0) {
    for (let i = 0; i < values.length; i++) out[i] = [x, y, 0, 0];
    return out;
  }
  const scale = (w * h) / total;
  let i = 0;
  while (i < values.length) {
    const side = Math.min(w, h);
    let rowSum = 0, rowMin = Infinity, rowMax = 0, best = Infinity, j = i;
    while (j < values.length) {
      const a = values[j] * scale;
      const s = rowSum + a, mn = Math.min(rowMin, a), mx = Math.max(rowMax, a);
      const worst = Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
      if (worst > best && j > i) break;
      best = worst; rowSum = s; rowMin = mn; rowMax = mx; j++;
    }
    if (w >= h) {
      const rw = rowSum / h;
      let cy = y;
      for (let k = i; k < j; k++) {
        const ih = (values[k] * scale) / rw;
        out[k] = [x, cy, rw, ih];
        cy += ih;
      }
      x += rw; w -= rw;
    } else {
      const rh = rowSum / w;
      let cx = x;
      for (let k = i; k < j; k++) {
        const iw = (values[k] * scale) / rh;
        out[k] = [cx, y, iw, rh];
        cx += iw;
      }
      y += rh; h -= rh;
    }
    i = j;
  }
  return out;
}
