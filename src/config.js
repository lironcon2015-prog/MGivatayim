// The bridge: the Cloudflare server (server/), which runs tools/bridge.gs.
// Until the move it was the Apps Script deployment (FALLBACK_URL), which still
// runs, passing old phones on (MODE=forward) and doing the owner's errands for
// the server. Going back: README, "חזרה לגוגל".
//
// It is public on purpose: every visitor's browser needs it, and it protects
// nothing by itself. The bridge enforces who may read and who may write, so
// publishing this string gives away no more than the address of a locked door.
export const BRIDGE_URL = 'https://mgivatayim.lironcon.workers.dev';

// The way around a network that blocks workers.dev — the owner's cellular
// network did, his wifi did not ("as if there were no internet"). In forward
// mode the Apps Script bridge passes each request on to the server from
// Google's side, which no phone network blocks. bridge.js decides when.
export const FALLBACK_URL = 'https://script.google.com/macros/s/AKfycbySPj1RCXKbzf7CIe6HlDFFnsRFDqgmGoFugT5P9T9wcCqkduS0k9rrtWVqcWYs6xnbyg/exec';

// Shown wherever the UI means "us" when the season data names no crest.
export const DEFAULT_CREST = 'assets/crest.png';
