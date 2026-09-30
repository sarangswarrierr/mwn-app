# The MWN Android app.

A Capacitor shell around the MWN web app. The web app's source lives in its own
repository (github.com/sarangswarrierr/MWN); this repository holds the native
project and the **built** web bundle it packages.

## Why the bundle is committed

`webDir` is `web/`, a directory of built HTML/JS/CSS that is checked in. That
makes this repository buildable on its own: clone, install, `npm run apk`, and
you have an APK. A new machine needs no second checkout and no working copy of
the web app to produce one.

The alternative — pointing `webDir` at a sibling checkout — makes the two
repositories useless apart, which means a CI runner or a collaborator has to
reproduce your entire folder layout before they can build anything.

`web/` is a build artifact. Never hand-edit it; change the web app's source
there and re-run `npm run bundle`.

## Requirements

| Tool | Version | Why |
| --- | --- | --- |
| Node | 22+ | Capacitor 8 CLI |
| JDK | 21 | Android Gradle Plugin 8.13 |
| Android SDK | Platform 36, Build-Tools 36 | `targetSdk` must be 36 to be accepted by Google Play from 31 Aug 2026 |

`JAVA_HOME` must point at the JDK, and `android/local.properties` must point at
the SDK using **forward slashes**. A backslash path makes the Android Gradle
Plugin fail with `java.io.IOException: The filename, directory name, or volume
label syntax is incorrect`, which reads like a corrupt download rather than a
path separator.

## Build

```bash
npm install
npm run apk
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

To install on a connected phone:

```bash
npm run install-device
```

`npm run open` opens the project in Android Studio, which is what you want for
a release build or for reading Logcat.

## Updating the app when the web app changes

The web app is a separate repository, so this is a deliberate two-step sync
rather than something a build script can discover on its own.

```bash
# 1. in a checkout of the web app, produce a fresh build
cd ../MWN && npm install && npm run build

# 2. here, copy it in and rebuild
cd ../mwn-android
npm run bundle          # copies ../MWN/dist into web/, minus the dead weight
npm run apk
```

`npm run bundle` is what keeps `web/` honest. It copies the web app's `dist/`
and drops three things that Vite copies but nothing loads:

- `Images/` — 52 poster JPEGs, 4.6 MB, unreferenced. Posters come from TMDB
  at runtime; these predate that and are still sitting in `public/`.
- `logo.png` and `favicon.png` — the 2000×2000 source artwork, 1.7 MB between
  them. The app loads the generated `logo-512.png` and `favicon-*.png`.

That takes the bundle from about 7 MB to about 80 KB, and the APK with it.

If the web app is not checked out next door, pass a path:

```bash
npm run bundle -- --from D:\somewhere\MWN\dist
```

## Layout

- `web/` — the committed web build. The app's entire UI.
- `capacitor.config.json` — `webDir: web`, `androidScheme: https`, so the
  WebView origin is `https://localhost`.
- `android/` — the native project. Gradle, the manifest, the icons, the deep
  link. `MainActivity` is five lines; all it does is host a WebView.
- `scripts/bundle.mjs` — copies a web build into `web/`, see above.
- `scripts/icon-background.mjs` — repaints the adaptive-icon background to the
  app's `#0B1226`; `@capacitor/assets` defaults to white, which reads as a
  white square on a dark home screen.
- `scripts/install-device.mjs` — resolves `adb` from `ANDROID_HOME` rather than
  trusting `PATH`, and explains the "plug in a phone" failure instead of
  reporting a broken APK.
- `.gitignore` — excludes the Gradle tree and, importantly, `*.jks` and
  `*.keystore`.

## Native behaviour

The web app integrates through `src/lib/native.js` in the **web app's**
repository. It reads the `Capacitor` global this shell injects and no-ops in a
browser, so the same source runs in both places with no build flag.

- **Back button.** Closes the topmost overlay; with nothing open it returns
  false, which lets Android move the task to the back.
- **Password recovery.** Supabase sends the reset link to `mwn://reset`, which
  the second `intent-filter` in `android/app/src/main/AndroidManifest.xml`
  claims. It returns through `appUrlOpen` and `useAuth` redeems the fragment
  with `setSession`. Add `mwn://reset` under Supabase → Authentication → URL
  Configuration → Redirect URLs, or a recovery mail links nowhere.
- **Safe areas.** `viewport-fit=cover` plus the `--safe-*` variables in the web
  app's `theme.css`.

## Signing

```bash
npm run keystore
```

Generates `android/mwn-upload.jks` — Play's *upload key*, the one you keep —
plus `android/keystore.properties`, and prints the SHA-256 fingerprint that Play
Console asks for. Both are gitignored. The password is prompted for with echo
off and handed to keytool through an environment variable, so it appears neither
on screen nor in a process list.

Validity is 27 years, past Google's October 2033 requirement. **Back the `.jks`
up somewhere durable.** Because Play App Signing keeps the *app signing* key
itself, a lost upload key is recoverable through Play Console — but it costs a
form and a wait, and you cannot upload in the meantime.

`npm run verify:keystore` exercises the whole flow with a throwaway password and
deletes what it makes, so it can be tested after a change or on a new machine
without committing to a password.

### If keytool cannot be found

`scripts/find-tools.mjs` probes for a real `keytool` executable rather than
trusting `JAVA_HOME`, and falls back to the conventional install roots. This
matters because a terminal opened *before* the JDK was installed keeps the
environment it launched with, so `JAVA_HOME` is empty and `keytool` is not on
`PATH` in that one window while the same command works in a new one. When
nothing is found, the error lists every path that was tried.
`install-device.mjs` resolves the SDK the same way.

## Sharing a build without the Play Store

```bash
npm run apk:release
```

`android/app/build/outputs/apk/release/app-release.apk`, around 4 MB, signed
with the real key. Note that `npm run release` builds an **AAB**, which only
Play Console accepts — nobody can install an AAB directly, so use `apk:release`
for this.

Send the file however you like: Drive, Telegram, email. Each recipient installs
it from whatever app they downloaded it with and allows that app to "Install
unknown apps" once. Android warns on sideloaded apps; that is the platform, not
a defect. **Requires Android 7.0 or newer** (minSdk 24).

Two things worth knowing before the first person tries:

- **A device that already has the debug-signed build must uninstall first.**
  Android refuses to replace an app whose signature changed, and the resulting
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE` reads like a broken file rather than a
  signature mismatch. Everyone who installs the real key from here on can
  receive future updates in place.
- **The TMDB key is inside the APK.** The app calls TMDB directly, so the key
  ships with it and anyone who unzips the APK can read it. The same trade the
  web build already makes, and fine for a handful of people you know — but
  rotate the key in TMDB and rebuild if this goes wider than people you would
  hand a password to.

For a stable link rather than a file, Firebase App Distribution does this free
for up to 100 testers and never creates a Play listing. It re-signs uploads with
its own test certificate, so anyone already on your key would have to uninstall
first — worth doing now rather than later if you want it.

## Publishing to Google Play

### One-time setup

**1. A Play developer account.** $25 one-off, at
[play.google.com/console](https://play.google.com/console). Verification by
email; a personal account is instant.

**2. The upload key**, from `npm run keystore` above. Create the app in Play
Console (All apps → Create app): name, language, Free, and the declarations.
Once the app exists, upload your first bundle to the internal track; Play shows
the app signing setup then, and you can leave Play to generate the signing key.

**3. Create the app in Play Console** (All apps → Create app). Name, language,
Free, and the declarations. Once the app exists, upload your first bundle to
the internal track; Play shows the app signing setup then, and you can leave
Play to generate the signing key.

### Uploading

```bash
npm run version -- patch     # 1.0.0 -> 1.0.1, versionCode 1 -> 2
npm run bundle               # refresh web/ from the web app
npm run release              # -> android/app/build/outputs/bundle/release/app-release.aab
```

Then Play Console → your app → **Testing → Internal testing → Create new
release** → upload the `.aab`. (An **app bundle** is required, not an APK —
Play builds the per-device APKs itself.)

The bundle is currently signed with the debug key, which Play rejects. `npm run
keystore` fixes that; until you do, `npm run release` prints a warning saying
so.

### The 12-tester rule

If your Play account is a **personal** one created after 13 November 2023, you
cannot publish straight to production. You must first run a **closed test**
with at least **12 testers opted in continuously for 14 days**, then answer
Play's questionnaire to apply for production access. Plan for 14–17 days, and
recruit 15–16 testers so one dropout does not push the date out.

A personal account created *before* that date, or an organisation account, is
exempt. Play Console shows which applies on the app dashboard — trust that over
any blog.

Internal testing is separate and unlimited (100 testers), so use it freely for
quick checks; it does not count toward the 12.

## Version updates

Play requires `versionCode` to **strictly increase** with every upload, and
rejects anything at or below the highest it has already seen. That number lives
in one place, `android/version.properties`, and `npm run version` is the only
thing that should change it:

```bash
npm run version            # show it
npm run version -- patch   # 1.0.0 -> 1.0.1
npm run version -- minor   # 1.0.0 -> 1.1.0
npm run version -- major   # 1.0.0 -> 2.0.0
npm run version -- 3.2.1   # set exactly
```

`versionCode` increments on every call, including when you set an explicit
version name. Re-asking for the version you are already on is a no-op, because
a `versionCode` is a one-shot resource against Play's ceiling of 2,100,000,000.

### The full loop when the web app changes

```bash
cd ../MWN && npm run build        # 1. the web app repo
cd ../mwn-android
npm run bundle                    # 2. copy the fresh build into web/
npm run version -- patch          # 3. bump
npm run release                   # 4. build the bundle
git add -A && git commit -m "..." # 5. commit web/ and version.properties together
git push
```

Then upload the new `.aab` in Play Console. **Commit `web/` and
`version.properties` in the same commit** — a commit that bumps the version
without the new bundle produces an identical app under a new number, which Play
accepts and users see as a pointless update.

Rolling out gradually: in Play Console, Production → the release → Edit →
rollout percentage. Start at 10% and watch the crash reports before going to
100%.
