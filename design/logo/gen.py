# Generates the books.metta.family logo set.
#
# The mark: an open book; rising from it, two parents whose bodies form a
# heart around two children, inside a ring that is teal on one side and gold
# on the other, with a sprout and a small heart at the top — reading together
# as a family ("Đọc để hiểu, hiểu để thương" — Stories for Connection & Kindness). Drawn as plain vector
# shapes on a 200×200 grid; the wordmark is Literata (the app's reading face)
# and the tagline Be Vietnam Pro (the app's UI face), converted to outlines so
# every file renders the same without fonts.
#
#   python3 gen.py FONT_DIR    (FONT_DIR has Literata-500/600/700.ttf, Literata-Italic-500.ttf,
#                               BeVietnamPro-Medium.ttf — see README.md)
import json
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FONT_DIR = sys.argv[1] if len(sys.argv) > 1 else '.'

TEAL = '#14696a'        # ring, book base, children, wordmark
TEAL_DEEP = '#0f5556'   # tile background (app icon)
GOLD = '#c9972c'        # ring, pages, the right parent
GOLD_LIGHT = '#e2b955'  # pages, sprout
CREAM = '#f1dfb1'       # the left parent
PAPER = '#fbf8f1'       # gaps between shapes on light backgrounds
INK_DARK = '#e8efee'    # wordmark on dark backgrounds

# Colour roles of the mark, per background.
ON_LIGHT = dict(ring_l=TEAL, ring_r=GOLD, base=TEAL, page_a=GOLD, page_b=GOLD_LIGHT, left=CREAM, right=GOLD,
                kids=TEAL, sprout=GOLD, heart=GOLD, leaf_l=TEAL, leaf_r=GOLD, gap=PAPER)
ON_TEAL = dict(ring_l='#f6ead0', ring_r=GOLD_LIGHT, base='#fbf3df', page_a=GOLD_LIGHT, page_b='#f3d993', left='#fbf3df',
               right=GOLD_LIGHT, kids='#f3d993', sprout=GOLD_LIGHT, heart=GOLD_LIGHT, leaf_l='#f6ead0', leaf_r=GOLD_LIGHT, gap=TEAL_DEEP)
ON_DARK = dict(ON_LIGHT, ring_l='#4fb3ad', base='#4fb3ad', kids='#4fb3ad', leaf_l='#4fb3ad', gap='#1a1f29')

LEAF = 'M0 0 C5 -7 13 -7 18 0 C13 7 5 7 0 0Z'


def mark(c, detail=True):
    """The mark on the 200×200 grid. detail=False drops the small leaves and
    the gaps' fine work for 16–48 px."""
    g = c['gap']
    parts = []
    # ring: teal half, gold half, open at the top for the sprout
    sw = 7 if detail else 10
    parts.append(f'<path d="M85 34 A58 58 0 0 0 70 143" fill="none" stroke="{c["ring_l"]}" stroke-width="{sw}" stroke-linecap="round"/>')
    parts.append(f'<path d="M115 34 A58 58 0 0 1 130 143" fill="none" stroke="{c["ring_r"]}" stroke-width="{sw}" stroke-linecap="round"/>')
    if detail:
        # leaves growing inward from the ring, pointing up
        parts.append(f'<path d="{LEAF}" fill="{c["leaf_l"]}" transform="translate(57 84) rotate(-118) scale(0.9)"/>')
        parts.append(f'<path d="{LEAF}" fill="{c["leaf_r"]}" transform="translate(143 84) rotate(-62) scale(0.9)"/>')
    # sprout and heart
    parts.append(f'<path d="M100 47 V22" stroke="{c["sprout"]}" stroke-width="3.2" stroke-linecap="round" fill="none"/>')
    parts.append(f'<path d="M100 31 C90 30 85 22 86 12 C95 13 100 21 100 31Z" fill="{c["sprout"]}"/>')
    parts.append(f'<path d="M100 26 C109 23 115 16 115 6 C106 8 100 15 100 26Z" fill="{c["sprout"]}"/>')
    parts.append(f'<path d="M100 59 C91.5 53 90.5 45.5 95.2 44.6 C97.6 44.2 99.3 45.6 100 47.6 C100.7 45.6 102.4 44.2 104.8 44.6 C109.5 45.5 108.5 53 100 59Z" fill="{c["heart"]}"/>')
    # book: two layers of pages fanning from the spine, and its base
    parts.append(f'<path d="M100 153 C84 139 58 134 28 138 L28 147 C58 144 83 148 100 160Z" fill="{c["page_b"]}"/>')
    parts.append(f'<path d="M100 153 C116 139 142 134 172 138 L172 147 C142 144 117 148 100 160Z" fill="{c["page_b"]}"/>')
    parts.append(f'<path d="M100 148 C86 132 64 125 38 128 L36 137 C62 134 84 139 100 153Z" fill="{c["page_a"]}"/>')
    parts.append(f'<path d="M100 148 C114 132 136 125 162 128 L164 137 C138 134 116 139 100 153Z" fill="{c["page_a"]}"/>')
    parts.append(f'<path d="M22 152 C55 147 84 151 100 163 C116 151 145 147 178 152" fill="none" stroke="{c["base"]}" stroke-width="{6 if detail else 9}" stroke-linecap="round" stroke-linejoin="round"/>')
    # parents: heads, and bodies that together make a heart
    gap = f' stroke="{g}" stroke-width="{3 if detail else 5}" paint-order="stroke"'
    parts.append(f'<path d="M100 147 C84 132 61 116 61 96 C61 84 70 78 80 80.5 C90 83 96 91 100 100Z" fill="{c["left"]}"{gap}/>')
    parts.append(f'<path d="M100 147 C116 132 139 116 139 96 C139 84 130 77.5 120 80 C110 82.5 104 91 100 100Z" fill="{c["right"]}"{gap}/>')
    parts.append(f'<circle cx="80" cy="66" r="11"{gap} fill="{c["left"]}"/>')
    parts.append(f'<circle cx="120" cy="64" r="12"{gap} fill="{c["right"]}"/>')
    # children: two heads over one small heart
    parts.append(f'<path d="M100 141 C90 133 79 127 79 119.5 C79 115 84 113.5 89.5 116 C94 118 98 122 100 126 C102 122 106 118 110.5 116 C116 113.5 121 115 121 119.5 C121 127 110 133 100 141Z" fill="{c["kids"]}"{gap}/>')
    parts.append(f'<circle cx="89" cy="106" r="6.8" fill="{c["kids"]}"{gap}/>')
    parts.append(f'<circle cx="111" cy="106" r="6.8" fill="{c["kids"]}"{gap}/>')
    return ''.join(parts)


def placed(body, x, y, size):
    """The 200-grid mark scaled to `size` at (x, y)."""
    return f'<g transform="translate({x:.2f} {y:.2f}) scale({size / 200:.5f})">{body}</g>'


def tile(size, rounded=True, glyph=0.84, detail=True):
    rect = f'<rect width="{size}" height="{size}" rx="{size * 0.22:.2f}" fill="{TEAL_DEEP}"/>' if rounded else f'<rect width="{size}" height="{size}" fill="{TEAL_DEEP}"/>'
    # a soft light from the top, as on the reference tile
    grad = (f'<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f8582"/>'
            f'<stop offset="1" stop-color="{TEAL_DEEP}"/></linearGradient></defs>')
    rect = grad + rect.replace(f'fill="{TEAL_DEEP}"', 'fill="url(#t)"')
    s = size * glyph
    return rect + placed(mark(ON_TEAL, detail), (size - s) / 2, (size - s) / 2 + size * 0.01, s)


fonts = {k: TTFont(f'{FONT_DIR}/{f}') for k, f in
         [('reg', 'Literata-500.ttf'), ('semi', 'Literata-600.ttf'), ('bold', 'Literata-700.ttf'),
          ('italic', 'Literata-Italic-500.ttf'), ('ui', 'BeVietnamPro-Medium.ttf')]}

# The wordmark's colours, as in the app (src/components/Brand.jsx, index.css):
# teal books / family, gold metta (the gold half of the ring), quiet dots.
LIGHT = {'teal': '#14696a', 'gold': '#9f7419', 'dot': '#6b7487', 'tag': '#4c5568'}
DARK = {'teal': '#5cbfb7', 'gold': '#e2b955', 'dot': '#8d97aa', 'tag': '#b4bccb'}
TAGLINE = 'Đọc để hiểu, hiểu để thương.'


def text_path(font, text, x, y, size, tracking=0):
    upm = font['head'].unitsPerEm
    s = size / upm
    cmap, hmtx, gs = font.getBestCmap(), font['hmtx'], font.getGlyphSet()
    out, cx = [], x
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(TransformPen(pen, (s, 0, 0, -s, cx, y)))
        out.append(pen.getCommands())
        cx += hmtx[name][0] * s + tracking
    return ' '.join(out), cx - x


def wordmark(x, y, size, palette, tagline=True):
    """Three beats: semibold 'books', italic gold 'metta', bold 'family',
    joined by quiet dots; the Vietnamese tagline in italic under it."""
    runs = [('semi', 'books', 'teal'), ('reg', '.', 'dot'), ('italic', 'metta', 'gold'), ('reg', '.', 'dot'), ('bold', 'family', 'teal')]
    body, cx = '', x
    for font, text, colour in runs:
        d, w = text_path(fonts[font], text, cx, y, size, tracking=-size * 0.015)
        body += f'<path d="{d}" fill="{palette[colour]}"/>'
        cx += w
    w = cx - x
    if tagline:
        ts = size * 0.42
        t, wt = text_path(fonts['italic'], TAGLINE, 0, 0, ts)
        # centred under the wordmark
        body += f'<path d="{t}" fill="{palette["tag"]}" transform="translate({x + (w - wt) / 2:.2f} {y + size * 0.66:.2f})"/>'
    return body, w


def svg(w, h, body, title='books.metta.family'):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}" '
            f'role="img" aria-label="{title}"><title>{title}</title>{body}</svg>\n')


files = {}
files['logo-mark.svg'] = svg(200, 200, mark(ON_LIGHT))           # sidebar, sign-in (light theme)
files['logo-mark-dark.svg'] = svg(200, 200, mark(ON_DARK))       # same on dark surfaces
files['favicon.svg'] = svg(32, 32, tile(32, glyph=0.94, detail=False))


def lockup(colors, palette):
    word, ww = wordmark(0, 0, 44, palette)
    h = 96
    body = placed(mark(colors), 0, 0, h) + f'<g transform="translate({h + 14} 50)">{word}</g>'
    return svg(h + 14 + ww + 4, h, body)


files['logo.svg'] = lockup(ON_LIGHT, LIGHT)
files['logo-dark.svg'] = lockup(ON_DARK, DARK)


# Stacked lockup (sign-in page, documents): mark over the wordmark.
def stacked():
    word, ww = wordmark(0, 0, 56, LIGHT)
    w = max(ww, 230) + 8
    return svg(w, 324, placed(mark(ON_LIGHT), (w - 230) / 2, 0, 230) + f'<g transform="translate({(w - ww) / 2:.2f} 272)">{word}</g>')


files['logo-stacked.svg'] = stacked()

for name, content in files.items():
    with open(name, 'w') as f:
        f.write(content)
    print(name, len(content), 'bytes')

raster = {
    'favicon-32.png': svg(32, 32, tile(32, glyph=0.94, detail=False)),
    'apple-touch-icon.png': svg(180, 180, tile(180, rounded=False)),   # iOS rounds it itself
    'icon-192.png': svg(192, 192, tile(192)),
    'icon-512.png': svg(512, 512, tile(512)),
    'icon-maskable-512.png': svg(512, 512, tile(512, rounded=False, glyph=0.66)),  # inside the 80 % safe zone
}
with open('raster.json', 'w') as f:
    json.dump(raster, f)

# Link preview 1200×630: the paper of the reference, the stacked logo.
word, ww = wordmark(0, 0, 78, LIGHT)
OG_LINE = 'Đọc song ngữ Anh – Việt · dịch cùng nhau · học từ mới ngay trên trang sách'
og = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">'
      f'<rect width="1200" height="630" fill="#f7f3ea"/>'
      f'{placed(mark(ON_LIGHT), 600 - 160, 40, 320)}'
      f'<g transform="translate({600 - ww / 2:.2f} 452)">{word}</g>'
      f'<path d="{text_path(fonts["ui"], OG_LINE, 0, 0, 24)[0]}" fill="#5b6b6b" '
      f'transform="translate({600 - text_path(fonts["ui"], OG_LINE, 0, 0, 24)[1] / 2:.2f} 572)"/>'
      f'</svg>')
with open('og-image.svg', 'w') as f:
    f.write(og)
