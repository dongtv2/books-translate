import { useState } from 'react';
import { api } from '../api.js';
import { coverFor, shortTitle } from '../lib/bookCover.js';

const SIZES = {
  sm: { box: 'w-14 rounded-[3px]', title: 'text-[7px] leading-[1.25]', author: 'hidden', pad: 'p-1.5 pl-2', sizes: '56px' },
  md: { box: 'w-full rounded', title: 'text-lead leading-[1.25]', author: 'text-caption', pad: 'p-4 pl-5', sizes: '(min-width: 1536px) 15vw, (min-width: 1280px) 18vw, (min-width: 768px) 22vw, 45vw' },
  lg: { box: 'w-40 rounded', title: 'text-lead leading-[1.25]', author: 'text-caption', pad: 'p-4 pl-5', sizes: '160px' },
};

const FRAME = 'relative aspect-[2/3] shrink-0 overflow-hidden shadow-[0_1px_2px_rgb(0_0_0/0.25),0_6px_14px_-6px_rgb(0_0_0/0.35)]';

// A book's cover in book proportions (2:3).
// With a cover image: the browser picks the 200 px or 600 px rendition for
// the space it has (srcset), the frame holds its shape and shows the
// image's main color until it arrives (no layout shift), list covers load
// lazily and the book page's loads first (`priority`). Without one — or if
// the image fails to load — a typographic cover: cloth color from the
// title, a spine shadow down the binding edge, title and author in the
// reading face. Decorative: the title is always repeated as text nearby.
// `preview` shows a picked image before it is saved.
export default function BookCover({ book, size = 'md', className = '', priority = false, preview = '' }) {
  const s = SIZES[size];
  const hasImage = Boolean(preview || (book.cover_lg && book.cover_sm));
  const version = preview || `${book.cover_lg}|${book.cover_sm}`;
  const [state, setState] = useState({ version, loaded: false, failed: false, ratio: 0, shown: '' });
  // a new image (or preview) starts over
  const current = state.version === version ? state : { version, loaded: false, failed: false, ratio: 0, shown: '' };
  // Covers are shown whole, never cropped. Only an image already in book
  // proportions (2:3 within 1%, a sub-pixel difference at these sizes) is
  // allowed to cover the frame; any other shape is fitted inside it, and
  // the space around it is filled with the same image, enlarged and
  // blurred, instead of bare bands.
  const fills = !current.ratio || Math.abs(current.ratio - 1.5) <= 0.015;

  if (hasImage && !current.failed) {
    const sm = preview || api.coverUrl(book, 'sm');
    const lg = preview || api.coverUrl(book, 'lg');
    return (
      <div aria-hidden="true" className={`${FRAME} ${s.box} ${className}`} style={{ backgroundColor: book.cover_color || '#d9d4c7' }}>
        {!fills && current.shown && (
          // the already-downloaded image again (no second request), as a backdrop
          <img src={current.shown} alt="" draggable={false} className="absolute inset-0 h-full w-full scale-125 object-cover opacity-70 blur-lg" />
        )}
        <img
          src={size === 'sm' ? sm : lg}
          srcSet={preview ? undefined : `${sm} 200w, ${lg} 600w`}
          sizes={preview ? undefined : s.sizes}
          width={200}
          height={300}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            setState({ version, loaded: true, failed: false, ratio: img.naturalHeight / img.naturalWidth, shown: img.currentSrc || img.src });
          }}
          onError={() => setState({ version, loaded: false, failed: true, ratio: 0, shown: '' })}
          className={`relative h-full w-full transition-opacity duration-300 ${fills ? 'object-cover' : 'object-contain drop-shadow-[0_2px_6px_rgb(0_0_0/0.35)]'} ${current.loaded ? 'opacity-100' : 'opacity-0'}`}
        />
        {/* the binding edge: a soft shade, as on the typographic cover */}
        <span className="pointer-events-none absolute inset-y-0 left-0 w-[6%] bg-gradient-to-r from-black/25 to-transparent" />
      </div>
    );
  }

  const cloth = coverFor(book);
  return (
    <div
      aria-hidden="true"
      className={`${FRAME} flex flex-col justify-between font-serif ${s.box} ${s.pad} ${className}`}
      style={{ backgroundColor: cloth.bg, color: cloth.fg }}
    >
      <span className="absolute inset-y-0 left-0 w-[7%] bg-black/20" />
      <span className={`line-clamp-5 font-semibold ${s.title}`}>{shortTitle(book.title_vi || book.title_en)}</span>
      {book.author && <span className={`line-clamp-2 opacity-80 ${s.author}`}>{book.author}</span>}
    </div>
  );
}
