# Level packs

One subdirectory per level pack: a DOS game's files (`MAIN.DAT`,
`LEVEL000.DAT`, ...) registered in `../config.json`, or a NeoLemmix pack (a
`levels.nxmi` with its rank folders of `.nxlv` levels). Nothing here is
committed, this README apart.

Two ways to fill it:

- **The setup page** (`3d/setup.html`, the Setup button of the 3D page):
  installs the classic games from the LemmingsJS repository and any pack zip
  or folder into the browser's own storage, and serves them from there in
  the *static* asset mode. Nothing lands in this folder.
- **On disk**, for the *server* asset mode: copy the pack folder here as
  downloaded (e.g. `levels/LemmingsPlus_All_20201114/`), then either serve
  with the launcher, which lists the folder live, or run
  `node tools/levels-index.js` to write `levels/index.json`.

See the root README, "Levels and assets".
