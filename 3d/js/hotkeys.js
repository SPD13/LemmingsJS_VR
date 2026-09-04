"use strict";
/**
 * Hotkeys: NeoLemmix's configurable keys, for both engines.
 *
 * NeoLemmix keeps a table from key to function (LemmixHotkeys.pas): a key
 * does one thing, some functions carry a detail - which skill, how many
 * frames, hold or toggle, which special skip - and Shift, Ctrl and Alt are
 * keys like any other, not modifiers. Three layouts ship with it
 * (traditional, functional, minimal); the traditional one is the manual's
 * and the default here. The page's own keys (reset the view, the piece
 * editor, ...) sit in the same table so they can be moved too.
 *
 * Keys are named by KeyboardEvent.code (the physical key, like a virtual
 * key code), with the two Shifts, Ctrls, Alts and Cmds folded into one
 * each; the middle and right mouse buttons are keys as in NeoLemmix. Names
 * are NeoLemmix's hardcoded US ones, or the labels of the keyboard in use
 * when the browser can say (the "hardcoded names" switch of its options).
 *
 * The headset's controllers are in the same table, under their own key
 * names (VrPointA, VrFreeStick, ...): the face buttons and thumbstick of
 * the pointing hand (the one with the beam) and of the free hand, each
 * given a function - a button any function a key can have, a stick one of
 * the stick functions (pan, tilt, dolly). The trigger and the grips stay
 * what they are: the click, the drag, the scale.
 *
 * The table lives in localStorage; the dialog (FEditHotkeys.pas) is the
 * page's: a keyboard tab and a VR tab, a list of keys, a function for the
 * chosen one with its detail, "show unassigned keys", "find key", the
 * three layouts. A function that does nothing on a DOS level is tagged
 * Lemmix; one that is the page's own and not NeoLemmix's is tagged 3D view
 * or VR.
 */
(function (root) {
  const STORAGE_KEY = "lem3d-hotkeys";
  const VERSION = 1;
  const EXPORT_FORMAT = "lemmings-3d-controls"; // the exported file names itself
  const EXPORT_FILE = "lemmings-3d-controls.json";

  // NeoLemmix's skills in its own order (TSkillPanelButton); the DOS engine has eight of them
  const SKILLS = ["walker", "jumper", "shimmier", "slider", "climber", "swimmer", "floater", "glider",
    "disarmer", "bomber", "stoner", "blocker", "platformer", "builder", "stacker", "laserer", "basher",
    "fencer", "miner", "digger", "cloner"];
  const DOS_SKILLS = new Set(["climber", "floater", "bomber", "blocker", "builder", "basher", "miner", "digger"]);
  const SPECIAL_SKIPS = ["Previous Assignment", "Next Shrugger"];

  /**
   * The functions. `mod` is the detail the function needs (skill, frames,
   * hold, special); `held` does its work while the key is down; `repeat`
   * lets the keyboard's auto-repeat fire it again; `tag` "lemmix" = no
   * effect on a DOS level, "view" = this page's own, not NeoLemmix's.
   */
  const ACTIONS = [
    { id: "skill", label: "Select Skill", mod: "skill" },
    { id: "previous_skill", label: "Previous Skill" },
    { id: "next_skill", label: "Next Skill" },
    { id: "rr_down", label: "Decrease Release Rate" }, // held: keeps changing until released
    { id: "rr_up", label: "Increase Release Rate" },
    { id: "rr_min", label: "Minimum Release Rate" },
    { id: "rr_max", label: "Maximum Release Rate" },
    { id: "pause", label: "Pause" },
    { id: "nuke", label: "Nuke (press twice)" },
    { id: "fastforward", label: "Fast Forward" },
    { id: "slow_motion", label: "Slow Motion" },
    { id: "skip", label: "Time Skip", mod: "frames", repeat: true },
    { id: "special_skip", label: "Skip to", mod: "special", tag: "lemmix" },
    { id: "restart", label: "Restart" },
    { id: "save_state", label: "Save State", tag: "lemmix" },
    { id: "load_state", label: "Load State", tag: "lemmix" },
    { id: "dir_select_left", label: "Directional Select Left", held: true, tag: "lemmix" },
    { id: "dir_select_right", label: "Directional Select Right", held: true, tag: "lemmix" },
    { id: "force_walker", label: "Select Walker", held: true, tag: "lemmix" },
    { id: "athlete_info", label: "Show Athlete Info", held: true, tag: "lemmix" },
    { id: "clear_physics", label: "Clear Physics Mode", mod: "hold", tag: "lemmix" },
    { id: "toggle_shadows", label: "Toggle Skill Shadows", tag: "lemmix" },
    { id: "replay_insert", label: "Replay Insert Mode", tag: "lemmix" },
    { id: "cancel_replay", label: "Cancel Replay", tag: "lemmix" },
    { id: "load_replay", label: "Load Replay", tag: "lemmix" },
    { id: "save_replay", label: "Save Replay" },
    { id: "toggle_music", label: "Toggle Music" },
    { id: "toggle_sound", label: "Toggle Sound" },
    { id: "zoom_in", label: "Zoom In", repeat: true },
    { id: "zoom_out", label: "Zoom Out", repeat: true },
    { id: "quit", label: "Quit to the World Library" },
    { id: "cheat", label: "Cheat (99 of each skill)" },
    { id: "reset_view", label: "Reset the View", tag: "view" },
    { id: "recenter_vr", label: "Recentre (VR)", tag: "view" },
    { id: "speed_up", label: "Speed Up", tag: "view", repeat: true },
    { id: "speed_down", label: "Speed Down", tag: "view", repeat: true },
    { id: "previous_level", label: "Previous Level", tag: "view" },
    { id: "next_level", label: "Next Level", tag: "view" },
    { id: "piece_editor", label: "Piece Editor", tag: "view" },
    { id: "cycle_class", label: "Cycle Piece Class (editor)", tag: "view" },
    { id: "yaw_left", label: "VR Yaw Correction −", tag: "view" },
    { id: "yaw_right", label: "VR Yaw Correction +", tag: "view" },
    // the headset's own: a button held dollies, a stick moves the board
    { id: "vr_dolly_in", label: "Dolly In (held)", tag: "vr", vr: "button" },
    { id: "vr_dolly_out", label: "Dolly Out (held)", tag: "vr", vr: "button" },
    { id: "vr_pan", label: "Pan the Board", tag: "vr", vr: "stick" },
    { id: "vr_tilt", label: "Tilt the Board", tag: "vr", vr: "stick" },
    { id: "vr_zoom", label: "Dolly (forward in, back out)", tag: "vr", vr: "stick" },
  ];
  // what a headset cannot do (the page's DOM): not offered on its buttons
  const DESKTOP_ONLY = new Set(["piece_editor", "cycle_class"]);
  const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

  // The keys, with NeoLemmix's hardcoded names (GetKeyNames), in its order.
  const KEYS = [];
  const key = (code, name) => KEYS.push({ code, name });
  key("MouseRight", "Right-Click");
  key("MouseMiddle", "Middle-Click");
  key("Backspace", "Backspace");
  key("Tab", "Tab");
  key("Enter", "Enter");
  key("Shift", "Shift");
  key("Control", "Ctrl");
  key("Alt", "Alt");
  key("Pause", "Pause");
  key("CapsLock", "Caps Lock");
  key("Meta", "Cmd / Win");
  key("Escape", "Esc");
  key("Space", "Space");
  key("PageUp", "Page Up");
  key("PageDown", "Page Down");
  key("End", "End");
  key("Home", "Home");
  key("ArrowLeft", "Left Arrow");
  key("ArrowUp", "Up Arrow");
  key("ArrowRight", "Right Arrow");
  key("ArrowDown", "Down Arrow");
  key("Insert", "Insert");
  key("Delete", "Delete");
  for (let i = 0; i <= 9; i++) key("Digit" + i, String(i));
  for (let i = 0; i < 26; i++) key("Key" + String.fromCharCode(65 + i), String.fromCharCode(65 + i));
  for (let i = 0; i <= 9; i++) key("Numpad" + i, "NumPad " + i);
  key("NumpadMultiply", "NumPad *");
  key("NumpadAdd", "NumPad +");
  key("NumpadSubtract", "NumPad -");
  key("NumpadDecimal", "NumPad .");
  key("NumpadDivide", "NumPad /");
  key("NumpadEnter", "NumPad Enter");
  for (let i = 1; i <= 12; i++) key("F" + i, "F" + i);
  key("NumLock", "NumLock");
  key("ScrollLock", "Scroll Lock");
  key("Semicolon", ";");
  key("Equal", "+");
  key("Comma", ",");
  key("Minus", "-");
  key("Period", ".");
  key("Slash", "/");
  key("Backquote", "~");
  key("BracketLeft", "[");
  key("Backslash", "\\");
  key("BracketRight", "]");
  key("Quote", "'");
  key("IntlBackslash", "< >");
  const KEY_BY_CODE = new Map(KEYS.map((k) => [k.code, k]));

  /**
   * The headset's inputs, by the hand's role rather than its side: the beam
   * moves to whichever hand pulls its trigger, and the functions follow it.
   * A "stick" kind takes the stick functions, a "button" any other.
   */
  const VR_KEYS = [
    { code: "VrPointA", name: "Pointing hand: A / X", kind: "button" },
    { code: "VrPointB", name: "Pointing hand: B / Y", kind: "button" },
    { code: "VrPointStickClick", name: "Pointing hand: stick click", kind: "button" },
    { code: "VrPointStick", name: "Pointing hand: thumbstick", kind: "stick" },
    { code: "VrFreeA", name: "Free hand: A / X", kind: "button" },
    { code: "VrFreeB", name: "Free hand: B / Y", kind: "button" },
    { code: "VrFreeStickClick", name: "Free hand: stick click", kind: "button" },
    { code: "VrFreeStick", name: "Free hand: thumbstick", kind: "stick" },
  ];
  const VR_KEY_BY_CODE = new Map(VR_KEYS.map((k) => [k.code, k]));
  const isVrCode = (code) => VR_KEY_BY_CODE.has(code);
  // the controllers as they work today: the pointing hand recentres and
  // pans, the free hand dollies and tilts
  const VR_PRESET = [
    ["VrPointA", "recenter_vr"], ["VrPointStick", "vr_pan"],
    ["VrFreeB", "vr_dolly_in"], ["VrFreeA", "vr_dolly_out"], ["VrFreeStick", "vr_tilt"],
  ];

  /** Can this function go on this input? A stick takes stick functions, a button the rest. */
  function allowedOn(code, action) {
    const a = ACTION_BY_ID.get(action);
    if (!a) return false;
    const vk = VR_KEY_BY_CODE.get(code);
    if (!vk) return !a.vr; // a keyboard key: nothing that is the headset's own
    if (vk.kind === "stick") return a.vr === "stick";
    return a.vr !== "stick" && !DESKTOP_ONLY.has(action);
  }

  /** A KeyboardEvent's code as the table names it: one Shift, Ctrl, Alt, Cmd each. */
  function normalizeCode(code) {
    if (!code) return "";
    if (code === "ShiftLeft" || code === "ShiftRight") return "Shift";
    if (code === "ControlLeft" || code === "ControlRight") return "Control";
    if (code === "AltLeft" || code === "AltRight") return "Alt";
    if (code === "MetaLeft" || code === "MetaRight" || code === "OSLeft" || code === "OSRight") return "Meta";
    return code;
  }

  /**
   * The three layouts of LemmixHotkeys.pas, key codes for its virtual key
   * codes. Functions NeoLemmix has and this page does not (highlight, the
   * replay editor, projections, save image, scroll, release mouse) leave
   * their keys free. The page's own view keys sit on keys the layout does
   * not use.
   */
  const PRESETS = {
    traditional: [
      ["MouseMiddle", "pause"], ["Backspace", "load_state"], ["Enter", "save_state"],
      ["Control", "force_walker"], ["Escape", "quit"],
      ["ArrowLeft", "dir_select_left"], ["ArrowRight", "dir_select_right"],
      ["KeyC", "cancel_replay"], ["KeyF", "fastforward"], ["KeyH", "toggle_shadows"],
      ["KeyL", "load_replay"], ["KeyM", "toggle_music"], ["KeyP", "pause"], ["KeyR", "restart"],
      ["KeyS", "toggle_sound"], ["KeyU", "save_replay"], ["KeyW", "replay_insert"],
      ["KeyX", "next_skill"], ["KeyZ", "previous_skill"],
      ["F1", "rr_down"], ["F2", "rr_up"], ["F11", "pause"],
      ["KeyT", "clear_physics", 1], ["Alt", "athlete_info"],
      ["Space", "skip", 170], ["KeyB", "skip", -1], ["KeyN", "skip", 1], ["NumpadSubtract", "skip", -17],
      ["Comma", "skip", -85], ["Minus", "skip", -17], ["Period", "skip", 85],
      ["BracketLeft", "special_skip", 0], ["BracketRight", "special_skip", 1],
      ["Tab", "skill", "slider"], ["Digit1", "skill", "walker"], ["Digit2", "skill", "shimmier"],
      ["Digit3", "skill", "swimmer"], ["Digit4", "skill", "glider"], ["Digit5", "skill", "disarmer"],
      ["Digit6", "skill", "stoner"], ["Digit7", "skill", "platformer"], ["Digit8", "skill", "stacker"],
      ["Digit9", "skill", "fencer"], ["Digit0", "skill", "cloner"], ["KeyQ", "skill", "laserer"],
      ["F3", "skill", "climber"], ["F4", "skill", "floater"], ["F5", "skill", "bomber"],
      ["F6", "skill", "blocker"], ["F7", "skill", "builder"], ["F8", "skill", "basher"],
      ["F9", "skill", "miner"], ["F10", "skill", "digger"], ["Equal", "skill", "jumper"],
      // the page's own
      ["Home", "reset_view"], ["KeyV", "recenter_vr"], ["PageUp", "zoom_in"], ["PageDown", "zoom_out"],
      ["KeyJ", "piece_editor"], ["KeyK", "cycle_class"],
    ],
    functional: [
      ["Backspace", "toggle_shadows"], ["KeyS", "dir_select_left"], ["KeyF", "dir_select_right"],
      ["ArrowLeft", "dir_select_left"], ["ArrowRight", "dir_select_right"], ["Space", "pause"],
      ["F1", "restart"], ["F2", "load_state"], ["F3", "save_state"],
      ["Digit4", "fastforward"], ["Digit5", "fastforward"], ["MouseMiddle", "pause"], ["Escape", "quit"],
      ["F6", "save_replay"], ["F7", "load_replay"], ["KeyM", "toggle_music"], ["KeyN", "toggle_sound"],
      ["F4", "rr_down"], ["F5", "rr_up"], ["KeyO", "replay_insert"],
      ["Slash", "clear_physics", 1],
      ["Digit1", "skip", -17], ["Digit2", "skip", -1], ["Digit3", "skip", 1], ["Digit6", "skip", 170],
      ["Digit7", "special_skip", 0], ["Digit8", "special_skip", 1],
      ["Shift", "previous_skill"], ["KeyB", "next_skill"],
      ["KeyD", "skill", "walker"], ["KeyR", "skill", "jumper"], ["Alt", "skill", "shimmier"],
      ["KeyH", "skill", "slider"], ["KeyZ", "skill", "climber"], ["KeyQ", "skill", "floater"],
      ["Tab", "skill", "glider"], ["KeyV", "skill", "bomber"], ["KeyX", "skill", "blocker"],
      ["KeyT", "skill", "platformer"], ["KeyA", "skill", "builder"], ["KeyY", "skill", "laserer"],
      ["KeyE", "skill", "basher"], ["KeyC", "skill", "fencer"], ["KeyG", "skill", "miner"],
      ["KeyW", "skill", "digger"],
      // the page's own
      ["Home", "reset_view"], ["PageUp", "zoom_in"], ["PageDown", "zoom_out"],
      ["KeyK", "piece_editor"], ["KeyL", "cycle_class"],
    ],
    minimal: [
      ["MouseMiddle", "pause"], ["Escape", "quit"],
      ["Home", "reset_view"], ["PageUp", "zoom_in"], ["PageDown", "zoom_out"],
    ],
  };
  const DEFAULT_PRESET = "traditional";

  /** The detail a function carries when none was given. */
  function defaultMod(action) {
    const a = ACTION_BY_ID.get(action);
    if (!a || !a.mod) return 0;
    if (a.mod === "skill") return SKILLS[0];
    if (a.mod === "frames") return 1;
    return 0;
  }

  /** A binding read in as text, as the list shows it (FEditHotkeys.RefreshList). */
  function describe(binding) {
    if (!binding) return "";
    const a = ACTION_BY_ID.get(binding.action);
    if (!a) return binding.action;
    switch (a.mod) {
      case "skill": {
        const s = String(binding.mod || "");
        return "Select Skill: " + (s ? s[0].toUpperCase() + s.slice(1) : "???");
      }
      case "frames": {
        const n = binding.mod | 0;
        if (n < -1) return "Time Skip: Back " + (-n) + " Frames";
        if (n === -1) return "Time Skip: Back 1 Frame";
        if (n > 1) return "Time Skip: Forward " + n + " Frames";
        return "Time Skip: Forward 1 Frame";
      }
      case "hold": return a.label + (binding.mod ? " (hold)" : " (toggle)");
      case "special": return "Skip to " + (SPECIAL_SKIPS[binding.mod | 0] || "???");
    }
    return a.label;
  }

  /** "lemmix" when the binding does nothing on a DOS level, "view" for the page's own, else "". */
  function tagOf(binding) {
    if (!binding) return "";
    const a = ACTION_BY_ID.get(binding.action);
    if (!a) return "";
    if (a.tag) return a.tag; // "lemmix", "view" or "vr"
    if (a.id === "skill" && !DOS_SKILLS.has(binding.mod)) return "lemmix";
    if (a.id === "skip" && (binding.mod | 0) < 0) return "lemmix";
    return "";
  }

  /** The table, and its keeping in localStorage. */
  class HotkeyManager {
    constructor() {
      this.table = new Map(); // code -> {action, mod}
      this.onChange = null;
      this.load();
    }

    load() {
      let raw = null;
      try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* no storage */ }
      if (raw) {
        try {
          const data = JSON.parse(raw);
          if (data && data.keys && typeof data.keys === "object") {
            this.table.clear();
            for (const code of Object.keys(data.keys)) {
              const b = data.keys[code];
              if (b && ACTION_BY_ID.has(b.action)) this.table.set(code, { action: b.action, mod: b.mod == null ? defaultMod(b.action) : b.mod });
            }
            // a table saved before the controllers were in it: theirs as they were
            if (!data.vr) this.applyVrPreset(false);
            this.fillDefaults(false); // a half the table does not cover at all
            return;
          }
        } catch (e) { /* unreadable: start over */ }
      }
      // nothing kept in this browser yet: the layouts as they ship, written
      // out at once so the dialog, the exported file and - in server mode -
      // the launcher's config file all see them
      this.applyPreset(DEFAULT_PRESET, false);
      this.applyVrPreset(false);
      this.save();
    }

    /** Is anything bound on this half of the table: the controllers, or the keyboard. */
    hasHalf(vr) {
      for (const code of this.table.keys()) if (isVrCode(code) === !!vr) return true;
      return false;
    }

    /**
     * A half with nothing bound on it at all - a browser with no table yet, a
     * file that carried only the keyboard's keys - filled with what ships:
     * the traditional layout, the controllers of VR_PRESET. Returns the
     * names of the halves it filled.
     */
    fillDefaults(save = true) {
      const filled = [];
      if (!this.hasHalf(false)) { this.applyPreset(DEFAULT_PRESET, false); filled.push("keyboard"); }
      if (!this.hasHalf(true)) { this.applyVrPreset(false); filled.push("VR"); }
      if (filled.length && save) this.save();
      return filled;
    }

    save() {
      const keys = {};
      for (const [code, b] of this.table) keys[code] = { action: b.action, mod: b.mod };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, vr: true, keys })); } catch (e) { /* no storage */ }
    }

    _changed() { if (this.onChange) this.onChange(); }

    /** A keyboard layout: the keyboard's half of the table replaced, the controllers kept. */
    applyPreset(name, save = true) {
      const preset = PRESETS[name];
      if (!preset) return;
      for (const code of Array.from(this.table.keys())) if (!isVrCode(code)) this.table.delete(code);
      for (const [code, action, mod] of preset) this.table.set(code, { action, mod: mod == null ? defaultMod(action) : mod });
      if (save) this.save();
      this._changed();
    }

    /** The controllers as they started out, the keyboard kept. */
    applyVrPreset(save = true) {
      for (const code of Array.from(this.table.keys())) if (isVrCode(code)) this.table.delete(code);
      for (const [code, action, mod] of VR_PRESET) this.table.set(code, { action, mod: mod == null ? defaultMod(action) : mod });
      if (save) this.save();
      this._changed();
    }

    /**
     * The whole table - the keyboard's keys and the controllers - as a JSON
     * text, to keep or carry to another browser.
     */
    exportJSON() {
      const keys = {};
      for (const [code, b] of this.table) keys[code] = { action: b.action, mod: b.mod };
      return JSON.stringify({ format: EXPORT_FORMAT, version: VERSION, keys }, null, 2);
    }

    /**
     * A table from exportJSON's text, replacing this one. Entries that name
     * an unknown key or function, or put a function on an input that cannot
     * take it, are skipped; a half the file leaves empty (an older file with
     * no controllers in it) keeps what ships. Returns {loaded, skipped,
     * filled}; throws on a text that is not a controls file at all.
     */
    importJSON(text) {
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error("not a JSON file"); }
      if (!data || typeof data !== "object" || !data.keys || typeof data.keys !== "object" || Array.isArray(data.keys)) {
        throw new Error("not a controls file (no \"keys\" table)");
      }
      if (data.format && data.format !== EXPORT_FORMAT) throw new Error("not a controls file (format " + data.format + ")");
      const next = new Map();
      let skipped = 0;
      for (const code of Object.keys(data.keys)) {
        const b = data.keys[code];
        const known = KEY_BY_CODE.has(code) || VR_KEY_BY_CODE.has(code);
        if (!known || !b || typeof b !== "object" || !ACTION_BY_ID.has(b.action) || !allowedOn(code, b.action)) { skipped++; continue; }
        next.set(code, { action: b.action, mod: b.mod == null ? defaultMod(b.action) : b.mod });
      }
      this.table = next;
      const loaded = next.size;
      const filled = this.fillDefaults(false); // a file that left a half empty
      this.save();
      this._changed();
      return { loaded, skipped, filled };
    }

    /** Give `code` a function (null clears it). */
    set(code, action, mod) {
      if (!action) this.table.delete(code);
      else this.table.set(code, { action, mod: mod == null ? defaultMod(action) : mod });
      this.save();
      this._changed();
    }

    get(code) { return this.table.get(code) || null; }

    /** The function of an event's key, or null. */
    forEvent(e) { return this.get(normalizeCode(e.code)); }

    /** Codes bound to a function (and, when given, to that detail). */
    codesFor(action, mod) {
      const out = [];
      for (const [code, b] of this.table) {
        if (b.action !== action) continue;
        if (mod !== undefined && b.mod !== mod) continue;
        out.push(code);
      }
      return out;
    }

    /** The name of the first key bound to a function, "" when none. */
    keyNameFor(action, mod) {
      const codes = this.codesFor(action, mod);
      // a keyboard key over a mouse button or a controller, when both do it
      const rank = (c) => (c.startsWith("Mouse") ? 1 : isVrCode(c) ? 2 : 0);
      codes.sort((a, b) => rank(a) - rank(b));
      return codes.length ? keyName(codes[0]) : "";
    }
  }

  // ---------------------------------------------------------------- names
  let layoutNames = null; // code -> label from the keyboard in use, once asked for

  /** A key's name: the layout's label when asked for and known, else NeoLemmix's. */
  function keyName(code, useLayout) {
    if (useLayout && layoutNames && layoutNames.has(code)) return layoutNames.get(code);
    const k = KEY_BY_CODE.get(code) || VR_KEY_BY_CODE.get(code);
    return k ? k.name : code;
  }

  /** Ask the browser for the labels of the keyboard in use (Chrome has it). */
  function loadLayoutNames() {
    if (layoutNames) return Promise.resolve(layoutNames);
    if (!(navigator.keyboard && navigator.keyboard.getLayoutMap)) return Promise.resolve(null);
    return navigator.keyboard.getLayoutMap().then((map) => {
      layoutNames = new Map();
      for (const k of KEYS) {
        const label = map.get(k.code);
        if (label && label.trim()) layoutNames.set(k.code, label.length === 1 ? label.toUpperCase() : label);
      }
      return layoutNames;
    }).catch(() => null);
  }

  // --------------------------------------------------------------- dialog
  const CSS = `
  #hotkeys { position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
    background: rgba(5, 7, 12, 0.72); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: #cdd6e4; }
  #hotkeys[hidden], #hotkeys [hidden] { display: none !important; }
  #hotkeys .hk-dlg { background: #10141c; border: 1px solid #33405a; border-radius: 8px; padding: 16px 20px 14px;
    width: min(760px, calc(100vw - 40px)); max-height: calc(100vh - 40px); display: flex; flex-direction: column;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55); }
  #hotkeys .hk-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  #hotkeys h2 { margin: 0; font-size: 15px; color: #ffd866; letter-spacing: 0.06em; }
  #hotkeys .hk-note { color: #8fa1bb; font-size: 11px; flex: 1; }
  #hotkeys .hk-tools { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-bottom: 8px; }
  #hotkeys .hk-tools label { display: inline-flex; align-items: center; gap: 4px; color: #8fa1bb; }
  #hotkeys .hk-body { display: flex; gap: 14px; min-height: 0; flex: 1; }
  #hotkeys .hk-list { flex: 1; overflow-y: auto; border: 1px solid #2a3446; border-radius: 4px; min-height: 240px; max-height: 50vh; }
  #hotkeys table { border-collapse: collapse; width: 100%; }
  #hotkeys th { text-align: left; color: #8fa1bb; font-weight: 600; padding: 4px 8px; position: sticky; top: 0; background: #161c28; }
  #hotkeys td { padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  #hotkeys td.hk-fn { white-space: normal; }
  #hotkeys tr.hk-empty td { color: #5a6a7c; }
  #hotkeys tr:hover td { background: #1a2231; }
  #hotkeys tr.hk-sel td { background: #263043; color: #f0f3f8; }
  #hotkeys .tag { display: inline-block; font-size: 10px; line-height: 14px; padding: 0 5px; border-radius: 3px; letter-spacing: 0.04em; }
  #hotkeys .tag.lemmix { background: #2f6b3d; color: #d7f5dd; }
  #hotkeys .tag.view { background: #26485c; color: #d5eef7; }
  #hotkeys .tag.vr { background: #4a3a6b; color: #e6dcf7; }
  #hotkeys .hk-tabs { display: flex; gap: 0; margin-bottom: 10px; border-bottom: 1px solid #2a3446; }
  #hotkeys .hk-tabs button { border: 1px solid transparent; border-bottom: none; background: transparent; color: #8fa1bb;
    border-radius: 4px 4px 0 0; padding: 4px 14px; font-size: 12px; }
  #hotkeys .hk-tabs button.hk-on { color: #ffd866; border-color: #2a3446; background: #161c28; }
  #hotkeys .hk-tools[hidden] { display: none !important; }
  #hotkeys .hk-edit { width: 250px; display: flex; flex-direction: column; gap: 8px; }
  #hotkeys .hk-edit label { display: flex; flex-direction: column; gap: 3px; color: #8fa1bb; }
  #hotkeys .hk-edit label.hk-inline { flex-direction: row; align-items: center; gap: 6px; }
  #hotkeys .hk-edit select, #hotkeys .hk-edit input[type=number] { font: inherit; color: #cdd6e4; background: #1c2432;
    border: 1px solid #33405a; border-radius: 4px; padding: 3px 6px; max-width: 100%; }
  #hotkeys .hk-editing { color: #f0f3f8; min-height: 16px; }
  #hotkeys .hk-hint { color: #5a6a7c; font-size: 11px; }
  #hotkeys .hk-legend { color: #8fa1bb; font-size: 11px; line-height: 1.7; margin-top: auto; }
  #hotkeys .btnrow { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }
  #hotkeys button { font: inherit; font-size: 11px; color: #cdd6e4; background: #1c2432; border: 1px solid #33405a;
    border-radius: 4px; padding: 3px 10px; cursor: pointer; }
  #hotkeys button:hover { background: #263043; }
  #hotkeys button.hk-on { border-color: #ffd866; color: #ffd866; }
  #hotkeys .hk-status { font-size: 11px; color: #6fce7e; margin: -4px 0 8px; }
  #hotkeys .hk-status.hk-bad { color: #e07a6a; }
  #hotkeys .hk-status[hidden] { display: none !important; }
  #hotkeys .hk-close { padding: 0 6px; border-color: transparent; background: transparent; color: #8fa1bb; }
  #hotkeys .hk-close:hover { color: #f0f3f8; background: #263043; }
  `;

  /**
   * The configuration dialog. `hooks.onOpen`/`onClose` let the page hold
   * the game while it is up; while open it owns the keyboard.
   */
  class HotkeyDialog {
    constructor(manager, hooks = {}) {
      this.manager = manager;
      this.hooks = hooks;
      this.selected = null;   // the code being edited
      this.showAll = false;   // unassigned keys too
      this.useLayout = false; // names from the keyboard in use
      this.finding = false;   // the next key pressed is the one to edit
      this.tab = "keyboard";  // or "vr"
      this._build();
    }

    get isOpen() { return !this.dom.root.hidden; }

    _build() {
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);
      const rootEl = document.createElement("div");
      rootEl.id = "hotkeys";
      rootEl.hidden = true;
      const skillOptions = SKILLS.map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}${DOS_SKILLS.has(s) ? "" : " [Lemmix]"}</option>`).join("");
      const specialOptions = SPECIAL_SKIPS.map((s, i) => `<option value="${i}">${s}</option>`).join("");
      const funcOptions = ACTIONS.map((a) => `<option value="${a.id}">${a.label}${a.tag === "lemmix" ? " [Lemmix]" : a.tag === "view" ? " [3D view]" : a.tag === "vr" ? " [VR]" : ""}</option>`).join("");
      rootEl.innerHTML = `
        <div class="hk-dlg" role="dialog" aria-modal="true" aria-labelledby="hk-title">
          <div class="hk-head">
            <h2 id="hk-title">CONFIGURE CONTROLS</h2>
            <span class="hk-note">click a key or a controller input, give it a function; saved in this browser</span>
            <button class="hk-export" title="save the keyboard and VR bindings as a JSON file">export</button>
            <button class="hk-import" title="load bindings from a JSON file, replacing these">import</button>
            <input type="file" class="hk-file" accept=".json,application/json" hidden>
            <button class="hk-close" title="close">&times;</button>
          </div>
          <div class="hk-status" hidden></div>
          <div class="hk-tabs">
            <button data-tab="keyboard" class="hk-on">Keyboard</button>
            <button data-tab="vr">VR</button>
          </div>
          <div class="hk-tools hk-tools-keyboard">
            <span>layout:</span>
            <button data-preset="traditional">traditional</button>
            <button data-preset="functional">functional</button>
            <button data-preset="minimal">minimal</button>
            <label><input type="checkbox" class="hk-unassigned"> show unassigned keys</label>
            <label><input type="checkbox" class="hk-layoutnames"> names from my keyboard</label>
            <button class="hk-find">find key</button>
          </div>
          <div class="hk-tools hk-tools-vr" hidden>
            <button class="hk-vr-reset">back to the default controls</button>
            <span class="hk-hint">the pointing hand is the one with the beam; a trigger pull on the other hand moves it there</span>
          </div>
          <div class="hk-body">
            <div class="hk-list"><table><thead><tr><th class="hk-keyhead">key</th><th>function</th><th></th></tr></thead><tbody></tbody></table></div>
            <div class="hk-edit">
              <div class="hk-editing">click a key in the list</div>
              <label>function <select class="hk-func"><option value="">(none)</option>${funcOptions}</select></label>
              <label class="hk-skill" hidden>skill <select>${skillOptions}</select></label>
              <label class="hk-frames" hidden>frames <input type="number" step="1"><span class="hk-hint">17 frames = 1 second; negative goes back</span></label>
              <label class="hk-hold hk-inline" hidden><input type="checkbox"> hold: on while the key is down</label>
              <label class="hk-special" hidden>skip to <select>${specialOptions}</select></label>
              <div class="hk-legend hk-legend-keyboard">
                <span class="tag lemmix">Lemmix</span> NeoLemmix levels only, nothing on a DOS level<br>
                <span class="tag view">3D view</span> this page's own, not in NeoLemmix<br>
                fixed: arrows pan, shift+arrows orbit; Escape closes what is open
              </div>
              <div class="hk-legend hk-legend-vr" hidden>
                <span class="tag lemmix">Lemmix</span> NeoLemmix levels only, nothing on a DOS level<br>
                <span class="tag vr">VR</span> the headset's own; <span class="tag view">3D view</span> this page's own<br>
                fixed: the trigger clicks, held and moved it drags the board; a grip drags, both grips scale; the buttons on the bar do the rest
              </div>
            </div>
          </div>
          <div class="btnrow"><button class="hk-done">close</button></div>
        </div>`;
      document.body.appendChild(rootEl);
      const q = (sel) => rootEl.querySelector(sel);
      this.dom = {
        root: rootEl, tbody: q("tbody"), editing: q(".hk-editing"), func: q(".hk-func"),
        skillRow: q(".hk-skill"), skill: q(".hk-skill select"),
        framesRow: q(".hk-frames"), frames: q(".hk-frames input"),
        holdRow: q(".hk-hold"), hold: q(".hk-hold input"),
        specialRow: q(".hk-special"), special: q(".hk-special select"),
        unassigned: q(".hk-unassigned"), layoutNames: q(".hk-layoutnames"), find: q(".hk-find"),
        toolsKeyboard: q(".hk-tools-keyboard"), toolsVr: q(".hk-tools-vr"),
        legendKeyboard: q(".hk-legend-keyboard"), legendVr: q(".hk-legend-vr"),
        tabs: Array.from(rootEl.querySelectorAll(".hk-tabs button")),
        status: q(".hk-status"), file: q(".hk-file"),
      };
      q(".hk-export").addEventListener("click", () => this.exportFile());
      q(".hk-import").addEventListener("click", () => { this.dom.file.value = ""; this.dom.file.click(); });
      this.dom.file.addEventListener("change", () => {
        const f = this.dom.file.files && this.dom.file.files[0];
        if (f) this.importFile(f);
      });
      for (const b of this.dom.tabs) b.addEventListener("click", () => this.showTab(b.dataset.tab));
      q(".hk-vr-reset").addEventListener("click", () => { this.manager.applyVrPreset(); this.refresh(); });
      if (!(navigator.keyboard && navigator.keyboard.getLayoutMap)) {
        this.dom.layoutNames.disabled = true;
        this.dom.layoutNames.parentElement.title = "this browser cannot tell the keyboard's labels";
      }
      q(".hk-close").addEventListener("click", () => this.close());
      q(".hk-done").addEventListener("click", () => this.close());
      rootEl.addEventListener("click", (e) => { if (e.target === rootEl) this.close(); });
      for (const b of rootEl.querySelectorAll("[data-preset]")) {
        b.addEventListener("click", () => { this.manager.applyPreset(b.dataset.preset); this.refresh(); });
      }
      this.dom.unassigned.addEventListener("change", () => { this.showAll = this.dom.unassigned.checked; this.refresh(); });
      this.dom.layoutNames.addEventListener("change", () => {
        this.useLayout = this.dom.layoutNames.checked;
        if (this.useLayout) loadLayoutNames().then(() => this.refresh());
        else this.refresh();
      });
      this.dom.find.addEventListener("click", () => this._setFinding(!this.finding));
      this.dom.func.addEventListener("change", () => this._apply());
      this.dom.skill.addEventListener("change", () => this._apply());
      this.dom.frames.addEventListener("change", () => this._apply());
      this.dom.frames.addEventListener("input", () => this._apply());
      this.dom.hold.addEventListener("change", () => this._apply());
      this.dom.special.addEventListener("change", () => this._apply());
      this.dom.tbody.addEventListener("click", (e) => {
        const tr = e.target.closest("tr");
        if (tr && tr.dataset.code) this.select(tr.dataset.code);
      });
      // while open the dialog owns the keyboard: Escape closes it, and a
      // key pressed after "find key" is the one to edit
      this._onKey = (e) => {
        if (!this.isOpen) return;
        if (e.target === this.dom.frames && !this.finding) { e.stopPropagation(); return; }
        if (this.finding) {
          e.preventDefault(); e.stopPropagation();
          this.find(normalizeCode(e.code));
          return;
        }
        if (e.key === "Escape") { e.preventDefault(); this.close(); }
        e.stopPropagation();
      };
      window.addEventListener("keydown", this._onKey, true);
      window.addEventListener("keyup", (e) => { if (this.isOpen) e.stopPropagation(); }, true);
      // the mouse's own keys can be found too
      rootEl.addEventListener("pointerdown", (e) => {
        if (!this.finding || e.button === 0) return;
        e.preventDefault();
        this.find(e.button === 1 ? "MouseMiddle" : "MouseRight");
      });
      rootEl.addEventListener("contextmenu", (e) => { if (this.finding) e.preventDefault(); });
    }

    open(tab) {
      if (this.isOpen) return;
      this.dom.root.hidden = false;
      this._status("");
      if (tab) this.showTab(tab); else this.refresh();
      if (this.hooks.onOpen) this.hooks.onOpen();
    }

    /** The keyboard's keys or the headset's inputs. */
    showTab(tab) {
      this.tab = tab === "vr" ? "vr" : "keyboard";
      this._setFinding(false);
      this.selected = null;
      const vr = this.tab === "vr";
      for (const b of this.dom.tabs) b.classList.toggle("hk-on", b.dataset.tab === this.tab);
      this.dom.toolsKeyboard.hidden = vr;
      this.dom.toolsVr.hidden = !vr;
      this.dom.legendKeyboard.hidden = vr;
      this.dom.legendVr.hidden = !vr;
      this.dom.root.querySelector(".hk-keyhead").textContent = vr ? "input" : "key";
      this.refresh();
    }

    close() {
      if (!this.isOpen) return;
      this._setFinding(false);
      this.dom.root.hidden = true;
      this.manager.save(); // "By clicking on Close you save all hotkey assignments"
      if (this.hooks.onClose) this.hooks.onClose();
    }

    /** A line under the head, green for news, red for a complaint. */
    _status(text, bad) {
      this.dom.status.textContent = text || "";
      this.dom.status.hidden = !text;
      this.dom.status.classList.toggle("hk-bad", !!bad);
    }

    /** The table as a JSON file, through a download. */
    exportFile() {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([this.manager.exportJSON()], { type: "application/json" }));
      a.download = EXPORT_FILE;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      this._status("exported as " + EXPORT_FILE);
    }

    /** A JSON file into the table, the list redrawn, the outcome said. */
    importFile(file) {
      return file.text().then((text) => this.importText(text, file.name)).catch((e) => this._status(String(e.message || e), true));
    }

    importText(text, name) {
      try {
        const r = this.manager.importJSON(text);
        this.selected = null;
        this.refresh();
        this._status((name ? name + ": " : "") + r.loaded + " binding" + (r.loaded === 1 ? "" : "s") + " loaded" +
          (r.skipped ? ", " + r.skipped + " skipped (unknown key or function)" : "") +
          (r.filled && r.filled.length ? ", " + r.filled.join(" and ") + " left at the default" : ""));
        return r;
      } catch (e) {
        this._status((name ? name + ": " : "") + (e.message || e), true);
        return null;
      }
    }

    _setFinding(on) {
      this.finding = on;
      this.dom.find.classList.toggle("hk-on", on);
      this.dom.find.textContent = on ? "press a key…" : "find key";
    }

    /** "Find key": the key pressed is selected, listed even when unassigned. */
    find(code) {
      this._setFinding(false);
      if (!KEY_BY_CODE.has(code)) return;
      if (!this.manager.get(code) && !this.showAll) {
        this.showAll = true;
        this.dom.unassigned.checked = true;
      }
      this.refresh();
      this.select(code);
      const tr = this.dom.tbody.querySelector(`tr[data-code="${code}"]`);
      if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: "nearest" });
    }

    /** The list: every key with a function, all of them when asked. */
    refresh() {
      const rows = [];
      const vr = this.tab === "vr";
      for (const k of (vr ? VR_KEYS : KEYS)) {
        const b = this.manager.get(k.code);
        if (!b && !this.showAll && !vr) continue; // the headset's few inputs are always listed
        const tag = tagOf(b);
        rows.push(`<tr data-code="${k.code}" class="${b ? "" : "hk-empty"}${this.selected === k.code ? " hk-sel" : ""}">` +
          `<td>${escapeHtml(keyName(k.code, this.useLayout))}</td>` +
          `<td class="hk-fn">${b ? escapeHtml(describe(b)) : "(none)"}</td>` +
          `<td>${tagChip(tag)}</td></tr>`);
      }
      this.dom.tbody.innerHTML = rows.join("");
      if (this.selected && !this.dom.tbody.querySelector(`tr[data-code="${this.selected}"]`)) this.selected = null;
      this._showEditor();
    }

    select(code) {
      this.selected = code;
      for (const tr of this.dom.tbody.querySelectorAll("tr")) tr.classList.toggle("hk-sel", tr.dataset.code === code);
      this._showEditor();
    }

    /** The editor for the selected key: its function and the detail that function needs. */
    _showEditor() {
      const d = this.dom;
      const code = this.selected;
      const b = code ? this.manager.get(code) : null;
      d.editing.textContent = code ? "editing: " + keyName(code, this.useLayout) : (this.tab === "vr" ? "click an input in the list" : "click a key in the list");
      d.func.disabled = !code;
      // only the functions this input can take
      for (const opt of d.func.options) opt.hidden = !!(code && opt.value && !allowedOn(code, opt.value));
      d.func.value = b ? b.action : "";
      const a = b ? ACTION_BY_ID.get(b.action) : null;
      const mod = a ? a.mod : null;
      d.skillRow.hidden = mod !== "skill";
      d.framesRow.hidden = mod !== "frames";
      d.holdRow.hidden = mod !== "hold";
      d.specialRow.hidden = mod !== "special";
      if (mod === "skill") d.skill.value = b.mod;
      if (mod === "frames") d.frames.value = String(b.mod | 0);
      if (mod === "hold") d.hold.checked = !!b.mod;
      if (mod === "special") d.special.value = String(b.mod | 0);
    }

    /** The editor's state into the table (cbFunctionsChange and friends). */
    _apply() {
      const code = this.selected;
      if (!code) return;
      const action = this.dom.func.value || null;
      const a = action ? ACTION_BY_ID.get(action) : null;
      const was = this.manager.get(code);
      const same = !!(was && was.action === action);
      // a function just chosen starts from its own default detail; one being
      // edited takes the detail from its field
      let mod = 0;
      if (a && a.mod === "skill") mod = this.dom.skill.value || SKILLS[0];
      else if (a && a.mod === "frames") { const n = parseInt(this.dom.frames.value, 10); mod = same && Number.isFinite(n) ? n : 1; }
      else if (a && a.mod === "hold") mod = same && this.dom.hold.checked ? 1 : 0;
      else if (a && a.mod === "special") mod = same ? (parseInt(this.dom.special.value, 10) || 0) : 0;
      this.manager.set(code, action, mod);
      // the list changes under the selection; keep it
      const keep = this.selected;
      this.refresh();
      this.select(keep);
    }
  }

  function tagChip(tag) {
    if (tag === "lemmix") return '<span class="tag lemmix">Lemmix</span>';
    if (tag === "view") return '<span class="tag view">3D view</span>';
    if (tag === "vr") return '<span class="tag vr">VR</span>';
    return "";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  root.Hotkeys = {
    ACTIONS, ACTION_BY_ID, KEYS, VR_KEYS, VR_PRESET, SKILLS, DOS_SKILLS, SPECIAL_SKIPS, PRESETS, DEFAULT_PRESET,
    HotkeyManager, HotkeyDialog, normalizeCode, keyName, describe, tagOf, allowedOn, isVrCode, loadLayoutNames,
    EXPORT_FORMAT, EXPORT_FILE,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Hotkeys;
})(typeof window !== "undefined" ? window : globalThis);
