// Runs make-keystore.mjs against a fake TTY, which is the path a human takes
// and the one that was broken: a shared stdin listener saw the password's
// keystrokes, held them in its buffer, and the certificate prompt then read the
// password back out of it. keytool received a password as the subject and failed
// with "Incorrect AVA format".
//
// A pipe test cannot cover this — piped input arrives as whole lines, not
// keystrokes — which is why the earlier verification was green while the
// interactive path was broken.
//
// What it does and does not prove: it exercises the real TTY path and asserts the
// observable outcomes (the subject is the default, the password is never echoed,
// keytool succeeds). It cannot reproduce the old code's defect, because that
// defect lived in a readline interface this script no longer contains. Treat it
// as a guard on the behaviour, not as proof that the historical bug is caught.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const PASSWORD = "hunter2-tty-secret";

// The script refuses to run when a keystore already exists, which is the right
// behaviour for a real key and the wrong one for a test. Clearing first makes
// the check deterministic — and a failed previous run is exactly the state that
// would otherwise abort the next one with a misleading "no report".
const artifacts = ["android/mwn-upload.jks", "android/keystore.properties"];
for (const f of artifacts) {
  rmSync(f, { force: true });
}

// Piped rather than inherited: keytool writes to the child's real fd 1, and that
// output is part of what has to be asserted here.
const child = spawnSync(process.execPath, ["scripts/verify-keystore-tty-inner.mjs"], {
  encoding: "utf8",
  cwd: process.cwd(),
  env: { ...process.env, TEST_PASSWORD: PASSWORD },
  timeout: 60_000,
  stdio: ["ignore", "pipe", "pipe"],
});

const out = (child.stdout || "") + (child.stderr || "");
const m = out.match(/REPORT:(\{.*\})/);
if (!m) {
  console.log(out.trim() || "(no output)");
  console.log("FAIL: no report — the TTY path did not run to completion");
  process.exit(1);
}

const report = JSON.parse(m[1]);
console.log("--- what the script printed ---");
console.log(out.split("REPORT:")[0].trim());
console.log("--- findings ---");

let bad = false;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) bad = true;
};

// The bug itself: the certificate subject must not be the password.
check("certificate subject is not the password", !report.subjectIsPassword);
check("password was not echoed to the screen", !report.printedPassword);
check(
  "raw mode was entered and left",
  report.rawModeCalls.includes(true) && report.rawModeCalls.includes(false),
);
check("the last prompt took the default (empty)", report.typed[2] === "");

// keytool inherits the real fd 1, so its output is here and not in `captured`.
// The subject line is the proof the password never reached it: before the fix
// keytool failed with "Incorrect AVA format" on a password-as-subject.
check("keytool was given the default subject", /for: CN=MWN/.test(out));
check("keytool did not reject the subject", !/Incorrect AVA format/.test(out));
check("the keystore was created", /\[Storing /.test(out));

for (const f of ["android/mwn-upload.jks", "android/keystore.properties"]) {
  rmSync(f, { force: true });
}
console.log(bad ? "\nFAILED" : "\nOK — throwaway artifacts removed");
process.exit(bad ? 1 : 0);
