// The mark, inline.
//
// Inlined rather than an `<img src="./favicon.svg">` because the header is above the fold
// and a separate request for a 500-byte icon is a request the page can do without — and
// because an inline SVG inherits the page's own rendering, so it stays crisp at whatever
// size the header ends up.
//
// This is the small variant: case, seam, clasp, no routing fan. `public/logo.svg` carries
// the fan for sizes where it resolves. See the comment in either file for why the seam is
// the part that matters.

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Attaché">
      <rect width="32" height="32" rx="7.5" fill="#1c2333" />
      <path
        d="M12.6 11.2V9.9a1.6 1.6 0 0 1 1.6-1.6h3.6a1.6 1.6 0 0 1 1.6 1.6v1.3"
        fill="none"
        stroke="#7dd3fc"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <rect x="3.6" y="11.2" width="24.8" height="13.4" rx="2.2" fill="#7dd3fc" />
      <path d="M3.6 16.4H28.4" stroke="#1c2333" strokeWidth="1.6" />
      <rect x="13.7" y="14.7" width="4.6" height="3.4" rx="1.1" fill="#1c2333" />
    </svg>
  )
}
