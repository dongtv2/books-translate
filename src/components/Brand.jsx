import { BRAND } from '../lib/brand.js';

// The books.metta.family brand: the mark (open book, a family forming a
// heart, teal and gold ring; source and generator in design/logo/) and the
// wordmark, set in the app's own fonts so it stays crisp at any size.

// Both versions are in the page; the theme shows one (index.css, .theme-light-only).
export function BrandMark({ size = 32, className = '' }) {
  return (
    <span className={`relative inline-block shrink-0 ${className}`} style={{ width: size, height: size }}>
      <img src="/logo-mark.svg" alt="" width={size} height={size} className="theme-light-only h-full w-full" />
      <img src="/logo-mark-dark.svg" alt="" width={size} height={size} className="theme-dark-only h-full w-full" />
    </span>
  );
}

// The wordmark reads in three beats, echoing the mark: **books** (what this
// is) · *metta* (loving-kindness, in the gold of the ring) · **family**
// (who it is for). The dots stay quiet, so it reads as a name before it
// reads as an address. `tagline` adds the line under it.
export function BrandName({ className = '', tagline = false }) {
  return (
    <span className={`inline-flex flex-col leading-none ${tagline ? 'items-center text-center' : ''}`}>
      <span className={`whitespace-nowrap font-serif tracking-[-0.015em] ${className}`} aria-label={BRAND.name}>
        <span aria-hidden="true" className="font-semibold text-accent">books</span>
        <span aria-hidden="true" className="text-mute">.</span>
        <span aria-hidden="true" className="italic text-brand-gold">metta</span>
        <span aria-hidden="true" className="text-mute">.</span>
        <span aria-hidden="true" className="font-bold text-accent">family</span>
      </span>
      {tagline && <span className="mt-2.5 font-serif text-lead italic text-soft">{BRAND.tagline}</span>}
    </span>
  );
}
