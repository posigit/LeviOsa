/**
 * Generate the LeviOsa icon set from brand/mark.webp (the master mark:
 * black "l" on the #e9e5d2 brand field — square-cropped, gently rounded).
 *
 *   npm run icons   (npx tsx scripts/generate-icons.ts)
 *
 * Outputs:
 *   app/icon.svg                  vector shell with the mark embedded
 *   app/favicon.ico               16/32/48 PNG-in-ICO frames
 *   app/apple-icon.png            180px (iOS home screen — square, iOS masks it)
 *   public/icons/icon-*.png       192/512 "any" (rounded)
 *   public/icons/maskable-*.png   192/512 "maskable" (full-bleed per spec)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const SOURCE = path.join(__dirname, "..", "brand", "mark.webp");
const BG = "#e9e5d2";

/** Square crop centred on the letter (bbox measured from the source). */
const CROP = { left: 208, top: 7, size: 1118 };

/** Corner radius as a fraction of the tile (matches the source's softness). */
const RADIUS = 0.22;

function roundedMask(size: number): Buffer {
  const rx = Math.round(size * RADIUS);
  return Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${rx}" fill="#fff"/></svg>`
  );
}

async function square(size: number, rounded: boolean): Promise<Buffer> {
  let img = sharp(SOURCE)
    .extract({ left: CROP.left, top: CROP.top, width: CROP.size, height: CROP.size })
    .resize(size, size);
  if (rounded) {
    img = img.composite([{ input: roundedMask(size), blend: "dest-in" }]);
  }
  return img.png().toBuffer();
}

/** Minimal ICO writer: header + entries, PNG-compressed frames. */
function buildIco(frames: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const entries: Buffer[] = [];
  let offset = 6 + 16 * frames.length;
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += f.data.length;
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
}

async function main() {
  const root = path.join(__dirname, "..");
  const iconsDir = path.join(root, "public", "icons");
  mkdirSync(iconsDir, { recursive: true });

  // Vector shell: embedded palette PNG inside a rounded clip.
  const embed = await sharp(SOURCE)
    .extract({ left: CROP.left, top: CROP.top, width: CROP.size, height: CROP.size })
    .resize(1024, 1024)
    .png({ palette: true, colors: 32, compressionLevel: 9 })
    .toBuffer();
  writeFileSync(
    path.join(root, "app", "icon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
      `<defs><clipPath id="r"><rect width="1024" height="1024" rx="230"/></clipPath></defs>` +
      `<g clip-path="url(#r)">` +
      `<rect width="1024" height="1024" fill="${BG}"/>` +
      `<image href="data:image/png;base64,${embed.toString("base64")}" width="1024" height="1024"/>` +
      `</g></svg>\n`
  );

  writeFileSync(path.join(root, "app", "apple-icon.png"), await square(180, false));
  writeFileSync(path.join(iconsDir, "icon-192x192.png"), await square(192, true));
  writeFileSync(path.join(iconsDir, "icon-512x512.png"), await square(512, true));
  writeFileSync(path.join(iconsDir, "maskable-192x192.png"), await square(192, false));
  writeFileSync(path.join(iconsDir, "maskable-512x512.png"), await square(512, false));

  const ico = buildIco(
    await Promise.all(
      [16, 32, 48].map(async (size) => ({ size, data: await square(size, true) }))
    )
  );
  writeFileSync(path.join(root, "app", "favicon.ico"), ico);

  console.log("icons generated from brand/mark.webp");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
