// Inline so the app has no icon-font or CDN dependency: a match-day page that
// needs the network to render its "navigate to the pitch" button is useless
// in exactly the car park where it gets opened.
const svg = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

export const icons = {
  qr: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M14 21h.01M17 21h4v-4"/>'),
  ball: svg('<circle cx="12" cy="12" r="9"/><path d="m12 7 4 3-1.5 4.5h-5L8 10z"/>'),
  pin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  shirt: svg('<path d="M16 3l5 3-2 4-2-1v12H7V9L5 10 3 6l5-3z"/><path d="M9 3a3 3 0 0 0 6 0"/>'),
  nav: svg('<path d="M3 11l18-8-8 18-2-8z"/>'),
  play: svg('<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>'),
  // A football boot, side on: heel left, toe right, laces and studs.
  boot: svg('<path d="M3 16V8.5A1.5 1.5 0 0 1 4.5 7H8l1.6 2.4 5.9 1.8c2.6.8 4.5 2.1 5.2 4.1.2.6-.2 1.2-.9 1.2H3z"/><path d="M10.6 11.2l1-1.6M13.2 12l1-1.6M5 16v2.2M9 16v2.2M14 16v2.2M18.5 16v2.2"/>'),
  // For the useful links: social pages and the kinds of page a team links
  // to. Drawn in the app's line, in gold like every icon — not in the
  // brands' colours, which would shout over the rest of the screen.
  facebook: svg('<path d="M14.5 21v-7.5h2.8l.5-3.3h-3.3V8.3c0-1 .4-1.6 1.6-1.6H18V3.8c-.4-.1-1.6-.2-2.8-.2-2.8 0-4.4 1.6-4.4 4.6v2H8v3.3h2.8V21"/>'),
  instagram: svg('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.3 6.7h.01"/>'),
  youtube: svg('<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.4v5.2l4.6-2.6z"/>'),
  tiktok: svg('<path d="M13.5 3v11.6a3.6 3.6 0 1 1-3.6-3.6"/><path d="M13.5 3c.5 2.8 2.4 4.6 5.3 4.8"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.6 3.7 5.6 3.7 9s-1.3 6.4-3.7 9c-2.4-2.6-3.7-5.6-3.7-9S9.6 5.6 12 3z"/>'),
  cart: svg('<path d="M3 4h2.2l2.4 11.2h10.9L20.5 7H6.4"/><circle cx="9.5" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/>'),
  card: svg('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>'),
  doc: svg('<path d="M14 3H6.5a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 17h4.5"/>'),
  medical: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 7.5v9M7.5 12h9"/>'),
  bus: svg('<rect x="4" y="3.5" width="16" height="14" rx="2.5"/><path d="M4 11h16M7.5 17.5V20M16.5 17.5V20M8 14.3h.01M16 14.3h.01"/>'),
  phone: svg('<path d="M5.2 3.5h3.6l1.8 4.6-2.3 1.5a11.5 11.5 0 0 0 6.1 6.1l1.5-2.3 4.6 1.8v3.6A1.7 1.7 0 0 1 18.8 20.5 16 16 0 0 1 3.5 5.2 1.7 1.7 0 0 1 5.2 3.5z"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  photo: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5-4 4 3 3-2 4 3"/>'),
  chevron: svg('<path d="m14 6-6 6 6 6"/>'),
  spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'),
  swap: svg('<path d="M7 4v14M7 18l-3-3M7 18l3-3M17 20V6M17 6l-3 3M17 6l3 3"/>'),
  whistle: svg('<circle cx="9" cy="14" r="5"/><path d="M13 11l8-4v4l-6 2M9 9V4h3"/>'),
  pause: svg('<path d="M9 5v14M15 5v14"/>'),
  play: svg('<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>'),
  upload: svg('<path d="M12 16V4M12 4 7 9M12 4l5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  clipboard: svg('<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/>'),
  arrowIn: svg('<path d="M12 19V5M12 5l-5 5M12 5l5 5"/>'),
  arrowOut: svg('<path d="M12 5v14M12 19l-5-5M12 19l5-5"/>'),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  trophy: svg('<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3"/><path d="M12 14v3M9 20h6"/>'),
  // Navigation and section heads.
  home: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  broadcast: svg('<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  film: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/>'),
  shield: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16v4M17 18h4"/>'),
  link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  bulb: svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>'),
  bolt: svg('<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  // A penalty that did not go in; the spot in front of a goal.
  miss: svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 8.5 7 7M15.5 8.5l-7 7"/>'),
  penalty: svg('<path d="M3 17V6h18v11"/><path d="M7 17v-6h10v6"/><circle cx="12" cy="21" r="1.2" fill="currentColor"/>'),
  eyeoff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  ban: svg('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  share: svg('<path d="M12 3v12M12 3 8 7M12 3l4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>'),
  download: svg('<path d="M12 4v11M12 15l-4-4M12 15l4-4M5 20h14"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  whatsapp: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/><path d="M9 9.5c0 2.5 2 5 5 5.5l1.2-1.3-1.8-1-1 .8c-.8-.4-1.5-1.1-2-2l.8-1-1-1.8z"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};

export const icon = (name) => icons[name] || icons.ball;
