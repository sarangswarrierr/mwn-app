// Fills each adaptive-icon background with the app's own page background
// (#0B1226, the Avengers theme's bg-base) instead of the white that
// @capacitor/assets defaults to. A white plate behind the logo reads as a
// white square on a dark home screen.
//
// The PNGs are what the launcher actually loads, so the values/ic_launcher
// background colour is rewritten to match for any density without one.
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// sharp is not a dependency of this package, and the web app that used to sit
// next door now lives in its own repository. `npm run assets` still needs it, so
// resolve it from the sibling web checkout when it is there and fall back to a
// locally installed copy. createRequire rather than import, because sharp's
// entry is a CJS bundle behind a conditional export that ESM will not resolve.
const require = createRequire(import.meta.url);
let sharp;
for (const candidate of ["sharp", "../MWN/node_modules/sharp", "../mwn/node_modules/sharp"]) {
  try {
    sharp = require(candidate);
    break;
  } catch {
    /* try the next location */
  }
}
if (!sharp) {
  console.error("sharp not found. Install it here (npm i -D sharp) or in a sibling web checkout.");
  process.exit(1);
}

const res = join(dirname(fileURLToPath(import.meta.url)), "..", "android", "app", "src", "main", "res");
const BG = "#0B1226";

// Adaptive icons are 108dp with the outer 18dp cropped, so the raster is
// larger than the visible circle by design.
const DENSITIES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

for (const [density, size] of Object.entries(DENSITIES)) {
  const out = join(res, `mipmap-${density}`, "ic_launcher_background.png");
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .png()
    .toFile(out);
  console.log(`wrote ${out} (${size}px)`);
}

await writeFile(
  join(res, "values", "ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BG}</color>
</resources>
`,
);
console.log("wrote values/ic_launcher_background.xml");
