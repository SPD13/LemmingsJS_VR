# Lemmix VR as a standalone Steam Frame APK (Wolvic kiosk fork via Lepton)

## Context

Steam Frame runs SteamOS on ARM64 and accepts three standalone formats: native Linux ARM64, x86 via FEX/Proton, and Android APKs via Lepton (Valve's Waydroid fork). No Linux browser supports WebXR, so the existing WebXR game cannot run immersively on the Frame as a website or as an Electron app. The only route that reuses the whole existing codebase is an Android APK that embeds a WebXR-capable browser engine and boots straight into the game. Wolvic (Igalia's open-source XR browser, Gecko backend, OpenXR) has a kiosk mode and an `aosp` flavor that uses the generic Khronos OpenXR loader, which is what Lepton would have to expose.

Decisions taken with the user:
- **Bundle the site in the APK**, served from an embedded localhost HTTP server (offline, stable IndexedDB origin, service worker works on localhost). NeoLemmix assets are never bundled (copyright); the user still downloads them from neolemmix.com inside the app.
- **Gecko backend** (Wolvic default). Chromium backend is out of scope.
- **Steam store from the start**: Steamworks Android depot is first-class work, not optional.
- **Test hardware: PSVR2 on PC only.** No Android headset. So immersive testing of the Wolvic build happens only on the Frame; everything else is verified on desktop (dev host, Chrome + SteamVR for WebXR) and on an Android phone/emulator with Wolvic's `noapi` flavor.

- **LAN launcher mode**: when the Electron launcher runs on a computer on the same network, the app must find it and run in **server mode**, serving pages, NeoLemmix assets and levels from that computer (one install for the house, saves of tagging/config land on the computer). Without a launcher the app runs the bundled site in static mode.

Gating unknown: nothing published says which OpenXR runtime the Khronos Android loader finds inside Lepton. Valve's stated Quest-APK support implies one exists. The plan front-loads a cheap probe and defers the expensive engine build until that probe passes.

Findings that shape the design (verified against upstream Wolvic docs/code):
1. **Prebuilt Maven GeckoView has no WebXR.** Wolvic README: "By default Wolvic will try to download prebuilt GeckoView libraries from Mozilla's maven repositories, where WebXR won't work." A WebXR-capable fork build requires a one-off GeckoView build with patches from `Igalia/wolvic-gecko-patches` (1-3 h, ~40 GB). Official APKs at https://wolvic.com/dl/ do have WebXR and are the probe vehicle.
2. **Wolvic kiosk mode opens a private session** (`Windows.openInKioskMode()` → `createSuspendedSession(uri, /*private*/ true)`). Private mode disables service workers and does not persist IndexedDB, which kills static asset mode. The fork must pass `false`.
3. **Steam/Lepton launches the main activity with no extras.** Kiosk + URL must come from `BuildConfig`, not the `wolvic://` intent that `VRBrowserActivity.loadFromIntent()` parses.
4. **IndexedDB origin includes the port.** The embedded server must bind a fixed port on 127.0.0.1 (chosen: 17431).
5. **`await s.persist()` in setup.js** (`installUnit`, `installLevelZip`, `installFolder`, `installClassic`) triggers Gecko's persistent-storage prompt, which kiosk UI may hide → install hangs. Needs a page-side timeout and a fork-side auto-grant.
6. **`vfs.js` treats `{launcher:true}` from `health.json` as server mode.** The embedded server must not answer `/health.json`; it advertises under `/_lemmix/health.json` so the game stays in static mode.
7. **The launcher is discoverable only by address today.** `launcher/main.js` picks the first non-internal IPv4 (main.js:104-108), serves HTTPS with a self-signed cert whose SANs are `localhost` + that LAN IP (main.js:51-92, regenerated when the IP changes), and `server.js` listens on 0.0.0.0 (server.js:318). No mDNS or broadcast. The page side already handles a launcher: `health.json` → `{launcher:true}` selects server mode (vfs.js:378), the setup page shows the mode switch when a launcher answered (setup.js:844-856), and `ConfigStore.sync` keeps config on the launcher (setup.js:829-840).
8. **Lepton is a Waydroid container behind NAT** (container subnet is not the LAN). Multicast/broadcast discovery may not cross into it, so discovery needs unicast fallbacks and a manual address entry. The Android emulator has the same shape (guest sees the host as 10.0.2.2), which makes it a faithful test of that path.
9. **Gecko cannot be made to accept the launcher's self-signed cert from a kiosk.** Pointing Wolvic straight at `https://<lan-ip>:8123` would hit a certificate page kiosk mode hides, and plain HTTP is not a secure context (no WebXR). Hence the reverse proxy below: the browser only ever talks to `http://127.0.0.1:17431`; the host trusts the launcher's cert natively by pinned fingerprint.
10. **Valve custom-engine docs**: APKs target Android 10; controllers appear as Oculus Touch by default; a "Steam Frame Controller" OpenXR interaction profile exists. vr.js uses xr-standard indices 0/1/3/4/5 (3d/js/vr.js:72-74), which match Oculus Touch; no page change expected.

## Architecture

```
APK us.spd13.lemmix  (Wolvic fork, flavor aospArm64GeckoLemmix)
├── Wolvic app (kiosk from BuildConfig, persistent session, auto-grant storage)
└── :lemmixhost  (Kotlin lib, NanoHTTPD on http://127.0.0.1:17431/)
    ├── /  (no launcher selected)  → bundled site from assets/site/ (copied by android/bundle.js);
    │                                /health.json → 404 so the page picks static mode
    ├── /  (launcher selected)     → reverse proxy of EVERYTHING to https://<launcher>:<port>
    │                                (pages, neolemmix/, levels/, health.json, /upload, config PUT,
    │                                profile POST, DELETE) with the launcher's cert pinned by fingerprint;
    │                                the page sees {launcher:true} and runs in server mode unchanged
    ├── /_lemmix/health.json   {embedded, version, proxy, config, launcher:{selected,reachable}, platform}
    ├── /_lemmix/launcher      GET candidates/status; POST select | clear | scan | add {host,port}
    ├── /_lemmix/fetch?url=    same-origin proxy to neolemmix.com (static mode installs)
    ├── /_lemmix/config/<name> GET/PUT the three config JSONs → externalFilesDir (Steam Cloud)
    └── /_lemmix/log           POST → logcat (page errors)
Launcher (LemmingsJS launcher/): advertises _lemmix._tcp via mDNS and answers a UDP discovery
probe (broadcast or unicast) with {name, port, https, version, certFingerprint}.
Discovery in the host: mDNS (NsdManager) + UDP broadcast + unicast probe of remembered
addresses and of the local /24 + manual entry on the setup page. Remembered launcher is
probed at startup (1.5 s deadline) before the first page is served, so a house with a
running launcher boots straight into server mode.
Page side: asset-mode logic unchanged; setup.js detects Vfs.embedded, gains a "Launcher on
this network" section, and downloads zips through the proxy in static mode.
```

Why proxy everything rather than only assets: the launcher is the single source of truth in server mode today (pages, indexes built live, config and profile saves), and a headset opening the launcher URL gets exactly that. Proxying all paths reproduces it with one origin and no certificate UI. IndexedDB stays under the same origin in both modes, and vfs.js already persists whichever mode is in force.

Rejected: porting `launcher/server.js` server mode to Kotlin (drags in /upload, index builders, config routes; static mode already works on headsets). Rejected: two-APK launcher (Steam launches one APK).

## Phases

Order is driven by the lack of an Android headset: do all desktop/emulator-verifiable work first, probe the Frame the day it arrives, and only then pay for the Gecko build.

### Phase 1 — Web app changes in LemmingsJS (desktop-verifiable now)

Modify:
- `3d/js/vfs.js`: add `fetchEmbedded(root)` mirroring `fetchHealth` (vfs.js:340-347) against `_lemmix/health.json`; call it in the mode resolution next to `fetchHealth` (vfs.js:376-379); expose `Vfs.embedded` (null or the capabilities object). Mode logic untouched.
- `3d/js/setup.js`:
  - `fetchViaProxy(url, kind)`: stream `response.body` through the existing `progress()` bar, build a `File` (name from `X-Lemmix-Filename` header or the known official name, since `installUnit` derives the NeoLemmix version from the filename), then call the existing `installZip(file, kind)`.
  - In `main()` (setup.js ~872-890): when `Vfs.embedded?.proxy`, relabel `btn-get-engine/styles/packs` to "download and install" and route to `fetchViaProxy`; demote the `btn-zip-*` file inputs; rewrite the `.dim` help text for the embedded case. Replace `window.open` calls (setup.js:877, 887) in embedded mode.
  - Wrap every `s.persist()` in a 3 s `Promise.race` timeout (finding 5).
  - Config section: when `Vfs.embedded?.config`, "download" → `PUT /_lemmix/config/<name>` and "upload" → `GET` then the existing `importControls/Prefs/Progress(text)`; reuse the names in `config-store.js:37-41`. Update the `config-where` copy.
  - `renderCredits` (~808) and header links: plain text, no `target=_blank` in embedded mode.
- `3d/js/app.js`: footer (~2200-2213) shows `static (embedded)`; hide `#ed-help` link (index.html:372) when embedded; optional `window.onerror` → `POST /_lemmix/log`.
- `builder/version.js`: add a MARKERS entry (version.js:21-27) for `android/version.properties` (`versionName=`). builder/ is local/gitignored; the properties file is committed.
- **Launcher discovery** (`launcher/`):
  - New `launcher/discovery.js`: (1) mDNS/DNS-SD advertisement `_lemmix._tcp` with TXT `port`, `https`, `version`, `fp` (SHA-256 of the cert DER), `name` (hostname), via the pure-JS `bonjour-service` package; (2) UDP responder on a fixed port (e.g. 18123) answering the datagram `LEMMIX-DISCOVER` with a JSON reply of the same fields, to both broadcast and unicast senders. Started/stopped with the server in `main.js` (server start/stop path around main.js:138) and in `server.js` standalone mode; re-advertised when the cert regenerates (fingerprint changes).
  - `launcher/main.js` + `launcher/renderer`: Server tab shows "advertising as <name>" and the UDP port; Setup tab gets an "advertise on the network" toggle persisted with `port`/`https`.
  - `launcher/README.md`: document discovery and the threat model (LAN-only, unauthenticated, cert fingerprint learned from the reply).
- **Setup page launcher section** (`3d/js/setup.js`, `setup.html`): visible only when `Vfs.embedded`. Lists candidates from `GET /_lemmix/launcher` (name, address, version, reachable), a "use this launcher" button per row (`POST select` then `location.reload()`, after which `health.json` answers and the existing mode code shows server mode), a "scan again" button, a manual `host:port` field (`POST add`), and "use this device only" (`POST clear` + reload). The existing mode switch (setup.js:844-856) needs no change.
- `3d/js/app.js` footer: in embedded mode append the launcher name when proxied (`static (embedded)` vs `server (launcher: <name>)`).

Create:
- `android/version.properties` — `versionName=1.0.0`.
- `android/bundle.js` — allowlist copy of the site into a target dir: `index.html setup.html galleries.html classic.html sw.js version.json config.json site.webmanifest 3d/index.html 3d/js 3d/lib 3d/profiles js lemmix tools/levels-index.js tools/styles-index.js css img`; writes `site-manifest.json` (path, size, mime); hard-fails if anything under `levels/` or `neolemmix/` other than README.md would be copied.
- `android/dev-host.js` — Node stub reproducing the embedded server contract: static root, `/_lemmix/*` including the launcher API, does **not** answer `/health.json` unless a launcher is selected, and then reverse-proxies everything to it (accepting its self-signed cert by fingerprint); UDP + mDNS discovery client. Reuse the MIME table from `launcher/server.js`. Lets all of the above be tested in desktop Firefox/Chrome and in PSVR2 via Chrome + SteamVR, with the launcher on the same Mac or a second machine.
- `android/README.md`; a "Steam Frame / Android" section in `README.md` and `setup.md`.

Verify: `node android/dev-host.js` → setup page shows embedded buttons; NeoLemmix + styles + a level pack install through the proxy; `levels/index.json` lands in IndexedDB; a level plays; ENTER VR works through Chrome + SteamVR on PSVR2 from the dev host; config save/load round-trips; `bundle.js` refuses a stray file under `levels/`; `node builder/version.js minor` stamps `android/version.properties`.
Launcher path: start the launcher (HTTPS on); the dev host lists it within 2 s via mDNS and via UDP; with mDNS blocked (firewall) the UDP unicast probe of the remembered address still finds it; select it → page reloads, footer reads `server (launcher: <name>)`, levels and styles come from the launcher's folders, an install from the setup page lands in the launcher's `levels/`, a tagging save from the piece editor writes `3d/profiles/` on the launcher machine, config sync hits the launcher's `config/`; stop the launcher → next reload falls back to the bundled site in static mode with the earlier IndexedDB install intact; `?assets=static` while proxied still forces static (pages from the launcher, assets from IndexedDB).

### Phase 2 — Wolvic fork: `:lemmixhost` module, `lemmix` flavor, kiosk patches (emulator/phone-verifiable, Maven GeckoView)

Fork `Igalia/wolvic`, branch `lemmix`, rebased on upstream release tags. Build with the default Maven GeckoView for now (2D only) using the `noapi` platform flavor on an Android phone or arm64 emulator on the Mac.

New module `lemmixhost/` (Kotlin Android library, dependency `org.nanohttpd:nanohttpd:2.3.1`):
- `LemmixServer.kt` — bound to `127.0.0.1:17431`, `SO_REUSEADDR`, `ensureStarted(context)` singleton, `ROOT_URL` constant.
- `AssetSite.kt` — path normalisation (reject `..`), `/` and directories → `index.html`, `Content-Length` from `site-manifest.json`, `Cache-Control: no-cache`, HEAD support (setup.js `fetchOk` uses HEAD), MIME table mirrored from `launcher/server.js` plus `.mjs`/`.wasm`/`.webmanifest`.
- `NeoLemmixProxy.kt` — `GET /_lemmix/fetch?url=`: allowlist `neolemmix.com`/`www.neolemmix.com`, follow redirects (download.php), stream body, forward `Content-Length`, set `X-Lemmix-Filename` from upstream `Content-Disposition`, 502 on failure.
- `ConfigFiles.kt` — `GET/PUT /_lemmix/config/<name>` for the three allowlisted names, stored under `getExternalFilesDir(null)/lemmix-config/` (Steam Cloud AndroidExternalData root).
- `Capabilities.kt` — `/_lemmix/health.json` and `/_lemmix/log`.
- `LauncherDiscovery.kt` — three channels feeding one candidate list: `NsdManager` discovery of `_lemmix._tcp` (resolve → host, port, TXT); UDP `LEMMIX-DISCOVER` broadcast on the fixed port plus unicast probes of remembered addresses (persisted in `SharedPreferences`) and of the device's own /24 (unicast crosses the Waydroid/emulator NAT; broadcast may not); manual `add(host, port)`. Each candidate is confirmed with `GET https://host:port/health.json` accepting only a cert whose SHA-256 matches the advertised `fp` (or, for manual entries with no advertisement, trust-on-first-use with the fingerprint stored). Startup: probe remembered addresses with a 1.5 s deadline before `LemmixServer` starts routing; auto-select if exactly one answers (or the last used one).
- `LauncherProxy.kt` — when a launcher is selected, every request not under `/_lemmix/` is forwarded verbatim (method, path, query, headers minus `Host`, streamed body up to the launcher's 500 MB `/upload` limit) over HTTPS with a per-launcher `SSLSocketFactory` pinned to the fingerprint; response status, headers and body streamed back. On connection failure: 502 with a small HTML page linking to `setup.html`, and after 3 consecutive failures the selection is dropped so the next load serves the bundled site. `WebSocket` is not used by the launcher, so none needed.
- `LauncherApi.kt` — `GET /_lemmix/launcher` → `{selected, reachable, candidates:[{host,port,name,version,https,fp,source}]}`; `POST /_lemmix/launcher` with `{action: "select"|"clear"|"scan"|"add", host, port}`.
- Gradle task `syncSite` running `node ${lemmix.siteDir}/android/bundle.js src/main/assets/site` when `lemmix.siteDir` is set in `local.properties`.

Fork patches in `app/`:
- `settings.gradle`: `include ':lemmixhost'`.
- `app/build.gradle`: in the `store` flavor dimension add `lemmix { applicationId "us.spd13.lemmix"; buildConfigField "boolean","LEMMIX_KIOSK","true" }` (false on the other store flavors); `lemmixImplementation project(':lemmixhost')`; read `versionName` from `${lemmix.siteDir}/android/version.properties`, `versionCode = major*10000 + minor*100 + patch` (must be monotonic for Steam); release signing from Gradle properties outside git.
- `app/src/lemmix/` overlay: app name "Lemmix VR", launcher icon from `img/lemmix_vr_logo.png`, manifest overlay dropping camera/location/microphone permissions.
- `VRBrowserApplication.onCreate()`: `if (BuildConfig.LEMMIX_KIOSK) LemmixServer.ensureStarted(this)`.
- `VRBrowserActivity.loadFromIntent()`: when `LEMMIX_KIOSK`, force `targetUri = ROOT_URL`, kiosk on, hide the WebXR interstitial, on every launch (avoids the sticky-kiosk behaviour from upstream issue #970).
- `ui/widgets/Windows.openInKioskMode()`: `createSuspendedSession(uri, /*private*/ !BuildConfig.LEMMIX_KIOSK)` (finding 2); do not restore old tabs in lemmix builds.
- Permission delegate (verify exact class, `browser/PermissionDelegate.java`): auto-grant persistent storage for origin `http://127.0.0.1:17431`, deny the rest.
- `SettingsStore` defaults for lemmix: homepage = ROOT_URL, onboarding/terms/whats-new pre-accepted, remote debugging on in debug builds (`about:debugging` over adb is the on-device console).
- New-window requests in kiosk: open in the same window or drop.
- `docs/lemmix/BUILD.md` in the fork.

Manifest additions for the lemmix flavor: `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_WIFI_MULTICAST_STATE` (needed for mDNS/broadcast receive on Android), `usesCleartextTraffic` irrelevant (loopback only; the launcher hop is HTTPS).

Verify (phone/emulator, `noapiArm64GeckoLemmixDebug`): cold start lands on the setup page with no Wolvic chrome; proxy install of NeoLemmix + styles + Lemmings Plus completes with no storage prompt; force-stop and relaunch keeps the install and progress (persistent session confirmed); `adb shell am start -n us.spd13.lemmix/com.igalia.wolvic.VRBrowserActivity` with no extras behaves identically (Steam launch shape); `curl` via adb: 404, `..` path rejected, disallowed proxy host → 403; config PUT writes under `Android/data/us.spd13.lemmix/files/lemmix-config/`. VR button reads "VR NOT SUPPORTED" (expected with Maven GeckoView; this is the negative control for Phase 4).
Launcher path: on a phone on the same Wi-Fi the launcher appears via mDNS and via UDP broadcast; in the emulator (NAT, like Lepton) neither multicast channel works and the manual entry `10.0.2.2:8123` is confirmed by fingerprint, selected, remembered, and auto-selected on the next cold start within the 1.5 s deadline; a wrong fingerprint (regenerate the launcher cert) is refused until re-discovered/re-added; while proxied the game plays a level from the launcher's `levels/`, the setup page installs a pack onto the launcher, tagging saves land in the launcher's `3d/profiles/`; kill the launcher → 502 page → after three failures the app boots bundled/static again.

### Phase 3 — Risk probe on the Steam Frame (the day hardware + Lepton are available; no build work)

- **Frame's own browser**: open https://lemmix.spd13.us, record the `#vr-button` label and whether VR enters. Determines whether a no-APK fallback exists.
- **Official Wolvic APKs** from https://wolvic.com/dl/ (these have WebXR): sideload the `aosp` build and the `oculusvr` build into Lepton. For each: does it launch into its 3D home (a runtime was found), does the live site ENTER VR, do controller rays and thumbsticks work, is `local-floor` height sane.
- **Record Lepton facts** over `adb connect`: `getprop ro.build.version.sdk` (aosp flavor needs ≥ 29), OpenXR packages/providers (`pm list packages`, `dumpsys package providers | grep -i openxr`), GL/Vulkan driver (Wolvic needs GLES 3 + `XR_KHR_opengl_es_enable`), whether page `console.log` reaches `adb logcat -s GeckoConsole`.
- **Kiosk + WebXR (#970)**: launch the official APK with `wolvic://com.igalia.wolvic/?kiosk=true&url=https://lemmix.spd13.us` and see whether WebXR goes blank.

Gate: proceed to Phase 4 only if at least one Wolvic flavor enters immersive VR inside Lepton. Otherwise see Fallbacks.

### Phase 4 — Engine build and Frame bring-up

- **GeckoView build** (one-off, Linux box or the Mac; Igalia CI uses Linux): pin Gecko to the fork's Wolvic tag (wiki lists the pairing, e.g. Wolvic 1.9.x ↔ Gecko 153), apply `Igalia/wolvic-gecko-patches`, mozconfig for `mobile/android` aarch64 optimized, `./mach build`. Keep the objdir. Point the fork's `local.properties` at `dependencySubstitutions.geckoviewTopsrcdir/Topobjdir`.
- Build `aospArm64GeckoLemmixRelease` (and `oculusvrArm64GeckoLemmixRelease` if the probe showed the Meta loader works better under Lepton; same code, different loader).
- Sideload; run the Phase 2 checklist plus ENTER VR from the kiosk window; exit VR returns to the flat window.
- **Controller mapping**: Wolvic's OpenXR input falls back to `khr/simple_controller` (no sticks) for unknown runtimes. In the OpenXR input tables under `app/src/openxr/cpp/` force the `oculus/touch_controller` bindings for the aosp platform when the runtime name matches Lepton/SteamVR, and add a mapping for the Steam Frame Controller interaction profile if the runtime exposes it.
- **Performance**: measure frame time on a wide level with `emboss=1&smooth=1`; seed platform defaults through the config endpoint if needed.
- IndexedDB quota for the ~250 MB unpacked styles package: verify; raise `dom.quotaManager.*` via `GeckoRuntimeSettings` if it bites.

Verify: full playthrough of one classic and one NeoLemmix level in VR on the Frame; thumbsticks, A/X, grip work; progress survives a headset reboot; upgrade in place (versionCode bump) keeps the IndexedDB install.

### Phase 5 — Steam release

- Steamworks app: Android depot with the APK as launch executable, platform "Android 10"; Steam Cloud root `AndroidExternalData`, subpath `lemmix-config/`, small quota (config JSONs only, never the asset store).
- Store text: free, engine only, players fetch NeoLemmix assets from the official site inside the game; NeoLemmix CC BY-NC credit (Langedijk, Neupert, Verasche), LemmingsJS/oklemenz credit. Flag the "engine with no content" review question with Valve early.
- MPL-2.0 obligations: publish the fork's patches and build docs.
- Release checklist in `android/README.md`: `node builder/version.js minor` → commit → `./gradlew :lemmixhost:syncSite assembleAospArm64GeckoLemmixRelease` → `apksigner verify` → size check (~100-130 MB, no OBB) → upload. Consider adding an `apk` action to `builder/main.js` alongside `bump`/`publish`.
- QA matrix: cold install, in-place upgrade, uninstall/reinstall (config restored from Steam Cloud), offline play, setup page with no network (clear proxy error).

## Fallbacks

- **No OpenXR runtime in Lepton** (Phase 3 fails): wait for Valve's Lepton developer docs; if the Frame's own browser has WebXR, the live site is the interim path; Phases 1-2 remain useful for any future WebXR shell.
- **Kiosk blanks WebXR (#970) on current Wolvic**: skip upstream kiosk; implement a "chromeless" mode in the fork (hide tray/navigation/title widgets, keep a normal window and session) behind the same `LEMMIX_KIOSK` flag.
- **Wolvic file picker unsupported**: irrelevant with the proxy; hide the "install zip" inputs in embedded mode.
- **Meta loader works, Khronos loader does not**: ship the `oculusvr` flavor variant.
- **No multicast into Lepton** (likely): the remembered-address probe and manual entry carry the feature; the Phase 3 probe records whether mDNS/broadcast reach the container (`adb shell` a UDP probe from inside). If Lepton exposes the LAN via a bridge later, mDNS starts working with no change.
- **Launcher on HTTP only** (user turned HTTPS off): the proxy speaks plain HTTP to it; the browser side is unaffected since it only sees 127.0.0.1.

## Critical files

- `3d/js/setup.js` — proxy download, persist timeout, config endpoints, embedded UI
- `3d/js/vfs.js` — `fetchEmbedded` next to `fetchHealth`, `Vfs.embedded`
- `3d/js/vr.js` — no change expected; reference for button states and gamepad indices
- `builder/version.js` — MARKERS entry for `android/version.properties`
- `launcher/server.js` — MIME table and endpoint style to mirror in `AssetSite.kt` and `dev-host.js`; the route list the proxy must pass through (health.json, /upload, /levels/dirs.json, /neolemmix/state.json, config PUT, profile POST, DELETE, live indexes)
- `launcher/main.js` — cert generation (fingerprint source) and server start/stop hooks for discovery
- new `launcher/discovery.js` — mDNS advertisement + UDP responder
- Wolvic fork: `app/src/common/shared/com/igalia/wolvic/ui/widgets/Windows.java`, `.../VRBrowserActivity.java`, `.../VRBrowserApplication.java`, `app/build.gradle`, new `lemmixhost/`
