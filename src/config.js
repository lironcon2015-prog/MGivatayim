// The bridge's /exec URL, from the Apps Script deployment (see tools/bridge.gs).
//
// It is public on purpose: every visitor's browser needs it, and it protects
// nothing by itself. The bridge enforces who may read and who may write, so
// publishing this string gives away no more than the address of a locked door.
export const BRIDGE_URL = '';

// Shown wherever the UI means "us" when the season data names no crest.
export const DEFAULT_CREST = 'assets/crest.png';
