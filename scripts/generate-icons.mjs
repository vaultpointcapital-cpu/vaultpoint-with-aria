// Generates the full PWA/TWA icon set into public/icons/.
//
// Usage:
//   node scripts/generate-icons.mjs                 -> placeholder "V" monogram
//   node scripts/generate-icons.mjs path/to/logo.png -> real source image (>=1024px recommended)
//
// PLACEHOLDER MODE: there is no brand mark anywhere in this repo as of
// writing (public/ was empty, no app/icon.png, no logo SVG). Run without an
// argument to render a plain "V" monogram in the existing brand accent
// color (#6C63FF, from tailwind.config.ts) instead of blocking on a real
// design asset. Swap this for a real logo before Play Store submission —
// re-run this script with a path to the real source image once one exists,
// and re-run `next build` so the new icons ship.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const OUT_DIR = path.resolve('public/icons');
const ACCENT = '#6C63FF'; // tailwind.config.ts colors.accent.DEFAULT
const FOREGROUND = '#FFFFFF'; // tailwind.config.ts colors.accent.foreground

const sourcePath = process.argv[2] ?? null;

/**
 * glyphScale controls how much of the square the "V" fills.
 * Maskable icons need the glyph within the ~80% "safe zone" that survives
 * OS icon masking (circle/squircle/rounded-square) — keep it well inside
 * that (50%) since text glyphs aren't circular and masking crops corners
 * hardest. Standard ("any") icons aren't masked, so they can fill more of
 * the square (65%).
 */
function placeholderSvg({ size, glyphScale }) {
  const fontSize = Math.round(size * glyphScale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${ACCENT}"/>
  <text x="50%" y="52%" text-anchor="middle" dominant-baseline="central"
    font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${fontSize}"
    fill="${FOREGROUND}">V</text>
</svg>`;
}

/**
 * For a real source image: resize to fill the square (cover), then for
 * maskable variants pad down onto a solid accent-color canvas so the
 * artwork sits within the safe zone instead of touching the edge.
 */
async function renderFromSource({ size, maskable }) {
  const inner = maskable ? Math.round(size * 0.7) : size;
  const resized = await sharp(sourcePath)
    .resize(inner, inner, { fit: 'cover' })
    .toBuffer();

  if (!maskable) return resized;

  return sharp({
    create: { width: size, height: size, channels: 4, background: ACCENT },
  })
    .composite([{ input: resized, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function renderPng(buffer, outPath) {
  await sharp(buffer).png().toFile(outPath);
  console.log('wrote', path.relative(process.cwd(), outPath));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const targets = [
    { file: 'icon-192.png', size: 192, maskable: false, glyphScale: 0.65 },
    { file: 'icon-512.png', size: 512, maskable: false, glyphScale: 0.65 },
    { file: 'icon-192-maskable.png', size: 192, maskable: true, glyphScale: 0.5 },
    { file: 'icon-512-maskable.png', size: 512, maskable: true, glyphScale: 0.5 },
    { file: 'apple-touch-icon-180.png', size: 180, maskable: false, glyphScale: 0.65 },
    { file: 'favicon-32.png', size: 32, maskable: false, glyphScale: 0.7 },
    { file: 'favicon-16.png', size: 16, maskable: false, glyphScale: 0.7 },
  ];

  for (const t of targets) {
    const buffer = sourcePath
      ? await renderFromSource({ size: t.size, maskable: t.maskable })
      : Buffer.from(placeholderSvg({ size: t.size, glyphScale: t.glyphScale }));
    await renderPng(buffer, path.join(OUT_DIR, t.file));
  }

  if (!sourcePath) {
    console.log('\nPlaceholder icons generated — pass a real image path to use a real logo:');
    console.log('  node scripts/generate-icons.mjs path/to/logo.png');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
