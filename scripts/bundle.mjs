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
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
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
console.log(`  pruned ${pruned}/${PRUNE.length} unused entries`);
console.log(`  web/ is now ${kb(await sizeOf(target))}`);
