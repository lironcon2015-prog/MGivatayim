# Puts assets/crest.png on the guides' link previews (docs/og-parent.jpg,
# docs/og-coach.jpg — what WhatsApp shows for the link), in the crest's place.
# python3 tools/make-og.py   — needs Pillow
#
# The owner wants the previews as they were designed, with only the crest
# swapped: no ring and no new glow round it. The crest is an opaque circle,
# so pasting it over the one already there replaces it whole; the place and
# size were measured on the original images (a 298px circle at 960, 314).
# After a new crest: run this, and bump ?v= on og:image in both guides —
# WhatsApp keeps a preview by its URL.
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SIZE, AT = 302, (809, 163)

crest = Image.open(ROOT / 'assets/crest.png').convert('RGBA').resize((SIZE, SIZE), Image.LANCZOS)
for name in ('og-parent.jpg', 'og-coach.jpg'):
    path = ROOT / 'docs' / name
    card = Image.open(path).convert('RGBA')
    card.alpha_composite(crest, AT)
    card.convert('RGB').save(path, quality=90, optimize=True)
