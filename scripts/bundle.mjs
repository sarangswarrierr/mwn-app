// Copies a built web app into web/, which is this project's Capacitor `webDir`
// and the thing the APK actually packages.
//
// The web app is a separate repository, so the bundle is committed rather than
// built on demand: that keeps this repo buildable by itself. This script is how
// you refresh it, and it is deliberately the only place that knows where the
// build output lives.
//
// It also prunes what Vite copies but nothing loads. The web app's public/
// still carries 52 poster JPEGs (4.6 MB) from before posters came from TMDB at
// runtime, plus the 2000x2000 logo.png and favicon.png source artwork (1.7 MB).
// None of it is referenced by the built index.html or JS, so shipping it costs
// APK size and buys nothing.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "web");

// --from <path> overrides the default sibling checkout.
const fromArg = process.argv.indexOf("--from");
const explicit = fromArg >= 0 ? process.argv[fromArg + 1] : null;

const source = resolve(explicit || join(root, "..", "MWN", "dist"));

// The dead weight. Each is unreferenced by the build; see the header comment.
const PRUNE = ["Images", "logo.png", "favicon.png"];

if (!explicit) {
  try {
    const s = await stat(join(source, "index.html"));
    if (!s.isFile()) throw new Error();
  } catch {
    console.error(
      `No web build at ${source}\n\n` +
        `Clone the web app (github.com/sarangswarrierr/MWN) next to this folder\n` +
        `and run its build, or point at a dist directly:\n\n` +
        `  npm run bundle -- --from D:\\path\\to\\MWN\\dist`,
    );
    process.exit(1);
  }
}

// -- AdSense. The web app loads adsbygoogle.js for the deployed site, but the
// AdSense program policy forbids serving those ads inside a webview, and a
// violation can suspend the publisher ID for the deployed site as well. Both
// targets are built from the same dist, so the tag is removed here -- this is
// the boundary where a web build becomes a webview build.
//
// This runs against the source build before anything is written, so a failure
// leaves web/ exactly as it was rather than half-replaced.
//
// Only the loader lives in index.html; ad slot markup would sit in the bundled
// JS, where a string replace cannot reach it. Gate those in the web app with
// the Capacitor check in src/lib/native.js instead.
const AD_TAG = /[ \t]*<script\b[^>]*adsbygoogle\.js[^>]*>\s*<\/script>\r?\n?/gi;
const sourceHtml = await readFile(join(source, "index.html"), "utf8");
// A tag that is genuinely gone from the web app is fine. A tag that is present
// but survives the strip means the markup drifted from AD_TAG and would ship
// into the webview, so that has to be loud.
const stripAds = (html) => html.replace(AD_TAG, "");
if (sourceHtml.includes("adsbygoogle") && stripAds(sourceHtml).includes("adsbygoogle")) {
  console.error(
    `The AdSense loader in ${join(source, "index.html")} does not match AD_TAG.\n\n` +
      `Refusing to bundle: serving it in a webview violates AdSense policy.\n` +
      `Update AD_TAG in scripts/bundle.mjs to match the tag's current markup.`,
  );
  process.exit(1);
}
const hasAds = sourceHtml.includes("adsbygoogle");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

let pruned = 0;
for (const name of PRUNE) {
  const p = join(target, name);
  try {
    await rm(p, { recursive: true, force: true });
    pruned++;
  } catch {
    /* not present in this build; nothing to do */
  }
}

const sizeOf = async (dir) => {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await sizeOf(p) : (await stat(p)).size;
  }
  return total;
};

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`web/ <- ${source}`);
if (hasAds) {
  await writeFile(join(target, "index.html"), stripAds(sourceHtml));
  console.log("  stripped the AdSense loader (no ads in a webview)");
}
console.log(`  pruned ${pruned}/${PRUNE.length} unused entries`);
console.log(`  web/ is now ${kb(await sizeOf(target))}`);
