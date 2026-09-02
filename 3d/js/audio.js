"use strict";
/**
 * Music + sound effects for the 3D port, played through the engine's own
 * AdLib/OPL synthesizer (ADLIB.DAT via GameResources.getMusicPlayer /
 * getSoundPlayer - fully authentic FM audio, no external assets).
 *
 * Browsers refuse audio before a user gesture, so playback arms itself on
 * the first pointer/key event and any music requested before that starts
 * then. The engine plays one music track and one SFX at a time (a new SFX
 * replaces the previous), which matches the original game's behavior.
 *
 * SFX indexes into ADLIB.DAT are not formally documented; the table below
 * is a best-effort mapping. Audition candidates from the console with
 *   __lem3d.audio.playSfx(<n>)
 * and adjust SFX_* here if an effect sounds wrong.
 *
 * The later four were picked by measuring every track rather than guessing:
 * each entry carries the length and spectral centroid it was chosen for, so
 * anyone re-mapping has the same numbers to work from.
 */

const SFX = {
  LETSGO: 1,   // level start "let's go!"
  ASSIGN: 3,   // skill assigned to a lemming
  OHNO: 4,     // bomber countdown finished
  EXPLODE: 5,  // pop
  SPLAT: 6,    // fell too far
  YIPPEE: 7,   // reached the exit
  DROWN: 8,    // glug
  TRAP: 9,     // caught by a trap
  CLICK: 11,   // a press on the skill panel  (107ms, centroid 2.0kHz)
  TING: 14,    // three bricks left to build  (128ms, 5.6kHz - short, bright)
  DOOR: 2,     // the entrance hatch swinging (537ms, 3.0kHz, the loudest)
  NUKE: 12,    // the nuke                    (855ms, 9.4kHz - long, noisy)
  STEEL: 13,   // a skill stopped by steel    (172ms, 1.4kHz - a short clang)
};

// A builder lays 12 bricks; the original warns with three to go.
const BUILDER_WARN_AT = 9;

/**
 * lemming action-name transition -> effect (checked on every state change).
 *
 * "hoist" is deliberately absent. The engine sends a lemming caught by a trap
 * into HOISTING, so hoisting looked like the trap cue - but it is also what a
 * climber does on reaching the top of a wall, which made every successful
 * climb sound like a death. The trap is caught at its trigger instead.
 */
const SFX_BY_ACTION = {
  "oh-no": SFX.OHNO,
  "exploding": SFX.EXPLODE,
  "splatter": SFX.SPLAT,
  "drowning": SFX.DROWN,
  "exiting": SFX.YIPPEE,
};

class GameAudio {
  constructor() {
    let stored = null;
    try { stored = localStorage.getItem("lem3d-sound"); } catch (e) {}
    this.enabled = stored !== "off";
    let vol = null;
    try { vol = localStorage.getItem("lem3d-volume"); } catch (e) {}
    this.volume = vol === null ? 1 : Math.min(1, Math.max(0, parseFloat(vol)));
    if (!isFinite(this.volume)) this.volume = 1;
    this._players = new Set();   // whatever is playing, so volume reaches it
    this.resources = null;
    this.numberOfTracks = 1;
    this._gestured = false;
    this._pendingMusic = null;
    this._sfxTimer = 0;
    // file-based audio (NeoLemmix packs): one context of our own, decoded
    // effects kept by name, and a tracker player for module music
    this.fileRoot = "";
    this._fctx = null;
    this._fileSfx = new Map();
    this._fileMusic = null;
    this._tracker = null;
    const arm = () => {
      this._gestured = true;
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
      if (this._pendingMusic !== null) {
        const track = this._pendingMusic;
        this._pendingMusic = null;
        if (typeof track === "function") track(); else this.playMusic(track);
      }
    };
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
  }

  /**
   * Enable positional SFX: `isActive()` gates it (VR only — desktop scene
   * units are pixels, not meters) and `getListenerMatrix()` supplies the
   * headset pose. The engine has no sound positions; emitters are derived
   * from the sim events that trigger each effect.
   */
  configureSpatial(spatial) {
    this._spatial = spatial;
  }

  /**
   * Wire a player up: its processor, optionally through a panner, and always
   * through a gain of our own before the destination. The engine connects
   * straight to the destination, and every player brings its own AudioContext,
   * so there is no one node to turn down - each gets its own and they are all
   * moved together.
   */
  _route(player, worldPos) {
    if (!player || !player.processor || !player.audioCtx) return;
    const ctx = player.audioCtx;
    try {
      player.processor.disconnect();
      let tail = player.processor;
      if (worldPos && this._spatial && this._spatial.isActive()) {
        const panner = this._panner(player, worldPos, ctx);
        player.processor.connect(panner); // the panner needs its input
        tail = panner;
      }
      let gain = player.__gain;
      if (!gain || gain.context !== ctx) {
        gain = ctx.createGain();
        player.__gain = gain;
      }
      gain.gain.value = this.volume;
      tail.connect(gain);
      gain.connect(ctx.destination);
      this._players.add(player);
    } catch (e) {
      console.warn("[audio] routing failed:", e);
    }
  }

  /** Volume, 0..1, remembered like the sound switch. */
  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    try { localStorage.setItem("lem3d-volume", String(this.volume)); } catch (e) {}
    for (const p of this._players) {
      try { if (p.__gain) p.__gain.gain.value = this.volume; } catch (e) {}
    }
  }

  /** The HRTF panner for one positioned effect, aimed from the headset pose. */
  _panner(player, worldPos, ctx) {
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    // The board is a 4m strip an arm's length away, so its far end is metres
    // off: a realistic rolloff would leave half the level inaudible under the
    // music. This one is deliberately shallow - full volume out to the near
    // edge, and roughly half at the far end - so the panning carries the
    // direction while the effect stays audible.
    panner.refDistance = 1.5;
    panner.maxDistance = 25;
    panner.rolloffFactor = 0.5;
    if (panner.positionX) {
      panner.positionX.value = worldPos.x;
      panner.positionY.value = worldPos.y;
      panner.positionZ.value = worldPos.z;
    } else {
      panner.setPosition(worldPos.x, worldPos.y, worldPos.z);
    }
    player.__panner = panner; // introspection/debug
    // listener = headset pose at play time (SFX are short; no per-frame track)
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    this._spatial.getListenerMatrix().decompose(pos, quat, new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
    return panner;
  }

  /** One GameResources per game type owns the ADLIB data + active players. */
  setResources(gameResources, config) {
    if (this.resources && this.resources !== gameResources) {
      this.stopAll();
    }
    this.resources = gameResources;
    this.numberOfTracks =
      (config && config.audioConfig && config.audioConfig.numberOfTracks) || 1;
  }

  playMusic(trackIndex) {
    if (!this.enabled || !this.resources) return;
    if (!this._gestured) { this._pendingMusic = trackIndex; return; }
    this.resources.getMusicPlayer(trackIndex % this.numberOfTracks)
      .then((player) => { player.play(); this._route(player, null); })
      .catch((e) => console.warn("[audio] music failed:", e));
  }

  playSfx(index, worldPos = null) {
    if (!this.enabled || !this.resources || !this._gestured || index == null) return;
    this.resources.getSoundPlayer(index)
      .then((player) => {
        this._route(player, worldPos);
        // OPL sounds have no end event; stop the player once it must be done
        clearTimeout(this._sfxTimer);
        this._sfxTimer = setTimeout(() => {
          try {
            if (this.resources && this.resources.soundPlayer === player) {
              this.resources.stopSound();
            }
          } catch (e) { /* already stopped */ }
        }, 4000);
      })
      .catch((e) => console.warn("[audio] sfx failed:", e));
  }

  stopAll() {
    this._pendingMusic = null;
    this.stopFileMusic();
    if (!this.resources) return;
    try { this.resources.stopMusic(); } catch (e) {}
    try { this.resources.stopSound(); } catch (e) {}
  }

  // ------------------------------------------------------- files (Lemmix)

  /** Where sound/ and music/ are, relative to the page ("../" from 3d/). */
  setFileRoot(root) { this.fileRoot = root; }

  _fileContext() {
    if (!this._fctx) this._fctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this._fctx.state === "suspended") this._fctx.resume().catch(() => {});
    return this._fctx;
  }

  /** A decoded effect from sound/<name>.wav|ogg|mp3, or null; kept once found. */
  _fileSfxBuffer(name) {
    if (this._fileSfx.has(name)) return this._fileSfx.get(name);
    const ctx = this._fileContext();
    const p = (async () => {
      for (const ext of ["wav", "ogg", "mp3"]) {
        try {
          const res = await fetch(this.fileRoot + "sound/" + encodeURIComponent(name) + "." + ext);
          if (!res.ok) continue;
          return await ctx.decodeAudioData(await res.arrayBuffer());
        } catch (e) { /* try the next */ }
      }
      return null;
    })();
    this._fileSfx.set(name, p);
    return p;
  }

  /**
   * A NeoLemmix sound cue by name: the file if there is one, else the AdLib
   * effect that stands in for it (`fallback`, an SFX index), else nothing.
   */
  playCue(name, worldPos = null, fallback = null) {
    if (!this.enabled || !this._gestured || !name) return;
    this._fileSfxBuffer(name).then((buffer) => {
      if (!buffer) { if (fallback != null) this.playSfx(fallback, worldPos); return; }
      const ctx = this._fileContext();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      this._route({ processor: source, audioCtx: ctx }, worldPos);
      source.start();
    }).catch((e) => console.warn("[audio] cue failed:", e));
  }

  stopFileMusic() {
    if (this._fileMusic) {
      try { this._fileMusic.stop(); } catch (e) {}
      this._fileMusic = null;
    }
    if (this._tracker) { try { this._tracker.stop(); } catch (e) {} }
  }

  /** Play a music file: a tracker module through libopenmpt, anything else decoded and looped. */
  playMusicUrl(url) {
    if (!this.enabled) return;
    if (!this._gestured) { this._pendingMusic = () => this.playMusicUrl(url); return; }
    this.stopFileMusic();
    try { if (this.resources) this.resources.stopMusic(); } catch (e) {}
    const ctx = this._fileContext();
    const ext = url.split(".").pop().toLowerCase();
    if (["it", "xm", "mod", "s3m", "mtm", "umx", "mo3"].includes(ext)) {
      if (!window.ChiptuneJsPlayer) { console.warn("[audio] no tracker player loaded"); return; }
      if (!this._tracker) {
        this._tracker = new window.ChiptuneJsPlayer({ context: ctx, repeatCount: -1 });
        this._tracker.onInitialized(() => {
          this._route({ processor: this._tracker.gain, audioCtx: ctx }, null);
          // a load asked for before the worklet was up is played now
          if (this._trackerPending) { const u = this._trackerPending; this._trackerPending = null; this._tracker.load(u); }
        });
        this._tracker.onError((e) => console.warn("[audio] tracker:", e));
      }
      if (this._tracker.processNode) this._tracker.load(url);
      else this._trackerPending = url;
      this._lastMusicUrl = url;
      return;
    }
    fetch(url).then((res) => res.ok ? res.arrayBuffer() : Promise.reject(new Error("HTTP " + res.status)))
      .then((buf) => ctx.decodeAudioData(buf))
      .then((buffer) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        this._route({ processor: source, audioCtx: ctx }, null);
        source.start();
        this._fileMusic = source;
      })
      .catch((e) => console.warn("[audio] music file failed:", e));
  }

  /**
   * A level's music from a list of candidate URLs, the first that exists;
   * none of them there, the AdLib track `fallback` plays instead.
   */
  playLevelMusic(candidates, fallback) {
    if (!this.enabled) return;
    if (!this._gestured) { this._pendingMusic = () => this.playLevelMusic(candidates, fallback); return; }
    (async () => {
      for (const url of candidates) {
        try {
          const res = await fetch(url, { method: "HEAD" });
          if (res.ok) { this.playMusicUrl(url); return; }
        } catch (e) { /* next */ }
      }
      this.playMusic(fallback);
    })();
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem("lem3d-sound", on ? "on" : "off"); } catch (e) {}
    if (!on) this.stopAll();
  }
}
