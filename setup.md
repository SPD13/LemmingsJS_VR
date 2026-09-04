# Setup guide

Lemmix JS+VR is an engine, not a game: the distribution carries **no
copyrighted assets**. No level, sprite, sound or music of Lemmings, Oh No!
More Lemmings or NeoLemmix is part of it, and `.gitignore` keeps the
`levels/` and `neolemmix/` folders out of the repository. To play, the game
data has to come from its own publishers, and this page explains what to
fetch, where, and how to install it.

The **setup page** (`setup.html`, the gear icon on the right edge of the
game page; the game opens it by itself the first time nothing is installed)
does the installing. Its head shows a **Play** link once everything needed
is there and, until then, what is still missing.

## Two ways to install: static, or the launcher

The game reads its data in one of two **asset modes**, shown and switched
at the top of the setup page (`?assets=static` or `?assets=server` in the
URL chooses too, and the choice is remembered). They are two ways of
installing, with different trade-offs.

### Static: the easiest

The files live in this browser's own storage, installed from the setup
page in a few clicks: save the zips, drop them on the page, done. Nothing
goes to a server and no program runs on the machine. It is the mode of a
site hosted with nothing but the engine, such as GitHub Pages, and of any
device that can open the page - a headset's browser included.

The price is that the install belongs to that one browser on that one
device, and it goes with the site's data: **if the browser's data is wiped
(clearing the site's storage, a browser reset, a cleanup that reclaims
space), the install is lost** and has to be done again from the zips. The
setup page asks the browser to keep the storage persistent, which makes a
silent cleanup unlikely, but a deliberate clear still takes it. Keep the
downloaded zips, and export the configuration files (below) now and then:
the progress and the bindings live in the same browser storage.

### The launcher: one install for the local network

The **launcher** (`launcher/`, a small Electron app: `npm install && npm
start` there, or `node launcher/server.js [port]` from a terminal without
Electron) serves the repository from disk. The files are unzipped once
into the `neolemmix/` and `levels/` folders next to the pages (see
`neolemmix/README.md` and `levels/README.md`), and the game reads them
from the server: the *server* mode. Nothing is kept in a browser, so a
wiped browser loses nothing but the player's own files, and the install is
easy to back up: it is two folders.

The launcher listens on every interface and shows two addresses: the
machine's own (`http://localhost:<port>/`) and its address on the local
network, which a headset, a tablet or another computer on the same network
opens to play from the same install - one setup for every device in the
house. It serves HTTPS by default with a self-signed certificate, which is
what WebXR needs to run on another device; that device sees a certificate
warning once (Advanced, proceed). The same server is what saves the depth
tagging of the piece editor and the galleries page, which the static mode
cannot.

Any other web server does the job too, with the indexes written by
`node tools/levels-index.js` and `node tools/styles-index.js` (the launcher
builds them live).

### Which one to pick

| | Static | Server (the launcher) |
| --- | --- | --- |
| Install | A few clicks on the setup page, nothing to run | Unzip two folders, and a machine has to run the launcher while you play |
| Where the data lives | This browser's storage, on this device | Two folders on the machine's disk, easy to back up and to copy |
| Per device | Every device installs its own copy, styles package included | One install serves every device on the local network |
| Config, progress, controls | This browser's own, per device | Shared: the same files for every device |
| If the browser's data is wiped | The install is lost, zips needed again | Nothing is lost |
| Away from home | Works anywhere the page opens, offline included | Only on the launcher's network |
| Piece editor, galleries | Cannot save the depth tagging | Saves it |

The difference that shows up in play is the sharing. In server mode the
controller bindings, the preferences and the progress are three files the
server keeps (`config/`, see `config/README.md`); every page that opens the
launcher's address reads them and writes them back as settings change. The
levels and the assets are the same folders on the same disk. So the headset
and the desktop are one installation: clear a level standing up in VR and
the desktop shows it cleared, rebind a key at the desktop and the headset
plays with that binding, install a level pack once and every device has it.
In static mode each browser is its own island - the same zips installed
again on each device, and progress that only moves by hand, through the
Configuration section's download and upload.

The sharing has one catch, which is that it is a single shared profile:
there is no per-player separation, and two devices playing at once each
write the whole file, so the last save wins. Playing one device at a time,
which is the usual case, has nothing to notice.

Both modes can live side by side - a launcher install at home and a static
install in the headset for the road - as long as the progress is carried
across by hand when it matters.

The instructions below name the setup page's buttons for the static mode
and the folder for the launcher.

## What is needed

| Asset | What it is | Where |
| --- | --- | --- |
| **NeoLemmix** (the engine zip, about 7 MB) | The panel and mask graphics (`gfx/`), the sound effects (`sound/`), the classic styles and NeoLemmix's own two level packs | https://www.neolemmix.com/?page=neolemmix - "NeoLemmix V12.14.0" |
| **The styles package** (about 92 MB) | Every style (terrain and object graphics) the community's level packs use | Same page - "styles package" |
| **Level packs** | At least one: NeoLemmix packs (`.nxlv` levels) or a classic game's files (below) | https://www.neolemmix.com/?page=level_packs (Lemmings Plus, about 22 MB for all of them); https://www.lemmingsforums.net, "NeoLemmix Level Packs" |
| **Music packs** (optional) | The tracker music NeoLemmix levels ask for; a level without its track plays silently | https://www.neolemmix.com/?page=music_packs |

NeoLemmix and the styles package are required to play anything, the classic
games included: the game page's Play link waits for both and for one level
pack. The music packs are for the launcher only (unzip them into
`neolemmix/music/`); the setup page has no install for them.

### Installing NeoLemmix and the styles package

neolemmix.com does not let a web page download its files by itself (it
sends no CORS headers), so each install is two steps:

1. Click **get NeoLemmix** (or **get the styles package**): the official
   download opens in a new tab and the browser saves the zip.
2. Click **install zip…** on the same row and pick the zip you saved, or
   drop the zip on the row. The page unpacks it into the browser's storage:
   about a second for NeoLemmix, about twenty for the styles package. The
   dot of the row turns green, and the button reads "re-install zip…" from
   then on (a re-install removes the previous files first, after a
   confirmation).

Launcher: unzip both into `neolemmix/` so that it holds `styles/`,
`gfx/`, `sound/` (and `music/` for the music packs).

### Installing level packs

- **The Lemmings Plus packs**: **get Lemmings Plus** opens the official
  download, then **install zip…** (or a drop on the Levels section) unpacks
  the saved zip. Any other NeoLemmix pack goes in the same way: a zip lands
  under the one folder its entries share, or under a folder named after the
  zip; a collection wrapping packs in `levels/` and `music/` keeps that
  layout.
- **A folder**: **upload a folder…** stores a pack folder from disk under
  its own name.
- **The classic games**: see the next section.

Launcher: copy the pack folder into `levels/` as downloaded, for example
`levels/LemmingsPlus_All_20201114/`; the launcher lists it live (another
web server needs `node tools/levels-index.js` run afterwards).

## The original games: importing your own copy

If you own **Lemmings** or **Oh No! More Lemmings** (the DOS releases),
their data files play in this engine as they are - the DOS levels,
graphics and AdLib music are read straight from the original files. The
same goes for the Christmas and Holiday editions. The engine needs the
files of the game folder, not the executable:

| File | Holds |
| --- | --- |
| `MAIN.DAT` | The lemming sprites, the panel and the fonts |
| `GROUND0O.DAT` … `GROUND4O.DAT`, `VGAGR0.DAT` … `VGAGR4.DAT` | The tilesets: the terrain and object graphics of each "ground set" |
| `LEVEL000.DAT` … `LEVEL009.DAT` (Lemmings) or `DLVEL000.DAT` … `DLVEL012.DAT` (Oh No!) | The levels, packed ten per file |
| `VGASPEC0.DAT` … `VGASPEC3.DAT` (Lemmings) | The four special levels' full-screen graphics |
| `ODDTABLE.DAT` (Lemmings, when present) | The alternative ratings some levels reuse |
| `ADLIB.DAT` | The music and sound effects |

The folder must carry the name the engine's `config.json` registers for
that game, which is how the difficulty names and the level order are known:

| Game | Folder name |
| --- | --- |
| Lemmings | `lemmings` |
| Oh No! More Lemmings | `lemmings_ohNo` |
| Xmas Lemmings 1991 | `lemmings_X-Mas91` |
| Xmas Lemmings 1992 | `lemmings_X-Mas92` |
| Holiday Lemmings 1993 | `lemmings_Holiday93` |
| Holiday Lemmings 1994 | `lemmings_Holiday94` |

To import them in the static mode, on the setup page's Levels section:

1. Copy the `.DAT` files of the game into a folder with that name (say
   `lemmings`), or zip them so that the zip is named after it
   (`lemmings.zip` with the files at its root, or a zip holding the one
   folder `lemmings/`).
2. **upload a folder…** and pick the folder, or **install zip…** (or a
   drop on the section) with the zip. The directory appears in the list
   with the "classic" badge and its level count: 120 levels for Lemmings,
   100 for Oh No!.

Launcher: copy the folder into `levels/` under the same name
(`levels/lemmings/`, `levels/lemmings_ohNo/`).

The **Lemmings & Oh No! More Lemmings (LemmingsJS git)** button fetches the
same files from the LemmingsJS repository on GitHub
(https://github.com/oklemenz/LemmingsJS, through jsDelivr), where that
project publishes them; they are that project's to distribute, not this
one's.

## Your own files

The Configuration section of the setup page downloads and uploads, as JSON
files, the controller bindings, the preferences (everything the game page
keeps in this browser) and the level progress (clears, best times, most
lemmings saved, talismans; merged on upload, so a clear is never lost).
They move a setup from one browser or device to another.

## Storage

The setup page shows how much of the site's storage is in use and asks the
browser to keep it persistent. The service worker that serves the static
mode needs `localhost` or HTTPS; on any other address the page installs but
the game cannot play from the store. A hard reload (⇧ reload, or Ctrl+F5)
bypasses the worker for that one load, which is also what a version warning
at the top of the page asks for.
