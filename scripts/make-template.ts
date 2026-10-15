/**
 * Crops a control (e.g. the Spin button) from a real screenshot into a
 * template. Pixels that are not "ink" (bright arrows/glyphs) become
 * transparent, so matching ignores whatever shows through the button.
 *
 *   npm run make-template -- <screenshot.png> <x> <y> <w> <h> assets/games/<game>/spin.png [minLuma=200]
 */
import sharp from 'sharp';

async function main() {
  const [src, x, y, w, h, out, minLuma = '200'] = process.argv.slice(2);
  if (!out) throw new Error('Usage: npm run make-template -- <png> <x> <y> <w> <h> <out.png> [minLuma]');
  const { data, info } = await sharp(src)
    .extract({ left: +x, top: +y, width: +w, height: +h })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let kept = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const ink = luma >= +minLuma;
    data[i + 3] = ink ? 255 : 0;
    if (ink) kept++;
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(out);
  console.log(`${out}: ${info.width}x${info.height}, ${((kept / (info.width * info.height)) * 100).toFixed(1)}% of pixels used for matching`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
