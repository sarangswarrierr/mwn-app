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
// So on a pipe: one listener for the whole run, lines split out as they arrive
// and queued, and a prompt takes from the queue or waits on it. Nothing is
// registered late, so nothing is missed.
//
// On a terminal the queue is not used at all, and that is the important half of
// this. A TTY is a byte stream, not a stream of lines: there is no line until
// the user presses Enter, and setRawMode turns off the terminal's own line
// buffering so echo can be suppressed. If the queue listener were also attached,
// it would see every keystroke of the password — arriving in the same chunks,
// with no newline between them — and hold them in `buffer`. The next prompt
// would then read the password out of that buffer instead of what the user
// typed, which is how the password ended up being used as the certificate
// subject. So: a TTY gets exactly one listener at a time, attached by whoever is
// currently prompting, and no shared buffer.
//
// Echo suppression needs setRawMode, which does not exist off a terminal, hence
// the two paths.

// --- the pipe path: queue completed lines, and hand them to whoever asks ------
//
// Only attached when stdin is not a terminal. See the note above readLine: on a
// TTY this must not exist, or it would compete with the prompt's own listener.
const queue = [];
const waiting = [];
let buffer = "";

// Splits whatever has arrived so far into lines. A partial trailing line stays in
// `buffer` until the rest of it turns up, so a value split across two chunks is
// still read as one line.
const drain = () => {
  let at;
  while ((at = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, at).replace(/\r$/, "");
    buffer = buffer.slice(at + 1);
    if (waiting.length) waiting.shift()(line);
    else queue.push(line);
  }
};

if (!process.stdin.isTTY) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    drain();
  });
  process.stdin.resume();
}

const nextLine = () =>
  new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    waiting.push(resolve);
  });

// Reads one line from a terminal, with `echo` deciding whether it is typed back
// out. setRawMode stops the terminal buffering the line itself, which is what
// makes suppressing echo possible; backspace then has to be applied by hand for
// the same reason.
//
// Exactly one of these listeners exists at a time. That is the whole point: a
// second one would see the same keystrokes, and a shared listener would hand the
// next prompt the previous prompt's characters.
// Set by a CR so the LF of the same CRLF pair is dropped. Module-level because
// the LF arrives after the prompt that produced the CR has already resolved —
// that is the whole point, and a per-prompt variable would go out of scope first.
let skipNewline = false;

const readLine = (prompt, { echo }) => {
  process.stdout.write(prompt);

  if (!process.stdin.isTTY) return nextLine().then((l) => l.trim());

  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    let value = "";
    // Set when a keystroke ends the line, so a chunk carrying more characters
    // stops being applied once the line is done.
    let finished = 0;

    const finish = (arg) => {
      if (finished) return;
      finished++;
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      process.stdout.write("\n");
      resolve(arg);
    };

    // Handles one character. A terminal delivers a *stream* of keystrokes and
    // Node hands them over in whatever chunks the OS produced, so a chunk is
    // routinely more than one character — Enter on Windows is "\r\n" in a single
    // read. Testing the chunk as a whole is why that pair would be typed into the
    // value instead of ending the line.
    const handle = (ch) => {
      if (ch === "\r") {
        // Enter is CRLF on Windows. The CR ends the line; the LF that follows is
        // still in stdin and would otherwise complete the *next* prompt with an
        // empty answer, so pressing Enter for a default silently skips a prompt.
        // Swallow exactly one trailing newline and nothing else — an earlier
        // attempt dropped every leading newline instead, which meant pressing
        // Enter at an empty prompt never resolved at all.
        skipNewline = true;
        return finish(value.trim());
      }
      if (ch === "\n") {
        // The LF half of a CR that was already handled. Bare LF (a Unix
        // terminal) ends the line normally.
        if (skipNewline) return;
        return finish(value.trim());
      }
      if (ch === "\u0004") return finish(value.trim()); // Ctrl-D
      if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
        if (echo) process.stdout.write("\b \b");
        return;
      }
      if (ch === "\u0003") return finish(""); // Ctrl-C: give up on the value
      // Escape, and the two bytes application-mode cursor keys arrive as.
      if (ch === "\u001b" || ch === "+" || ch === "e" || ch === "[") return;
      value += ch;
      if (echo) process.stdout.write(ch);
    };

    const onData = (chunk) => {
      // Stop at the character that ended the line; the rest belongs to no prompt.
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length && !finished; i++) handle(text[i]);
    };
    stdin.on("data", onData);
    stdin.resume();
  });
};

const ask = (prompt) => readLine(prompt, { echo: true });

// A password is never echoed, so it cannot end up in a screenshot or a screen
// share. keytool then receives it over an environment variable, so it is not in
// argv either.
const readSecret = (prompt) => readLine(prompt, { echo: false });

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
