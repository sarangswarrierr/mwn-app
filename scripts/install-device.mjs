// Installs the debug APK on a connected device.
//
// Resolves adb itself rather than calling it by name, because the SDK's
// platform-tools directory is not always on PATH — and a shell that was open
// before the SDK was installed keeps a stale copy of PATH even after the
// registry is updated. Sourcing it from ANDROID_HOME sidesteps both, and the
// error tells you what to do when the SDK genuinely isn't there.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const apk = join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  join(join(root, ".."), "android-sdk");

const adb = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");

if (!existsSync(apk)) {
  console.error(`No APK at ${apk}\nRun: npm run apk`);
  process.exit(1);
}

if (!existsSync(adb)) {
  console.error(
    `adb not found at ${adb}\n` +
      `Set ANDROID_HOME to your Android SDK, or re-run sdkmanager from` +
      ` ${join(sdk, "cmdline-tools", "latest", "bin")}`,
  );
  process.exit(1);
}

const run = (args) => spawnSync(adb, args, { stdio: "inherit", shell: false });

// List first: `adb install` against no devices fails with a message that reads
// like a broken APK, and "plug in a phone" is the actually useful thing to say.
//
// This one call pipes rather than inherits, because it is the only thing whose
// output gets parsed — `stdio: "inherit"` leaves `.stdout` null, which reads as
// "no devices" even when a phone is sitting there plugged in.
const probed = spawnSync(adb, ["devices"], { encoding: "utf8", shell: false });
const devices = probed.stdout ?? "";
const attached = devices
  .split("\n")
  .slice(1)
  .map((l) => l.trim().split(/\s+/)[0])
  .filter((id) => id && id !== "offline");

if (!attached.length) {
  console.error(
    "No device attached.\n" +
      "  - plug the phone in over USB\n" +
      "  - Settings > About phone > tap Build number 7 times\n" +
      "  - Settings > Developer options > USB debugging ON\n" +
      "  - accept the 'Allow USB debugging' prompt on the phone\n" +
      "  - set the USB mode to File transfer, not Charging only",
  );
  process.exit(1);
}

console.log(`Installing on ${attached.join(", ")}…`);
const result = run(["install", "-r", apk]);
process.exit(result.status ?? 1);
