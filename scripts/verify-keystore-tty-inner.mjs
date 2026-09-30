// Inner runner: answers make-keystore.mjs's prompts through the fake TTY and
// prints a report. Driven by verify-keystore-tty.mjs.
import { answerPrompts, output, typedValues, rawMode, emit } from "./.tty-fake.mjs";

const PASSWORD = process.env.TEST_PASSWORD || "hunter2-tty-secret";

// The report has to be emitted even when the script under test calls
// process.exit() — which it does when a keystore already exists, and that is
// exactly the state a previous failed run leaves behind. Without this the
// harness dies silently and the failure looks like "no report".
process.on("exit", () => {
  const out = output();
  emit(
    "REPORT:" +
      JSON.stringify({
        // The bug: the certificate prompt used to read the password back out of
        // the shared buffer, so the subject keytool received was the password.
        subjectIsPassword: (typedValues()[2] || "").includes(PASSWORD),
        // A secret must never be echoed to the screen.
        printedPassword: out.includes(PASSWORD),
        typed: typedValues(),
        rawModeCalls: rawMode(),
      }) +
      "\n",
  );
});

const done = answerPrompts(
  ["Password for", "Confirm:", "Certificate name"],
  [PASSWORD, PASSWORD, ""],
);
try {
  await import("./make-keystore.mjs");
} catch (e) {
  emit("RUNNER ERROR: " + e.message + "\n");
}
await done;
