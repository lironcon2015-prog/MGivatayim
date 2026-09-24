import { esc } from '../format.js';
import { sectionHead, videoCard, roundText } from '../components.js';
import { safeUrl } from '../format.js';
import { galleryPlaceholder } from './gallery.js';

export function renderMedia(s) {
  const videos = [...s.videos].sort((a, b) => b.round - a.round);
  const featured = videos.find((v) => v.featured) || videos[0];
  const rest = videos.filter((v) => v !== featured);
  const missing = videos.filter((v) => !safeUrl(v.url)).length;

  if (!videos.length) {
    return `${galleryPlaceholder()}<section>${sectionHead('סרטונים', '', 'film')}<div class="card"><div class="empty">טרם הועלו סרטונים לעונה.</div></div></section>`;
  }

  return `${galleryPlaceholder()}
  <section>
    ${sectionHead('הסרטון הנבחר', esc(roundText(featured.round)), 'film')}
    ${videoCard(featured)}
  </section>

  ${rest.length ? `<section>
    ${sectionHead('כל הסרטונים', `${videos.length} סרטונים`, 'play')}
    ${rest.map(videoCard).join('')}
  </section>` : ''}

  ${missing ? `<section><p class="note">${missing === videos.length
      ? 'לאף סרטון עדיין לא הוגדר קישור בקובץ הנתונים.'
      : `ל-${missing} מהסרטונים עדיין לא הוגדר קישור.`}</p></section>` : ''}

  <section>
    ${sectionHead('קישורים שימושיים', '', 'link')}
    <div class="card">${!s.links.length ? '<div class="empty">טרם נוספו קישורים.</div>' : s.links.map((l) => `<div class="insight"><span class="dot"></span><span><b>${esc(l.title)}:</b> ${esc(l.desc)}</span></div>`).join('')}</div>
  </section>`;
}
