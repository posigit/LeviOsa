/**
 * Generate the LeviOsa icon set from brand/hermione.png (the master mark:
 * cream Hermione stencil on a black tile, transparent margins — the tile is
 * located by alpha bbox at runtime, flattened to an opaque square, then
 * rounded).
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

const SOURCE = path.join(__dirname, "..", "brand", "hermione.png");
const BG = "#000000";

/** Corner radius as a fraction of the tile (matches the previous set). */
const RADIUS = 0.22;

function roundedMask(size: number): Buffer {
  const rx = Math.round(size * RADIUS);
  return Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${rx}" fill="#fff"/></svg>`
  );
}

/** Opaque square tile: source trimmed to its opaque bbox, flattened on the tile's own dark color, padded to square. */
async function masterTile(): Promise<Buffer> {
  const { data, info } = await sharp(SOURCE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let minX = W,
    maxX = 0,
    minY = H,
    maxY = 0;
  const hist = new Map<number, number>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      if (data[i + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum < 15) {
          const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          hist.set(key, (hist.get(key) ?? 0) + 1);
        }
      }
    }
  }
  // Modal near-black = the tile fill; using it avoids a visible seam where
  // the source's transparent margins get flattened onto a different black.
  let fill = 0x000000;
  let best = 0;
  for (const [key, count] of hist) {
    if (count > best) {
      best = count;
      fill = key;
    }
  }
  const bg = {
    r: (fill >> 16) & 255,
    g: (fill >> 8) & 255,
    b: fill & 255,
    alpha: 1,
  };
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const size = Math.max(w, h);
  const padX = Math.round((size - w) / 2);
  const padY = Math.round((size - h) / 2);
  return sharp(SOURCE)
    .extract({ left: minX, top: minY, width: w, height: h })
    .flatten({ background: bg })
    .extend({
      top: padY,
      bottom: size - h - padY,
      left: padX,
      right: size - w - padX,
      background: bg,
    })
    .png()
    .toBuffer();
}

async function square(tile: Buffer, size: number, rounded: boolean): Promise<Buffer> {
  let img = sharp(tile).resize(size, size);
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

  const tile = await masterTile();

  // Vector shell: embedded palette PNG inside a rounded clip.
  const embed = await sharp(tile)
    .resize(1024, 1024)
    .png({ palette: true, colors: 64, compressionLevel: 9 })
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

  writeFileSync(path.join(root, "app", "apple-icon.png"), await square(tile, 180, false));
  writeFileSync(path.join(iconsDir, "icon-192x192.png"), await square(tile, 192, true));
  writeFileSync(path.join(iconsDir, "icon-512x512.png"), await square(tile, 512, true));
  writeFileSync(path.join(iconsDir, "maskable-192x192.png"), await square(tile, 192, false));
  writeFileSync(path.join(iconsDir, "maskable-512x512.png"), await square(tile, 512, false));

  const ico = buildIco(
    await Promise.all(
      [16, 32, 48].map(async (size) => ({ size, data: await square(tile, size, true) }))
    )
  );
  writeFileSync(path.join(root, "app", "favicon.ico"), ico);

  console.log("icons generated from brand/hermione.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
