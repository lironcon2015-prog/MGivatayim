import { esc, safeUrl } from '../format.js';
import { sectionHead, videoCard, roundText } from '../components.js';

/* The media screen: the team gallery on top (photos | videos), useful links
   below. Videos live in one place — the manager's linked videos (YouTube,
   Drive: highlights, whole matches) and the clips parents upload share the
   gallery's videos tab. Until the gallery is switched on (Cloudinary keys in
   the bridge) the linked videos show on their own, as before. */

// The featured video first, then by round, latest first; a video with no
// round after those with one (`b.round - a.round` on a missing round was NaN,
// and a sort with NaN in it has no order at all).
const roundOf = (v) => (v.round != null && v.round !== '' && isFinite(v.round) ? Number(v.round) : -1);
export const videoOrder = (a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || roundOf(b) - roundOf(a);
export const sortedVideos = (s) => [...s.videos].sort(videoOrder);

// The linked videos as a block: the featured one first, then the rest.
export function linkedVideosHtml(s) {
  const videos = sortedVideos(s);
  if (!videos.length) return '';
  const missing = videos.filter((v) => !safeUrl(v.url)).length;
  return `${videos.map(videoCard).join('')}
    ${missing ? `<p class="note">${missing === videos.length
      ? 'לאף סרטון עדיין לא הוגדר קישור.'
      : `ל-${missing} מהסרטונים עדיין לא הוגדר קישור.`}</p>` : ''}`;
}

// What the gallery's host shows before it loads, and for good when the
// gallery is off: the linked videos, as the screen was before the gallery.
function videosOnly(s) {
  const videos = sortedVideos(s);
  if (!videos.length) return `<section>${sectionHead('סרטונים', '', 'film')}<div class="card"><div class="empty">טרם הועלו סרטונים לעונה.</div></div></section>`;
  return `<section>${sectionHead('סרטונים', esc(roundText(videos[0].round)), 'film')}${linkedVideosHtml(s)}</section>`;
}

export function renderMedia(s) {
  return `<div data-gallery>${videosOnly(s)}</div>

  <section>
    ${sectionHead('קישורים שימושיים', '', 'link')}
    <div class="card">${!s.links.length ? '<div class="empty">טרם נוספו קישורים.</div>' : s.links.map((l) => `<div class="insight"><span class="dot"></span><span><b>${esc(l.title)}:</b> ${esc(l.desc)}</span></div>`).join('')}</div>
  </section>`;
}
