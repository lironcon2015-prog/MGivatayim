// Builds the guides' link previews (docs/og-parent.jpg, docs/og-coach.jpg,
// 1200×630 — what WhatsApp shows for the link) from assets/crest.png.
//   node tools/make-og.mjs   — needs playwright, and Google Fonts reachable
//
// The crest sits in the header's element (.crest in styles.css: a ring from
// gold to blue with a gold and a blue glow); beside it the guide's name on
// the app's navy. A new crest → run this, and bump ?v= on og:image in both
// guides: WhatsApp keeps a preview by its URL.
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const crest = `data:image/png;base64,${readFileSync(new URL('assets/crest.png', ROOT)).toString('base64')}`;
const GUIDES = [
  { file: 'og-parent.jpg', title: 'מדריך להורים', sub: 'המשחק הבא, תוצאות, משחק חי ותיעוד משחק' },
  { file: 'og-coach.jpg', title: 'מדריך למאמן', sub: 'התקנה, מה יש באפליקציה, וניהול דקות המשחק' },
];

// .crest at 54px: 3px ring, 24px gold and 42px blue glow — here at 300px.
// The glows are radial gradients, not box-shadow: Chromium cuts a shadow
// blurred this far to a rectangle. The crest's centre: 90px padding, 300px.
const K = 300 / 54, CX = 1200 - 90 - 150, CY = 315;
// A blur fades faster than a linear gradient: its reach is taken at 60%.
const glow = (rgba, blur) => `radial-gradient(circle at ${CX}px ${CY}px, ${rgba} 150px, transparent ${150 + blur * 0.6}px)`;
const page = ({ title, sub }) => `<!doctype html><html dir="rtl"><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Assistant:wght@600;800&display=block">
<style>
  body { margin: 0; width: 1200px; height: 630px; overflow: hidden; font-family: Assistant, sans-serif;
    background:
      ${glow('rgba(232, 185, 49, .32)', 24 * K)},
      ${glow('rgba(74, 143, 232, .24)', 42 * K)},
      radial-gradient(90% 70% at 90% 0%, rgba(70, 138, 236, .36), transparent 75%),
      radial-gradient(70% 60% at 0% 100%, rgba(36, 158, 112, .30), transparent 75%),
      #0A1321;
    display: flex; align-items: center; gap: 72px; padding: 0 90px; box-sizing: border-box; }
  .crest { width: 300px; height: 300px; flex: none; border-radius: 50%; padding: ${3 * K}px; box-sizing: border-box;
    background: linear-gradient(145deg, #F2CB55, #4A8FE8); }
  .crest img { width: 100%; height: 100%; display: block; border-radius: 50%; background: #0A1321; }
  .eyebrow { color: #E8B931; font-size: 34px; font-weight: 800; margin: 0 0 6px; }
  h1 { color: #E8EDF5; font-size: 96px; font-weight: 800; line-height: 1.05; margin: 0 0 18px; }
  .sub { color: #C9D2E0; font-size: 34px; font-weight: 600; line-height: 1.3; margin: 0; max-width: 620px; }
</style></head><body>
  <div class="crest"><img src="${crest}" alt=""></div>
  <div><p class="eyebrow">מכבי גבעתיים · העונה</p><h1>${title}</h1><p class="sub">${sub}</p></div>
</body></html>`;

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const g of GUIDES) {
  await tab.setContent(page(g), { waitUntil: 'networkidle' });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: new URL(`docs/${g.file}`, ROOT).pathname, type: 'jpeg', quality: 88 });
}
await browser.close();
