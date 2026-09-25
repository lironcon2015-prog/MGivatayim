// Builds the app icons (icons/*.png, favicon.ico) and icons/icon-source.svg
// from assets/crest.png.   node tools/make-icons.mjs   — needs playwright
//
// The owner asked for the home-screen icon to be the crest as the header
// shows it (.crest in styles.css): a ring from gold to blue round the
// crest, with a gold and a blue glow, on the app's navy. The SVG is drawn
// here with the same colours and proportions, scaled from the header's 54px,
// and rendered by Chromium, so the icon and the header are one picture.
// The ring takes the middle 64%: Android crops a maskable icon to a circle
// of 80%. Favicons drop the glow and fill the square — at 16px a margin is
// all a glow would leave.
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const crest = readFileSync(new URL('assets/crest.png', ROOT)).toString('base64');

// .crest: 54px, 3px ring, gradient 145deg gold-hi → blue-lo,
// box-shadow 0 0 24px gold .32, 0 0 42px blue .24; the img on --bg.
function svg({ share = 0.64, glow = true, href = `data:image/png;base64,${crest}` } = {}) {
  const S = 1024, D = S * share, k = D / 54, r = D / 2, c = S / 2, ring = 3 * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <linearGradient id="ring" x1="0.21" y1="0.09" x2="0.79" y2="0.91">
      <stop offset="0" stop-color="#F2CB55"/><stop offset="1" stop-color="#4A8FE8"/>
    </linearGradient>
    <radialGradient id="sky" cx="0.8" cy="0" r="1.1">
      <stop offset="0" stop-color="#468AEC" stop-opacity=".36"/><stop offset=".75" stop-color="#468AEC" stop-opacity="0"/>
    </radialGradient>
    <filter id="g1" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="${12 * k}"/></filter>
    <filter id="g2" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="${21 * k}"/></filter>
    <clipPath id="in"><circle cx="${c}" cy="${c}" r="${r - ring}"/></clipPath>
  </defs>
  ${glow ? `<rect width="${S}" height="${S}" fill="#0A1321"/><rect width="${S}" height="${S}" fill="url(#sky)"/>
  <circle cx="${c}" cy="${c}" r="${r}" fill="#4A8FE8" fill-opacity=".24" filter="url(#g2)"/>
  <circle cx="${c}" cy="${c}" r="${r}" fill="#E8B931" fill-opacity=".32" filter="url(#g1)"/>` : ''}
  <circle cx="${c}" cy="${c}" r="${r}" fill="url(#ring)"/>
  <circle cx="${c}" cy="${c}" r="${r - ring}" fill="#0A1321"/>
  <image href="${href}" x="${c - r + ring}" y="${c - r + ring}" width="${D - 2 * ring}" height="${D - 2 * ring}" clip-path="url(#in)"/>
</svg>`;
}

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
async function render(size, opts, transparent = false) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(opts).replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body>`);
  return page.screenshot({ omitBackground: transparent });
}

const out = (name, buf) => writeFileSync(new URL(`icons/${name}`, ROOT), buf);
for (const [name, size] of [['icon-1024.png', 1024], ['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  out(name, await render(size, {}));
}
const fav = { share: 1, glow: false };
out('favicon-32.png', await render(32, fav, true));
out('favicon-16.png', await render(16, fav, true));
// favicon.ico: one 32px PNG inside the ICO header.
const png = await render(32, fav, true);
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head.writeUInt8(32, 6); head.writeUInt8(32, 7); head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
out('favicon.ico', Buffer.concat([head, png]));
// The readable source, pointing at the crest instead of embedding it.
out('icon-source.svg', svg({ href: '../assets/crest.png' }) + '\n');
await browser.close();
