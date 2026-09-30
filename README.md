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

## Release signing

Not set up yet. The debug APK is signed with an auto-generated key, which is
fine for sideloading and useless for Play.

```bash
keytool -genkey -v -keystore mwn-upload.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias mwn
```

Then add a `signingConfigs.release` block to `android/app/build.gradle`. Keep
the `.jks` out of git and store it somewhere you will not lose it — Play ties
the listing to that key for the lifetime of the app.
