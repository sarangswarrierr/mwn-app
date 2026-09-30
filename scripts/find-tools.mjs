// Finds the JDK and the Android SDK without trusting the caller's environment.
//
// The problem this exists for: a terminal opened *before* a tool was installed
// keeps the environment it was launched with, forever. JAVA_HOME and PATH are
// copied into a shell at launch, so installing the JDK afterwards updates the
// registry for every future shell but not this one. Anything that resolves
// `keytool` by name or trusts `process.env.JAVA_HOME` then fails in exactly that
// shell while working fine in a new one — the same build, the same machine, a
// different terminal.
//
// So: probe for a real executable rather than reading a variable, and when
// nothing is found, say which paths were tried. A generic "is JAVA_HOME set?"
// is worse than useless, because JAVA_HOME very often *is* set and simply is
// not the problem.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * Run a tool by its bare name, letting the OS resolve it from PATH. Returns
 * null instead of throwing when the name is not found.
 */
const fromPath = (name) => {
  const r = spawnSync(name, ["-version"], { stdio: "ignore", shell: false });
  return r.error ? null : name;
};

/**
 * Directory entries under `parent` matching `re`, newest first when the names
 * sort naturally. Used to glob the version-suffixed install roots below.
 */
const versionedDirs = (parent, re) => {
  let names;
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter((n) => re.test(n))
    // jdk-21.0.12.101 sorts after jdk-17.0.9, which is what we want: the
    // highest version wins, and lexicographic order is close enough for that.
    .sort()
    .reverse()
    .map((n) => join(parent, n));
};

/**
 * Locate a JDK's `bin` directory.
 *
 * Order matters and is deliberate: an explicit JAVA_HOME is the developer's
 * stated intent, then PATH, then the conventional install roots. The roots are
 * the last resort precisely because they are where a fresh install lands when
 * nobody configured anything — which is the stale-shell case above.
 *
 * @returns {{ bin: string, source: string } | null}
 */
export function findJdkBin() {
  const tool = `keytool${EXE}`;

  const home = process.env.JAVA_HOME;
  if (home) {
    const bin = join(home, "bin");
    if (existsSync(join(bin, tool))) return { bin, source: "JAVA_HOME" };
  }

  const onPath = fromPath(tool);
  if (onPath) return { bin: "from PATH", source: "PATH" };

  // Vendors and layouts worth checking. Android Studio's own JBR is included
  // because it is a real JDK and a common thing to have lying around.
  const roots = [
    ["C:\\Program Files\\Eclipse Adoptium", /^jdk-/i],
    ["C:\\Program Files\\Java", /^jdk-/i],
    ["C:\\Program Files\\Microsoft", /^jdk-/i],
    ["C:\\Program Files\\Amazon Corretto", /^jdk-/i],
    ["C:\\Program Files\\Zulu", /^zulu-/i],
    ["C:\\Program Files\\Android\\Android Studio\\jbr", null],
    ["/usr/lib/jvm", /.*/],
    ["/Library/Java/JavaVirtualMachines", /.*/],
  ];

  const tried = [];
  for (const [parent, re] of roots) {
    if (!re) {
      tried.push(join(parent, "bin", tool));
      if (existsSync(join(parent, "bin", tool))) {
        return { bin: join(parent, "bin"), source: parent };
      }
      continue;
    }
    tried.push(join(parent, "<jdk-*>", "bin", tool));
    for (const dir of versionedDirs(parent, re)) {
      const bin = join(dir, "bin");
      if (existsSync(join(bin, tool))) return { bin, source: dir };
    }
  }

  return { error: tried };
}

/**
 * Locate the Android SDK, from ANDROID_HOME, the sibling install this project
 * documents, or a scan of the conventional roots.
 *
 * @returns {{ sdk: string, source: string } | null}
 */
export function findAndroidSdk() {
  const probe = join("platform-tools", `adb${EXE}`);

  for (const [env, label] of [
    [process.env.ANDROID_HOME, "ANDROID_HOME"],
    [process.env.ANDROID_SDK_ROOT, "ANDROID_SDK_ROOT"],
  ]) {
    if (env && existsSync(join(env, probe))) return { sdk: env, source: label };
  }

  // The documented sibling: ../android-sdk relative to this project.
  const sibling = join(import.meta.dirname, "..", "..", "android-sdk");
  if (existsSync(join(sibling, probe))) return { sdk: sibling, source: "sibling checkout" };

  const roots = [
    join(process.env.LOCALAPPDATA || "", "Android", "Sdk"),
    join(process.env.USERPROFILE || "", "AppData", "Local", "Android", "Sdk"),
    join(process.env.HOME || "", "Android", "Sdk"),
    join(process.env.HOME || "", "Library", "Android", "sdk"),
    "/usr/lib/android-sdk",
  ];

  for (const sdk of roots) {
    if (sdk && existsSync(join(sdk, probe))) return { sdk, source: sdk };
  }

  return { error: roots };
}

/**
 * The message to print when a tool cannot be found. Naming the paths is the
 * whole point: it turns "something is misconfigured" into "here is the file I
 * looked for".
 */
export function notFound(what, tried) {
  return (
    `Could not find ${what}.\n\n` +
    `Looked in:\n${tried.map((p) => `  ${p}`).join("\n")}\n\n` +
    `If it is installed somewhere else, set JAVA_HOME or ANDROID_HOME to point\n` +
    `at it. Note that a terminal opened before the tool was installed keeps the\n` +
    `old environment — opening a new one is often the whole fix.`
  );
}

