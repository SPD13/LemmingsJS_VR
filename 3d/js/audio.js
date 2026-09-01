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
      .then((player) => player.play())
      .catch((e) => console.warn("[audio] music failed:", e));
  }

  playSfx(index) {
    if (!this.enabled || !this.resources || !this._gestured || index == null) return;
    this.resources.getSoundPlayer(index)
      .then((player) => {
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
