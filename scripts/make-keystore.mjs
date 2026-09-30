// Generates the upload keystore and writes android/keystore.properties.
//
// This is Play's "upload key": the one you keep. Google holds the app signing
// key that signs what users actually install, which is why losing this file is
// recoverable — you can ask Play Console to reset an upload key. Without Play
// App Signing, losing the key means losing the ability to update the app at all.
//
// Prompts for the password rather than taking it as an argument, so it does not
// land in your shell history, this repo, or a CI log.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findJdkBin, notFound } from "./find-tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = join(root, "android");
const keystore = join(androidDir, "mwn-upload.jks");
const propsFile = join(androidDir, "keystore.properties");
const example = join(androidDir, "keystore.properties.example");

const ALIAS = "mwn";
// 10000 days is ~27 years. Google requires the certificate to stay valid past
// October 2033, and a key that expires stops users upgrading to new versions.
const VALIDITY_DAYS = 10000;

// Probed for rather than read from JAVA_HOME: a terminal opened before the JDK
// was installed has an empty JAVA_HOME and a PATH without it, and would
// otherwise fail here while the identical command worked in a new window.
const jdk = findJdkBin();
if (jdk.error) {
  console.error(notFound("keytool (a JDK is needed to sign the app)", jdk.error));
  process.exit(1);
}
const keytool = jdk.bin === "from PATH" ? `keytool${process.platform === "win32" ? ".exe" : ""}` : join(jdk.bin, `keytool${process.platform === "win32" ? ".exe" : ""}`);

// One line-reading implementation for the whole script, used for both the
// password and the certificate name.
//
// A readline interface is the obvious choice and the wrong one here. Piped input
// arrives in a single chunk, so readline emits every line at once; the first
// prompt consumes the first and the rest are emitted before the next question is
// registered, so the second prompt waits forever for a line that has already
// gone past. A fresh interface per prompt does not help either — readline closes
// stdin as it shuts down. Either way the script could only ever be run by hand.
//
// So: one listener on stdin for the whole run, lines split out of it as they
// arrive and queued. A prompt takes from the queue, or waits on it if the input
// has not come yet. Nothing is registered late, so nothing is missed.
//
// On a TTY, reading the password means suppressing echo so it never lands on
// screen in a screenshot or a screen share. That needs setRawMode, which does
// not exist off a terminal, so the two cases are separate paths.

// Completed lines waiting for a prompt, and prompts waiting for a line.
const queue = [];
const waiting = [];
let buffer = "";

// Splits whatever has arrived so far into lines. A partial trailing line stays
// in `buffer` until the rest of it turns up, so a value split across two chunks
// is still read as one line.
const drain = () => {
  let at;
  while ((at = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, at).replace(/\r$/, "");
    buffer = buffer.slice(at + 1);
    if (waiting.length) waiting.shift()(line);
    else queue.push(line);
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  drain();
});
process.stdin.resume();

const nextLine = () =>
  new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    waiting.push(resolve);
  });

const ask = async (prompt) => {
  process.stdout.write(prompt);
  return (await nextLine()).trim();
};

const readSecret = (prompt) => {
  // No terminal, so there is nothing to leak into and setRawMode is absent.
  if (!process.stdin.isTTY) return ask(prompt);

  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    let value = "";
    const finish = (fn, arg) => {
      stdin.removeListener("data", onSecret);
      stdin.setRawMode(wasRaw ?? false);
      process.stdout.write("\n");
      fn(arg);
    };
    const onSecret = (c) => {
      const ch = c.toString("utf8");
      if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(resolve, value);
      // Backspace: the DEL most terminals send, and the older BS.
      if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
        return;
      }
      if (ch === "\u0003") return finish(reject, new Error("cancelled"));
      value += ch;
    };
    stdin.on("data", onSecret);
  });
};

if (existsSync(keystore)) {
  console.error(
    `${keystore} already exists.\n\n` +
      "This is the key that signs every upload. Replacing it is safe on Play App\n" +
      "Signing (you can register a new upload certificate in Play Console), but\n" +
      "if you meant to keep this one, delete it deliberately and re-run.",
  );
  process.exit(1);
}

if (!existsSync(example)) {
  console.error(`Missing ${example}. Restore it from git first.`);
  process.exit(1);
}

const password = await readSecret("Password for the upload key (min 6 chars): ");
if (password.length < 6) {
  console.error("Too short — keytool requires at least 6 characters.");
  process.exit(1);
}
const confirm = await readSecret("Confirm: ");
if (password !== confirm) {
  console.error("Passwords did not match.");
  process.exit(1);
}

const dname = await ask('Certificate name [CN=MWN, OU=Personal, O=MWN, L=, S=, C=IN]: ');
const name = dname || "CN=MWN, OU=Personal, O=MWN, C=IN";

// keytool has no -storepass:stdin — that option does not exist, and passing it
// makes keytool exit with "Unknown password type: stdin". It does accept
// :env, which keeps the password out of argv: a process list shows the variable
// name, not its value, and the child inherits it directly.
const PW_VAR = "MWN_KEYSTORE_PASSWORD";
const result = spawnSync(
  keytool,
  [
    "-genkeypair",
    "-v",
    "-keystore", keystore,
    "-alias", ALIAS,
    "-keyalg", "RSA",
    "-keysize", "2048",
    "-validity", String(VALIDITY_DAYS),
    "-dname", name,
    `-storepass:env`, PW_VAR,
    `-keypass:env`, PW_VAR,
  ],
  {
    // Only this child sees it, and only for as long as it runs.
    env: { ...process.env, [PW_VAR]: password },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

if (result.status !== 0) {
  // result.error means the process never started; a non-zero status means
  // keytool ran and rejected the request. Those need different advice, and
  // conflating them is what made the original failure misleading.
  if (result.error) {
    console.error(`Could not run ${keytool}: ${result.error.code || result.error.message}`);
  } else {
    console.error(
      `keytool exited with status ${result.status}. Its own message is above.\n` +
        `If it complained about the password, the two entries did not match — ` +
        `and note that a minimum of 6 characters is required.`,
    );
  }
  process.exit(result.status ?? 1);
}

copyFileSync(example, propsFile);
const filled = propsFile;
// Fill in the real values. Written with restrictive permissions on POSIX
// because the file now holds a password in plaintext.
writeFileSync(
  filled,
  `# Generated by scripts/make-keystore.mjs. Gitignored — do not commit.\n` +
    `storeFile=mwn-upload.jks\n` +
    `storePassword=${password}\n` +
    `keyAlias=${ALIAS}\n` +
    `keyPassword=${password}\n`,
);
try {
  const { chmodSync } = await import("node:fs");
  chmodSync(filled, 0o600);
} catch {
  /* not supported on Windows; the file is ACL-protected by NTFS instead */
}

console.log(`
Created ${keystore}
Created ${propsFile}

Both are gitignored. Back the .jks up somewhere you will not lose it — a
lost upload key is recoverable through Play Console, but it is a form and a
wait, and you will not be able to upload in the meantime.

The certificate SHA-256 fingerprint, which is what you paste into Play Console:
`);

const fp = spawnSync(
  keytool,
  ["-list", "-v", "-keystore", keystore, "-alias", ALIAS, `-storepass:env`, PW_VAR],
  { env: { ...process.env, [PW_VAR]: password }, encoding: "utf8" },
);
const line = (fp.stdout || "").split("\n").find((l) => l.includes("SHA256:"));
console.log(line ? line.trim() : "(run keytool -list -v to print it)");
