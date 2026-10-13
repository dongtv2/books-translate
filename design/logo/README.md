# books.metta.family logo

**Đọc để hiểu, hiểu để thương.** (Stories for Connection & Kindness.) The mark is an open book; rising from it, two parents whose bodies form a heart around two children, inside a ring that is teal on one side and gold on the other, with a sprout and a small heart at the top: a family reading together. The wordmark reads in three beats, echoing the mark: semibold **books** (what this is) in teal · italic *metta* (loving-kindness) in the gold of the ring · bold **family** (who it is for) in teal, joined by quiet grey dots, all in Literata (the app's reading face). The tagline *Đọc để hiểu, hiểu để thương.* is Literata italic under it. In files the text is converted to outlines so it renders the same everywhere. Wordmark colours: light teal `#14696a`, gold `#9f7419`, dots `#6b7487`, tagline `#4c5568`; on dark teal `#5cbfb7`, gold `#e2b955`, dots `#8d97aa`, tagline `#b4bccb` (the same tokens as `--color-accent` / `--color-brand-gold` in `src/index.css`). All brand copy — tagline, description, message — lives in `src/lib/brand.js`; `index.html` and `public/site.webmanifest` repeat it and must be kept in step. In the app itself the wordmark is live text (`src/components/Brand.jsx`).

| File in `public/` | Use |
|---|---|
| `favicon.svg`, `favicon-32.png` | Browser tab: the teal tile, simplified mark (no side leaves, thicker lines) |
| `logo-mark.svg` / `logo-mark-dark.svg` | The mark alone on light / dark surfaces (sidebar, sign-in) |
| `logo.svg` / `logo-dark.svg` | Horizontal lockup with tagline, light / dark backgrounds |
| `logo-stacked.svg` | Mark over wordmark and tagline (documents, splash) |
| `apple-touch-icon.png` | iOS home screen (180 px, square; iOS rounds it) |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Web app manifest (Android, installed PWA); maskable keeps the mark in the 80 % safe zone |
| `og-image.png` | Link previews for books.metta.family (1200×630) |

Colours: teal `#14696a` (tile `#0f5556` → `#1f8582`), gold `#c9972c`, light gold `#e2b955`, cream `#f1dfb1`, paper `#f7f3ea`. On dark surfaces the teal parts become `#4fb3ad`. The app's accent colour (`--color-accent` in `src/index.css`) is the same teal. Keep clear space around the mark of at least a fifth of its width; don't swap the teal and gold halves of the ring.

The previous set (the violet Ă mark) is kept in `.backup/logo-before-metta-family/`.

## Regenerating

Fonts (OFL): Literata from https://github.com/google/fonts/tree/main/ofl/literata and Be Vietnam Pro Medium from https://github.com/google/fonts/tree/main/ofl/bevietnampro. Make the static Literata instances (500, 600, 700 upright; 500 italic from `Literata-Italic[opsz,wght].ttf`) with fontTools:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
for w in (500, 600, 700):
    instancer.instantiateVariableFont(TTFont('Literata[opsz,wght].ttf'), {'wght': w, 'opsz': 36}).save(f'Literata-{w}.ttf')
instancer.instantiateVariableFont(TTFont('Literata-Italic[opsz,wght].ttf'), {'wght': 500, 'opsz': 36}).save('Literata-Italic-500.ttf')
```

Then `python3 gen.py <font dir> && node render.mjs` (headless Chrome rasterises the PNGs and writes `review.png`, a sheet of every asset at real sizes), and copy the outputs into `public/`.
