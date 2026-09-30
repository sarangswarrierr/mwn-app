// Re-runs the keystore flow end to end with no JAVA_HOME and no PATH, to prove
// the resolver works from a shell that predates the JDK. Deletes its own
// artifacts afterwards so a throwaway key is never left behind.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const r = spawnSync(process.execPath, ["scripts/make-keystore.mjs"], {
  input: "verify-pw-123\nverify-pw-123\n\n",
  encoding: "utf8",
  env: { SystemRoot: process.env.SystemRoot },
});

console.log("exit:", r.status);
console.log(
  (r.stdout || "")
    .split("\n")
    .filter((l) => /Created|SHA256/.test(l))
    .join("\n"),
);
if (r.stderr) console.log("stderr:", r.stderr.trim().split("\n").slice(-2).join(" | "));

for (const f of ["android/mwn-upload.jks", "android/keystore.properties"]) {
  rmSync(f, { force: true });
}
console.log("throwaway artifacts removed");
