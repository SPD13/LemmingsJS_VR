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
};

/** lemming action-name transition -> effect (checked on every state change) */
const SFX_BY_ACTION = {
  "oh-no": SFX.OHNO,
  "exploding": SFX.EXPLODE,
  "splatter": SFX.SPLAT,
  "drowning": SFX.DROWN,
  "exiting": SFX.YIPPEE,
  "hoist": SFX.TRAP,
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
    const arm = () => {
      this._gestured = true;
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
      if (this._pendingMusic !== null) {
        const track = this._pendingMusic;
        this._pendingMusic = null;
        this.playMusic(track);
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
    if (!this.resources) return;
    try { this.resources.stopMusic(); } catch (e) {}
    try { this.resources.stopSound(); } catch (e) {}
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem("lem3d-sound", on ? "on" : "off"); } catch (e) {}
    if (!on) this.stopAll();
  }
}
