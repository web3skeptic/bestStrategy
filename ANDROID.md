# Android app

The Android version of Tactical Tribes, built with Capacitor 8 from the same app build as the iPhone version
(see IOS.md). The game is bundled inside the APK, so single-player and pass-and-play work offline.
Online play connects to `wss://interslavic.space/game-upgradable/ws`, together with web and iPhone players.

## Build an APK

Requirements: JDK 21 and the Android SDK (platform 36). `android/local.properties` points Gradle at the SDK
(`sdk.dir=…`). It is created by Capacitor and not committed.

```bash
npm ci
npm run build:android                      # builds dist-app/ and copies it into android/
JAVA_HOME=/path/to/jdk-21 npm run android:apk
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.
It's a debug build, signed with the local debug key. You can install it by sideloading
(`adb install app-debug.apk`, or open the file on a phone with "install unknown apps" allowed).
It can't go on Google Play.

`npm run android:open` opens the project in Android Studio.

## For Google Play

Play needs a release build signed with your own upload key. Use an Android App Bundle (`.aab`):

1. Create an upload key once and keep it safe, outside the repo:
   `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
2. In Android Studio choose Build → Generate Signed App Bundle / APK and pick that key.
   You can also add a `signingConfigs.release` block to `android/app/build.gradle` that reads the key from
   environment variables, then run `./gradlew bundleRelease`.
3. Raise `versionCode` in `android/app/build.gradle` for every upload.

## How the Android shell is set up

- `MainActivity.java`: immersive full screen (status and navigation bars hidden; swipe from an edge to show them).
- `capacitor.config.ts`: dark background, no mixed content. SystemBars reports the camera-cutout inset as
  `--safe-area-inset-*` CSS variables. The app build makes the game's CSS read them (see `vite.config.ts`).
- Icons (legacy, round and adaptive) and splash images are made from the game's warrior art.
  The adaptive-icon master is in `ios-assets/android/`.
- App id `space.interslavic.tacticaltribes`, minSdk 24 (Android 7), targetSdk 36.

## Performance on phones

Measured on an Android 16 emulator (Pixel-class screen, 411×914 CSS px at 2.625×), before and after the
mobile performance pass:

| | Before | After |
|---|---|---|
| Menu frame rate | 48.7 fps, worst frame 67 ms | 60 fps, worst frame 17 ms |
| Menu draw calls per frame | 1,441 | 112 |
| Menu pixels rendered | 822×1828 | 513×1142 |
| Board rendering while the menu is open | full speed, behind the menu | paused |
| Board draw calls | 294 | 166 |
| Board redraws while idle | 60 per second | ~20 per second (full speed while anything moves) |

What changed (`src/perfProfile.ts`, `src/menuScene.ts`, `src/renderer3d.ts`, `index.html`):

- Touch devices render the 3D scene at a capped resolution: 1.5× for the board and 1.25× for the menu backdrop.
  Budget phones get 1.25× for both. The interface itself is HTML and stays sharp.
- The menu's static board and each menu unit are merged into a few meshes (colour-only differences become
  vertex colours). The menu draws at 30 fps on phones, and its shadows refresh a few times a second.
- The board stops drawing while the menu covers it. It drops to about 20 fps when nothing moves and the
  player isn't touching it, and it redraws shadows only when something changes.
- Phones skip CSS `backdrop-filter` blur (19 panels re-blurred the animated board every frame).
- Buttons: no tap highlight or double-tap delay, press feedback on touch, and the Continue card no longer wraps.

Debug readouts in the page console: `__menuPerf()` and `__perf()` give draw calls, triangles, render size and
frames drawn.
