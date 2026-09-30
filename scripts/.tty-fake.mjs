// Fake terminal, for scripts/verify-keystore-tty.mjs to run make-keystore
// against. Faithful where it matters: isTTY true, a setRawMode that records its
// calls, and keystrokes emitted one byte at a time with no newline between them,
// which is what a terminal delivers in raw mode.
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

// Held before process.stdout is replaced below, so the runner can still print
// its findings to the terminal the test is actually attached to.
const realStdout = process.stdout;

const rawModeCalls = [];
const typed = [];

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setEncoding = () => {};
stdin.resume = () => {};
stdin.pause = () => {};
stdin.setRawMode = (on) => {
  rawModeCalls.push(!!on);
  stdin.isRaw = !!on;
};

// A real TTY is a stream, not an event source: bytes that arrive while no
// listener is attached stay buffered until one is. An EventEmitter with no
// listeners drops them, which would silently lose a keystroke here — the final
// prompt's Enter, for one, and the run would then hang waiting for an answer
// that was never delivered. Parking them and replaying them to the next
// listener reproduces the buffering a terminal actually provides.
let parked = [];
const realEmit = stdin.emit.bind(stdin);
stdin.emit = (event, ...args) => {
  if (event !== "data") return realEmit(event, ...args);
  if (stdin.listenerCount("data") === 0) {
    parked.push(args[0]);
    return true;
  }
  return realEmit(event, ...args);
};
const originalOn = stdin.on.bind(stdin);
stdin.on = (event, listener) => {
  const r = originalOn(event, listener);
  if (event === "data" && parked.length) {
    const queued = parked;
    parked = [];
    process.nextTick(() => {
      for (const chunk of queued) realEmit("data", chunk);
    });
  }
  return r;
};

const written = [];
const stdout = new Writable({
  write(chunk, _enc, cb) {
    written.push(chunk.toString());
    cb();
  },
});
stdout.isTTY = true;

Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
Object.defineProperty(process, "stderr", { value: stdout, configurable: true });

// setImmediate runs in the check phase, after the microtask queue and after
// I/O callbacks, so a promise resolved by stdin "data" has certainly settled by
// the time the loop looks again. A setTimeout(0) would be the same; a bare
// await would not.
const tick = () => new Promise((r) => setImmediate(r));

// Type each answer as its prompt appears, one byte at a time. Resolves once
// every prompt is answered and the script has printed one of its own final
// lines.
//
// Only the fake's own content can be used to detect that. keytool is spawned
// with stdio "inherit", so the child writes to the real fd 1 and its output
// never reaches the fake — looking for "[Storing " here would wait forever.
const FINISHED = [
  "SHA256:",          // success: the fingerprint it prints last
  "keytool exited",   // failure
  "RUNNER ERROR",     // the script under test threw
  "already exists",   // refused to run
];

export async function answerPrompts(prompts, answers) {
  let next = 0;
  // Bounded, so a mistake in the fake can never hang a test run.
  const deadline = Date.now() + 20_000;

  for (;;) {
    if (Date.now() > deadline) return;
    await tick();

    const out = written.join("");
    if (next >= prompts.length) {
      if (FINISHED.some((marker) => out.includes(marker))) return;
      continue;
    }
    if (out.includes(prompts[next])) {
      const value = answers[next] ?? "";
      typed.push(value);
      for (const ch of value) {
        stdin.emit("data", Buffer.from(ch, "utf8"));
        await tick();
      }
      // CRLF, because that is what Enter produces on Windows. Sending "\r"
      // alone would quietly neuter this test: the line splitter in the script
      // completes a line on "\n", so a lone "\r" never produces a line and the
      // shared-buffer bug being tested for could not occur.
      //
      // One byte at a time, not "\r\n" in a single chunk, because a real
      // terminal's two bytes are separate reads. Batching them exercises the
      // script's multi-character-chunk path instead of the one a person hits.
      stdin.emit("data", Buffer.from("\r", "utf8"));
      await tick();
      stdin.emit("data", Buffer.from("\n", "utf8"));
      next++;
    }
  }
}

export const output = () => written.join("");
export const rawMode = () => rawModeCalls.slice();
export const typedValues = () => typed.slice();

// Writes to the real stdout, bypassing the fake the script under test writes to.
export const emit = (s) => realStdout.write(s);
