"use strict";
/**
 * The NeoLemmix text format, as read by LemNeoParser.pas: one keyword per
 * line, the value being everything after the first space; `$NAME` opens a
 * section that `$END` closes (sections nest); `#` starts a comment; keys are
 * case-insensitive; a key with no value is a flag. Level files (.nxlv), pack
 * metadata (.nxmi), gadget and terrain metadata (.nxmo, .nxmt), themes
 * (.nxtm) and sprite schemes (scheme.nxmi) all use it.
 *
 * Two real-world quirks are absorbed here: some editor builds indent every
 * line and leave a trailing space after `$SKILLSET`, and a 16-bit signed
 * coordinate can arrive as its unsigned value (65483 for -53) - `int16`
 * folds it back.
 *
 * Usable from the page (window.Lemmix) and from node (module.exports).
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});

  class NxSection {
    constructor(name) {
      this.name = name;       // upper-case, null for the file itself
      this.entries = [];      // {key, value} in file order
      this.sections = [];     // child sections in file order
    }

    /** The value of a key - the last one, as NeoLemmix reads it - or null. */
    get(key) {
      key = key.toUpperCase();
      for (let i = this.entries.length - 1; i >= 0; i--) {
        if (this.entries[i].key === key) return this.entries[i].value;
      }
      return null;
    }

    /** Every value of a repeated key (LEVEL, TRACK, LINE ...). */
    getAll(key) {
      key = key.toUpperCase();
      return this.entries.filter((e) => e.key === key).map((e) => e.value);
    }

    /** Whether the key appears at all - how flags are read. */
    has(key) {
      key = key.toUpperCase();
      return this.entries.some((e) => e.key === key);
    }

    /** An integer value (decimal, or hex written as x1F), else the default. */
    int(key, dflt) {
      const v = this.get(key);
      if (v === null || v === "") return dflt === undefined ? null : dflt;
      const n = NxSection.number(v);
      return Number.isNaN(n) ? (dflt === undefined ? null : dflt) : n;
    }

    /** An integer that was meant to be signed 16-bit (a coordinate). */
    int16(key, dflt) {
      const n = this.int(key, dflt);
      return n !== null && n >= 32768 && n <= 65535 ? n - 65536 : n;
    }

    /** All child sections of a name. */
    sectionsNamed(name) {
      name = name.toUpperCase();
      return this.sections.filter((s) => s.name === name);
    }

    /** The first child section of a name, or null. */
    section(name) {
      name = name.toUpperCase();
      return this.sections.find((s) => s.name === name) || null;
    }

    static number(v) {
      v = String(v).trim();
      if (/^x[0-9a-f]+$/i.test(v)) return parseInt(v.slice(1), 16);
      if (/^-?\d+$/.test(v)) return parseInt(v, 10);
      return NaN;
    }
  }

  /** Parse a whole file into its root section. */
  function parse(text) {
    const file = new NxSection(null);
    const stack = [file];
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line[0] === "#") continue;
      if (line[0] === "$") {
        const name = line.slice(1).trim().toUpperCase();
        if (name === "END") {
          if (stack.length > 1) stack.pop();
          continue;
        }
        const section = new NxSection(name);
        stack[stack.length - 1].sections.push(section);
        stack.push(section);
        continue;
      }
      const sp = line.indexOf(" ");
      const key = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const value = sp < 0 ? "" : line.slice(sp + 1).trim();
      stack[stack.length - 1].entries.push({ key, value });
    }
    return file;
  }

  /** A NeoLemmix colour (xRRGGBB or RRGGBB) as 0xRRGGBB, or null. */
  function color(v) {
    if (v === null || v === undefined) return null;
    const m = /^x?([0-9a-f]{6})$/i.exec(String(v).trim());
    return m ? parseInt(m[1], 16) : null;
  }

  Lemmix.NxSection = NxSection;
  Lemmix.NxParser = { parse, color };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Lemmix.NxParser;
    module.exports.NxSection = NxSection;
  }
})(typeof window !== "undefined" ? window : globalThis);
