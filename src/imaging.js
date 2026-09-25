// Pixel work on RGBA arrays (ImageData.data), kept free of the DOM so the
// tests run it in Node. Used by uploadLogo (posters.js).

// The box that holds every visible pixel, or null when there is none. A crest
// cut from a web page usually comes with a transparent margin, which would
// shrink the badge inside its plaque; alpha at or under `min` counts as empty,
// so a faint fringe does not keep the margin.
export function opaqueBounds(data, w, h, min = 8) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] <= min) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// A gentle unsharp mask, in place: each colour moves away from a 3×3 blur of
// its neighbours by `amount`. The blur is weighted by alpha, so the colour
// of transparent pixels (often black) does not seep in as a dark halo round
// a shield; alpha itself is left alone.
export function unsharp(data, w, h, amount = 0.5) {
  const src = Uint8ClampedArray.from(data);
  const K = [1, 2, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!src[i + 3]) continue;
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const j = (yy * w + xx) * 4;
          const k = K[dy + 1] * K[dx + 1] * src[j + 3];
          r += src[j] * k; g += src[j + 1] * k; b += src[j + 2] * k; a += k;
        }
      }
      data[i] = src[i] + amount * (src[i] - r / a);
      data[i + 1] = src[i + 1] + amount * (src[i + 1] - g / a);
      data[i + 2] = src[i + 2] + amount * (src[i + 2] - b / a);
    }
  }
  return data;
}

// A flat background painted into an image that has none transparent — the
// green an AI model is asked for, a white page, or the grey-and-white
// checkerboard it draws when asked for transparency — turned transparent,
// in place. Only what touches the border and matches the border's colours
// goes: the white of letters inside a crest's ring stays. The border must
// be nearly all one or two colours, or nothing is touched (a photo, a crest
// cut to its edge). Edge pixels, part background, get partial alpha and the
// background's share taken out of their colour, so no green or white fringe
// is left round the badge. Returns whether a background was removed.
// Background within NEAR of the key; the flood goes on through pixels within
// FAR; one more ring within EDGE, where a crest's colour meets the key half
// way, is cleaned but not flooded through (EDGE is also alpha's full scale).
const KEY_NEAR = 60, KEY_FAR = 150, KEY_EDGE = 225;
export function keyBackground(data, w, h) {
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  if (border.some((p) => data[p * 4 + 3] < 250)) return false;   // already transparent
  const keys = borderKeys(data, border);
  if (!keys) return false;
  const dist = (p) => {
    let best = Infinity;
    for (const k of keys) {
      const d = Math.hypot(data[p * 4] - k[0], data[p * 4 + 1] - k[1], data[p * 4 + 2] - k[2]);
      if (d < best) best = d;
    }
    return best;
  };
  const nearest = (p) => keys.reduce((a, k) => (Math.hypot(data[p * 4] - k[0], data[p * 4 + 1] - k[1], data[p * 4 + 2] - k[2])
    < Math.hypot(data[p * 4] - a[0], data[p * 4 + 1] - a[1], data[p * 4 + 2] - a[2]) ? k : a));
  // Flood from the border: through background (1), and on into the fringe
  // (2) — pixels part background, reached only through more of the same.
  const seen = new Uint8Array(w * h);
  const stack = border.filter((p) => dist(p) < KEY_NEAR);
  for (const p of stack) seen[p] = 1;
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p - x) / w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (q < 0 || seen[q]) continue;
      const d = dist(q);
      if (d < KEY_NEAR) seen[q] = 1;
      else if (d < KEY_FAR) seen[q] = 2;
      else { if (d < KEY_EDGE) seen[q] = 2; continue; }
      stack.push(q);
    }
  }
  for (let p = 0; p < w * h; p++) {
    if (seen[p] === 1) { data[p * 4 + 3] = 0; continue; }
    if (seen[p] !== 2) continue;
    const a = Math.min(1, (dist(p) - KEY_NEAR) / (KEY_EDGE - KEY_NEAR));
    if (a < 0.05) { data[p * 4 + 3] = 0; continue; }
    const k = nearest(p);
    for (let c = 0; c < 3; c++) data[p * 4 + c] = Math.min(255, Math.max(0, Math.round((data[p * 4 + c] - (1 - a) * k[c]) / a)));
    data[p * 4 + 3] = Math.round(a * 255);
  }
  return true;
}

// The one or two colours a background border is made of, or null. Two for a
// checkerboard; a third colour means it is not a plain background.
function borderKeys(data, border) {
  const px = (p) => [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const median = (list) => [0, 1, 2].map((c) => list.map((v) => v[c]).sort((x, y) => x - y)[list.length >> 1]);
  const all = border.map(px);
  const covered = (keys) => all.filter((v) => keys.some((k) => d(v, k) < KEY_NEAR)).length / all.length;
  const one = median(all);
  if (covered([one]) >= 0.95) return [one];
  // Two colours: the one farthest from the first median seeds the second.
  const far = all.reduce((a, v) => (d(v, one) > d(a, one) ? v : a));
  const groups = [[], []];
  for (const v of all) groups[d(v, one) <= d(v, far) ? 0 : 1].push(v);
  // Only a checkerboard: two light greys, each a real share of the border.
  // Otherwise a crest touching the edge would pass as the second colour and
  // be flooded away.
  if (groups.some((g) => g.length < all.length / 4)) return null;
  const two = [median(groups[0]), median(groups[1])];
  const lightGrey = (c) => Math.min(...c) > 170 && Math.max(...c) - Math.min(...c) < 25;
  return two.every(lightGrey) && covered(two) >= 0.95 ? two : null;
}
