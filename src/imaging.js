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
