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
