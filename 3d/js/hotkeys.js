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
 * The table lives in localStorage; the dialog (FEditHotkeys.pas) is the
 * page's: a list of keys, a function for the chosen one with its detail,
 * "show unassigned keys", "find key", the three layouts. A function that
 * does nothing on a DOS level is tagged Lemmix; one that is the page's own
 * and not NeoLemmix's is tagged 3D view.
 */
(function (root) {
  const STORAGE_KEY = "lem3d-hotkeys";
  const VERSION = 1;

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
  ];
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
    if (a.tag) return a.tag;
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
            return;
          }
        } catch (e) { /* unreadable: start over */ }
      }
      this.applyPreset(DEFAULT_PRESET, false);
    }

    save() {
      const keys = {};
      for (const [code, b] of this.table) keys[code] = { action: b.action, mod: b.mod };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, keys })); } catch (e) { /* no storage */ }
    }

    _changed() { if (this.onChange) this.onChange(); }

    applyPreset(name, save = true) {
      const preset = PRESETS[name];
      if (!preset) return;
      this.table.clear();
      for (const [code, action, mod] of preset) this.table.set(code, { action, mod: mod == null ? defaultMod(action) : mod });
      if (save) this.save();
      this._changed();
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
      // a keyboard key over a mouse button, when both do it
      codes.sort((a, b) => (a.startsWith("Mouse") ? 1 : 0) - (b.startsWith("Mouse") ? 1 : 0));
      return codes.length ? keyName(codes[0]) : "";
    }
  }

  // ---------------------------------------------------------------- names
  let layoutNames = null; // code -> label from the keyboard in use, once asked for

  /** A key's name: the layout's label when asked for and known, else NeoLemmix's. */
  function keyName(code, useLayout) {
    if (useLayout && layoutNames && layoutNames.has(code)) return layoutNames.get(code);
    const k = KEY_BY_CODE.get(code);
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
      const funcOptions = ACTIONS.map((a) => `<option value="${a.id}">${a.label}${a.tag === "lemmix" ? " [Lemmix]" : a.tag === "view" ? " [3D view]" : ""}</option>`).join("");
      rootEl.innerHTML = `
        <div class="hk-dlg" role="dialog" aria-modal="true" aria-labelledby="hk-title">
          <div class="hk-head">
            <h2 id="hk-title">CONFIGURE HOTKEYS</h2>
            <span class="hk-note">click a key, give it a function; saved in this browser</span>
            <button class="hk-close" title="close">&times;</button>
          </div>
          <div class="hk-tools">
            <span>layout:</span>
            <button data-preset="traditional">traditional</button>
            <button data-preset="functional">functional</button>
            <button data-preset="minimal">minimal</button>
            <label><input type="checkbox" class="hk-unassigned"> show unassigned keys</label>
            <label><input type="checkbox" class="hk-layoutnames"> names from my keyboard</label>
            <button class="hk-find">find key</button>
          </div>
          <div class="hk-body">
            <div class="hk-list"><table><thead><tr><th>key</th><th>function</th><th></th></tr></thead><tbody></tbody></table></div>
            <div class="hk-edit">
              <div class="hk-editing">click a key in the list</div>
              <label>function <select class="hk-func"><option value="">(none)</option>${funcOptions}</select></label>
              <label class="hk-skill" hidden>skill <select>${skillOptions}</select></label>
              <label class="hk-frames" hidden>frames <input type="number" step="1"><span class="hk-hint">17 frames = 1 second; negative goes back</span></label>
              <label class="hk-hold hk-inline" hidden><input type="checkbox"> hold: on while the key is down</label>
              <label class="hk-special" hidden>skip to <select>${specialOptions}</select></label>
              <div class="hk-legend">
                <span class="tag lemmix">Lemmix</span> NeoLemmix levels only, nothing on a DOS level<br>
                <span class="tag view">3D view</span> this page's own, not in NeoLemmix<br>
                fixed: arrows pan, shift+arrows orbit; Escape closes what is open
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
      };
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

    open() {
      if (this.isOpen) return;
      this.dom.root.hidden = false;
      this.refresh();
      if (this.hooks.onOpen) this.hooks.onOpen();
    }

    close() {
      if (!this.isOpen) return;
      this._setFinding(false);
      this.dom.root.hidden = true;
      this.manager.save(); // "By clicking on Close you save all hotkey assignments"
      if (this.hooks.onClose) this.hooks.onClose();
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
      for (const k of KEYS) {
        const b = this.manager.get(k.code);
        if (!b && !this.showAll) continue;
        const tag = tagOf(b);
        rows.push(`<tr data-code="${k.code}" class="${b ? "" : "hk-empty"}${this.selected === k.code ? " hk-sel" : ""}">` +
          `<td>${escapeHtml(keyName(k.code, this.useLayout))}</td>` +
          `<td class="hk-fn">${b ? escapeHtml(describe(b)) : "(none)"}</td>` +
          `<td>${tag === "lemmix" ? '<span class="tag lemmix">Lemmix</span>' : tag === "view" ? '<span class="tag view">3D view</span>' : ""}</td></tr>`);
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
      d.editing.textContent = code ? "editing key: " + keyName(code, this.useLayout) : "click a key in the list";
      d.func.disabled = !code;
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  root.Hotkeys = {
    ACTIONS, ACTION_BY_ID, KEYS, SKILLS, DOS_SKILLS, SPECIAL_SKIPS, PRESETS, DEFAULT_PRESET,
    HotkeyManager, HotkeyDialog, normalizeCode, keyName, describe, tagOf, loadLayoutNames,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Hotkeys;
})(typeof window !== "undefined" ? window : globalThis);
