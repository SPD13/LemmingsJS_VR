# NeoLemmix assets

The Lemmix engine (`lemmix/`) needs NeoLemmix's own files: the `styles/`
graphics that levels reference, the panel and mask graphics in `gfx/`, the
sound effects in `sound/`, and the music packs in `music/`. This folder is
laid out like a NeoLemmix install so the downloads unpack straight into it.

1. Download NeoLemmix and the styles package from
   https://www.neolemmix.com/?page=neolemmix (the music packs are linked
   from the same site, https://www.neolemmix.com/?page=music_packs).
2. Unzip them **here**, in this folder, so that you end up with

   ```
   neolemmix/
     styles/    orig_dirt/, namida_abstract/, ... (the styles package)
     gfx/       panel/, mask/, ...              (from the NeoLemmix zip)
     sound/     *.wav, *.ogg                    (from the NeoLemmix zip)
     music/     orig_01.*, ohno_01.*, ...       (the music packs)
   ```

   `NeoLemmix.exe` and the rest of the zip can stay; nothing here reads
   them.

Nothing in this folder except this README is committed: `.gitignore`
excludes `neolemmix/*`, since the files belong to NeoLemmix and its style
authors. Level packs go in `levels/` instead (see the root README, "Levels
and assets").
