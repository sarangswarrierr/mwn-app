// Bumps the app version in android/version.properties.
//
// Play Console requires versionCode to strictly increase on every upload, and
// rejects anything at or below the highest it has already seen. Doing this by
// hand means editing one number and hoping you remembered which one; doing it
// here means the number in the file is the number in the bundle.
//
//   npm run version            show the current version
//   npm run version -- patch   1.0.0 -> 1.0.1   bug fix
//   npm run version -- minor   1.0.0 -> 1.1.0   new feature
//   npm run version -- major   1.0.0 -> 2.0.0   breaking
//   npm run version -- 3.2.1   set it exactly
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "android", "version.properties");
const raw = readFileSync(file, "utf8");

const get = (key) => {
  const m = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
};

const code = get("versionCode");
const name = get("versionName");

if (!code || !name) {
  console.error(`${file} is missing versionCode or versionName.`);
  process.exit(1);
}

// `npm run version -- patch` hands the argument through as "--" then "patch",
// because npm passes the separator along on some versions. Take the first
// non-flag argument so both `npm run version patch` and the documented
// `npm run version -- patch` work.
const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));

if (!arg) {
  console.log(`versionCode ${code}`);
  console.log(`versionName ${name}`);
  process.exit(0);
}

const bump = (kind) => {
  const [maj, min, pat] = name.split(".").map(Number);
  if ([maj, min, pat].some(Number.isNaN)) {
    throw new Error(`versionName "${name}" is not major.minor.patch`);
  }
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown bump "${kind}" — use patch, minor, major, or an explicit version`);
};

// `patch`/`minor`/`major` move the name up a step. An explicit semver replaces
// it outright, which is what you want when a version was mistyped or you are
// matching a milestone. The code still increments either way: Play rejects an
// upload whose versionCode is not greater than the last one it accepted, and a
// script that skipped that would be the most annoying possible way to fail.
const nextName = /^\d+\.\d+\.\d+$/.test(arg) ? arg : bump(arg);

// Play's documented ceiling. Exceeding it makes the upload impossible, and it
// is not something you discover when it happens.
const MAX_CODE = 2100000000;
const nextCode = String(Number(code) + 1);
if (Number(nextCode) > MAX_CODE) {
  console.error(`versionCode would reach ${nextCode}, past Play's ${MAX_CODE} ceiling.`);
  process.exit(1);
}

// Re-asking for the version you are already on is a no-op, not a bump. The
// guard is on the name because that is the only value the caller controls; a
// `patch` bump always changes it by definition. Without this, a re-run would
// increment versionCode for no reason, and a versionCode is a one-shot resource
// against Play's finite ceiling.
const explicit = /^\d+\.\d+\.\d+$/.test(arg);
if (explicit && nextName === name) {
  console.log(`Already at ${name} (versionCode ${code}). Nothing to do.`);
  process.exit(0);
}

writeFileSync(
  file,
  raw
    .replace(/^versionCode=.*$/m, `versionCode=${nextCode}`)
    .replace(/^versionName=.*$/m, `versionName=${nextName}`),
);

console.log(`versionCode ${code} -> ${nextCode}`);
console.log(`versionName ${name} -> ${nextName}`);
console.log("");
console.log("Now: npm run bundle && npm run release");
console.log("Commit version.properties with the change that needed it.");
