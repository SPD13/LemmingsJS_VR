# Tagging guide

The 3D view is not a picture of a Lemmings level, it is a **diorama** built
from one: every solid pixel becomes a column standing out of a slab, and the
level's own artwork is the skin on it. That works because Lemmings terrain is
drawn as one flat layer, but a flat layer is exactly what a diorama has to
guess at. The picture says a bridge is drawn *over* a cliff; it does not say
the bridge stands in front of it. The picture says a patch of grass is lighter
in places; it does not say the light places are the blades.

**Tagging is where those answers are stored.** A handful of settings per
terrain sprite, kept in small JSON files, telling the renderer what a piece is
in three dimensions. Nothing is guessed at run time, nothing is inferred from
the level, and nothing has to be redone level by level: a tag belongs to the
*sprite*, so tagging a piece once fixes it in every level of every pack that
draws it.

Two things it deliberately is not. It never touches the simulation: the game
keeps its own collision mask and a tag cannot change where a lemming walks,
falls or digs. And it is never required: an untagged level plays and looks
perfectly reasonable, since the defaults are chosen to suit the great majority
of pieces. Tagging is the polish.

- [Starting edit mode](#starting-edit-mode)
- [The workbench](#the-workbench)
- [Choosing a piece](#choosing-a-piece)
- [The tagging options](#the-tagging-options)
  - [Terrain layer](#terrain-layer-backdrop--terrain--relief--overlay--auto)
  - [3D rendering: 3D shade and invert](#3d-rendering-3d-shade-and-invert)
  - [3D rendering: 3D object](#3d-rendering-3d-object)
  - [Surface: surface blend](#surface-surface-blend)
  - [Surface: colour blend](#surface-colour-blend)
  - [Controls](#controls-save--export-json--reset-all)
- [Where the tags are kept](#where-the-tags-are-kept)
- [Saving in server mode](#saving-in-server-mode)
- [Exporting in static mode](#exporting-in-static-mode)
- [Updating the tagging, either way](#updating-the-tagging-either-way)
- [The sprite galleries](#the-sprite-galleries)
- [The file format](#the-file-format)

## Starting edit mode

The page has two modes. **Play** is the game and is the default; **edit** is
the tagging workbench, which bills itself as *validation mode* in the title
bar. Three ways in, all equivalent:

- The **pencil icon** in the panel down the right edge of the game page.
- The **piece-editor key**: `J` with the default (traditional) key preset,
  `K` with the functional preset, unbound in the minimal one. Whichever it is,
  the key table under the keyboard icon names it, and it can be rebound there.
- **`?edit=1`** in the address, which loads straight into the mode.

The mode is *not* remembered: every visit starts in play mode unless the
address asks otherwise. Only the URL, the icon or the key selects editing.

Entering edit mode opens the **piece editor** panel at the bottom right and
**pauses the simulation** — a piece is far easier to tag when nothing is
walking over it. Leaving the mode puts the clock back where it was. Pressing
the key again while already in edit mode folds the panel away without leaving
the mode; the pencil icon leaves it altogether.

Edit mode is desktop only. There is no in-headset equivalent: the panel is DOM,
and tagging wants a mouse.

## The workbench

The panel has five parts, top to bottom: the info line, the file list, the
four labelled rows of buttons, the two links under them, and the message
line.

**The info line** describes the selected piece and everything currently true of
it — how many times the level places it, its depth class (and whether that is a
tag or the default), the state of each of the four effect tags (`3D shade`,
with which shades it raises; `3D object`; `surface blend`; `colour blend`),
and the file its tags live in, marked `(unsaved)` when that file has changes
that are not on disk. With nothing selected it reads `click a terrain piece to
tag it`, plus a count of files with unsaved changes.

**The file list** names every sprite gallery this level draws from — one line
each, since a NeoLemmix level can mix pieces from several styles. Each line
links to that gallery on the galleries page, shows how many tags the file holds
and whether it exists on disk yet, carries a `● unsaved` mark once it has
changes, and offers a `⤓ json` link that downloads that one file.

**The tag buttons**, in three labelled rows, one row per kind of question:

| Row | Buttons | What it answers |
| --- | --- | --- |
| **Terrain layer** | `backdrop` `terrain` `relief` `overlay` `auto` | How far out of the slab the piece stands — its depth class. One of the four, or `auto` for the default. |
| **3D rendering** | `3D shade` `invert` `3D object` | What the piece's shading is read as: grain on its face (`3D shade`, with `invert` for pieces drawn with dark highlights), or the shape of a solid body (`3D object`). |
| **Surface** | `surface blend` `colour blend` | How its colours are spread: down the extruded side walls (`surface blend`), and into the neighbouring pixels (`colour blend`). |

Each button is described in [The tagging options](#the-tagging-options)
below, under the row it belongs to. A lit button is the state the piece is in,
not a button waiting to be pressed, so a freshly selected untagged piece shows
`auto`, `3D shade`, `surface blend` and `colour blend` lit, since those are
the defaults. The buttons are disabled until a piece is selected.

**The controls** — `save`, `export JSON` and `reset all` — in a fourth row,
labelled *Controls*. They act on the level's files rather than on the
selected piece, so they work with nothing selected.

**The links**, small and under the controls: *see in gallery* opens the
galleries page on the selected piece, scrolled to its sprite — or at the root
of the galleries with nothing selected — asking first if any file holds
unsaved tags; *help* opens this document in a new tab, leaving the page as it
is. Both are ordinary links, so they can be middle-clicked or copied.

**The message line**, last, gives the result of the last save or export.

On a **special level** — the handful that ship as one pre-rendered image
(VGASPEC) rather than as a list of placed pieces — the info line reads `no
piece data for this level (special level)` and there is nothing to tag. Those
levels have no pieces in the sense the renderer means.

## Choosing a piece

Click the piece in the 3D view. The click goes by what is under the pointer
**in the diorama**: the ray is marched through the extrusion, so what gets
selected is the piece whose surface pixel the cursor is on — the top of a
column, or the wall it is seen through from the side — rather than whatever the
level's flat plane, which sits well behind it once perspective has slid things
across the screen, happens to name. Clicking empty sky clears the selection.

The selected piece lights up as a translucent yellow volume: its own outline
extruded up to one flat face standing a pixel proud of the terrain, with a
fainter pass drawn over everything so a placement buried behind another still
shows where it is. **Every placement of the piece in the level lights at once**
— that is the point, since a tag covers them all. Only the pixels the level
actually draws for the piece are lit, so a part covered by a later piece,
erased, or dug away is left dark.

The 2D view can tag too. Having no depth to see past, it picks and highlights
on the level's own plane, but from the same footprint.

## The tagging options

The options follow the panel's rows: the terrain layer first, then the two
readings of the shading, then the two blends, then the controls. Every option
is a *tag* on the sprite, kept in its gallery's profile file (see [Where the
tags are kept](#where-the-tags-are-kept)); the panel and the galleries page
set the same tags.

### Terrain layer: `backdrop` · `terrain` · `relief` · `overlay` · `auto`

**What it decides:** how far out of the slab the piece's pixels stand — the
piece's *depth class*. This is the one tag whose whole job is the diorama's
geometry rather than its colours, and the one with the most states: four
classes and the default.

Each class is a Z band, in game pixels, measured from the back of the slab:

| Class | Front face at | Front shading | What it is for |
| --- | --- | --- | --- |
| `backdrop` | 3 | dimmed to 62% | Scenery that belongs *behind* the action: sky decoration, far walls, painted-on background. It sits in a recess and is darkened, so it reads as distance. |
| `terrain` | 16 | full | The main slab, and the default. Nearly every drawn pixel in Lemmings is standable ground, so this is right far more often than not. |
| `relief` | 22 | full | Anything that should stand *proud* of the main slab: a girder crossing a wall, a rope, a plant, a rock stuck to a cliff. |
| `overlay` | 18 | full | A decal layer just in front of the slab — markings, stains, small details drawn onto the terrain rather than being terrain. |

Every class starts at the back of the slab (Z 0); what differs is where its
front face lands. Where two classes meet, the taller one grows a wall down to
the shorter, which is what makes a relief piece read as attached rather than
floating.

`auto` is not a fifth class: it **removes** the tag, so the piece falls back to
the default, which is `terrain`. The info line distinguishes the two —
`tagged: relief` against `auto: terrain` — so it is always clear whether a
piece is deliberately terrain or merely untagged.

The **cycle-class key** (`K` traditional, `L` functional) walks the selected
piece through terrain → relief → backdrop → overlay → auto and round again,
which is quicker than aiming at buttons when working through a tileset.

Depth class has no master switch. It is always in force.

### 3D rendering: `3D shade` and `invert`

**What it decides:** whether the piece's own shading is read as height — as
*grain* on the face. The other button of the row, `3D object`, reads it as a
body instead, and is described next.

Lemmings tilesets shade a single hue — a cliff is one brown, lighter where the
artist meant it to catch light. `3D shade` takes that at its word: within the
pixels being embossed, brightness is measured across the whole range in use and
each pixel is pushed up to **4 game pixels** further toward the viewer in
proportion. Rock gains grain, grass gains blades, brick gains its mortar
courses — real texture, from artwork that never had any.

**Pieces opt out, not in.** It is on for everything by default, because it
suits nearly everything, and the tag exists for the pieces it does not suit.
The button is lit until you turn it off.

`invert` is for pieces drawn the other way round — with dark highlights, where
the *darker* pixels are the ones meant to stand proud. It flips the mapping,
and turns the shade on if it was off. In the file this is the value `"invert"`
rather than `true` or `false`, so it is one setting with three states, not two
tags: the two buttons show the state between them — `3D shade` lit on its
own is light raised, both lit is dark raised, neither is off.

Held on top by the **"3D terrain"** switch in the 3D effects drawer, which
turns the effect off across the board. It multiplies the terrain's triangle
count, so that switch is also the answer if the frame rate suffers. With it
off, the tag is still recorded but shows nothing.

### 3D rendering: `3D object`

**What it decides:** whether the piece is a flat picture of a solid object,
to be given that object's shape back.

Where `3D shade` is texture, this is geometry: the slab's face is reshaped
into the body, so a tagged bottle is a real bulge with its own walls, round
when the view swings to its side, not a bottle-shaped decal.

Some sprites are not ground at all but things: a mustard bottle, a sausage,
a barrel, a pipe. The artist drew them the way a lit rounded body looks,
shaded in bands running the length of it — a cylinder lit from one side is
light down that side and dark down the other, and the band between, the one
facing you, is the nearest part of it. So a pixel's shade says which way its
bit of surface *faces*, not how near it is: the light rim and the dark rim
are at the same depth. `3D shade` reads brightness as height, which is fine
for a few pixels of grain and wrong for a body.

What the shading does say is which way the body **runs**: the bands lie along
it, so the colour changes across it. `3D object` reads the piece as a body
turned on that axis — a lathe. Every row across the axis (every column, for
a piece that lies) is cut into its runs of solid pixels, and each run is one
round slice: as deep as it is wide, a semicircle for its profile, its two rims
on the class band's face and its middle standing proud by the run's radius, up
to a cap of 24 game pixels. A bottle 32 wide comes 16 pixels out of the slab
along its body, less through its neck, and to a point at the tip of its cap,
all from its outline; which side the artist lit it from makes no difference.
The outline is the sprite's own, so a part of it hidden behind another piece
still shapes the part that shows. A piece of one flat colour has no bands to
read and is turned on its longer side.

**Pieces opt in.** It is off for everything by default: nearly every drawn
pixel is ground, and ground read as a body would stand out of the slab as a
row of bumps. The button is lit only for the pieces tagged in. On those
pixels it replaces the 3D shade, whatever that tag says (`invert` included),
and they are left out of the shade's brightness range so a bright bottle
cannot flatten the grain on the rock beside it.

Like the shade, it is held on top by the **"3D terrain"** switch: that is the
switch that answers the triangle count, and a body costs what grain costs.

### Surface: `surface blend`

**What it decides:** what the extruded *side walls* are coloured with.

A wall is the surface between a pixel and the lower ground beside it, and the
naive answer is to smear the surface pixel's one colour down the whole depth.
That turns a carefully shaded sprite into a monolithic cliff wherever an edge
is exposed. Surface blend instead cuts each wall into up to **four bands, four
pixels deep each**, and draws the colours the pixel's own colour region
*touches* — adjacency, not the sprite's whole palette. A dark green may take
the light green five pixels away that borders it, but not a brown at the far
end of the sprite that borders nothing of it. The frontmost band keeps the
surface pixel's colour, so the lip still matches the front face exactly.

The colours are sampled from ordinary pixels of the level that happen to carry
them, which is why clear-physics mode greys the bands along with everything
else: they are the level's own pixels, not a separate palette.

**Pieces opt out, not in** — on for everything, tagged off where it does not
suit. Nearly-identical shades count as one colour (an anti-aliasing tolerance),
so a style that draws a soft fringe does not fill its palettes with variations
of the same green.

This tag has **no master switch**. It is per-piece or nothing.

### Surface: `colour blend`

**What it decides:** whether neighbouring pixels' colours run into each other
instead of meeting at a hard edge.

Every face corner takes the mean of the pixels meeting there, so two
neighbouring quads share an edge colour and the grid the sprite was drawn on
stops reading as a grid; and a wall runs from the colour its face ends on at
the top down to the colour of the pixel it drops onto at the base. X, Y and Z.
A silhouette keeps one colour down the depth — there is no next pixel for it to
run into.

**Pieces opt out, not in.** On for everything, tagged off for the pieces whose
pixel art you want kept crisp.

Held on top by the **"colour blend"** switch in the 3D effects drawer, which is
a *strength* rather than an on/off: press it to cycle.

- **soft** (the default) gives only the outer half of each pixel to the blend
  and leaves a plateau of its own colour in the middle. The next pixel ramps to
  the same shared colours from its side, so a boundary is crossed in one
  continuous slope with no step in it while the pixels stay legible as pixels.
- **smooth** gives all of it: a quad is nothing but its four corner means, so
  the surface is continuous everywhere, which over a whole sprite reads as
  blur.
- **off** leaves the pixels as they were drawn, whatever any tag says.

The same switch and the same two strengths also cover everything else on the
board that is **scenery**, none of which has a tag of its own: the water, lava
and acid, the entrances and exits — the tunnel and the hatch's swinging doors
alike — and every other object standing on the field. All of it is in whenever
the switch is on. The **lemmings are the exception** and keep their pixels
crisp, being the thing the eye has to pick out of all that.

Colour blend costs geometry: a blended pixel cannot merge into a greedy
rectangle, since a rectangle has no corners to carry the colours of the pixels
inside it. That is what the master switch is there to answer.

### Controls: `save` · `export JSON` · `reset all`

The fourth row is not tags but what is done with them. All three act on
**every file this level uses**, whether or not a piece is selected.

`save` writes the changed files to disk through the launcher — server mode
only, see [Saving in server mode](#saving-in-server-mode). `export JSON`
downloads them instead, for placing by hand — see [Exporting in static
mode](#exporting-in-static-mode).

`reset all` clears **every tag in every file this level uses** — classes,
shades, 3D objects, both blends — in memory. It does not touch the disk until
you save, and there is no undo, so it is worth an export first if there was
anything in those files you did not mean to lose.

## Where the tags are kept

A tag belongs to a **sprite**, not to a placement and not to a level. So it is
kept with the gallery the sprite comes from, and covers every level of every
pack that draws it:

| Gallery | File | How pieces are keyed |
| --- | --- | --- |
| A DOS tileset | `3d/profiles/<pack>-g<set>.json` — e.g. `lemmings-g2.json` | The piece's numeric index in the ground set: `"3"` |
| A NeoLemmix style folder | `3d/profiles/nx-<style>.json` — e.g. `nx-orig_dirt.json` | `"<style>:<piece>"`: `"orig_dirt:clump_04"` |

The folder is **`3d/profiles/`, relative to the pages** — that is, next to
`index.html`, in the repository as it is checked out or deployed. It is not
browser storage and it is not part of the assets you install on the setup page:
these files ship with the engine, and they are the same files however the level
data was installed.

A level loads the file of *every* gallery its pieces come from and works on the
merged view of them; a change goes back into the file of the piece's own
gallery. A NeoLemmix level mixing three styles reads three files, and the panel
lists all three. A missing file is not an error — it reads as "nothing tagged",
which is why an engine with an empty `3d/profiles/` works perfectly well.

Because these are files of the site rather than of the browser, they are also
the natural thing to share: a profile file is a small, human-readable,
diff-friendly JSON that improves every level using that tileset for everyone
who has it.

## Saving in server mode

**The `save` button only works in server mode.** It POSTs each changed file to
the launcher, which writes it into `3d/profiles/` on disk, and the file loads
by itself with the next level. The panel then says `saved <files> — loads
automatically now`.

The requirement is not that the launcher is *running* but that it is **serving
the page you are tagging in**: open the launcher's own address
(`http://localhost:<port>/`, or the machine's address on the local network) and
tag there. A page served by anything else has nowhere to POST to.

The save is verified rather than assumed. A plain static server answers a POST
much as it answers a GET, which once read as a false success; so the launcher
must return a write receipt, and the file is then **read back and compared**
against what was sent. Anything short of a match is reported as a failure. When
it fails you get `NOT saved: <files> — restart the launcher server (or use
export JSON)`, and nothing has been lost: the changes are still in the page,
still marked unsaved, and `export JSON` is still there.

The launcher will only write to that one location — a path ending in
`3d/profiles/` with a name matching `<pack>-g<set>.json` or `nx-<style>.json`.
Nothing else on disk is writable, whatever is POSTed.

See `setup.md` for what the launcher is and how to run it.

## Exporting in static mode

In static asset mode there is no server to write to, so tags travel as files
you place yourself. `export JSON` downloads **the changed files**, or, when
nothing is pending, **every file the level uses** — so it doubles as a way to
pull down the current profiles for a level whether or not you have edited them.
The same JSON is also printed to the browser console, and the file list's
`⤓ json` link downloads any single file on its own.

Then put the downloaded files into **`3d/profiles/`** in your copy of the
engine, replacing what is there, and deploy that. On a static host — GitHub
Pages, a plain web server, a folder on disk — the file is picked up the next
time a level loads.

Note the asymmetry, since it is the thing most likely to surprise: static asset
mode keeps `neolemmix/` and `levels/` in the browser's own storage, but
`3d/profiles/` is never in browser storage. It always comes from the web server
the page was loaded from. That is exactly why static mode cannot save tags —
there is nothing on the browser's side to save them to.

## Updating the tagging, either way

**Server mode**

1. Open the launcher's address and load a level using the pieces you want.
2. Enter edit mode, click a piece, set its tags.
3. Press `save`. The file is written to `3d/profiles/` and the panel confirms
   which files were written.
4. Load any level again — the new tags are read on the next level load.

The changes are in the page immediately, so you do not have to save to see
them; saving is what makes them outlive the tab.

**Static mode**

1. Load a level using the pieces you want and enter edit mode.
2. Set the tags, and check them there and then — the diorama re-meshes live,
   with no save involved.
3. Press `export JSON` and keep the downloaded files.
4. Copy them into `3d/profiles/` in your copy of the engine, overwriting the
   old ones.
5. Redeploy, or reload if you are serving the folder locally.

**Either way**, a file with unsaved changes is marked in the panel, and leaving
the page for the galleries page asks first, since unsaved tags live only in the
page that made them. Reloading loses them without asking — that is the
browser's dialog, not the app's.

## The sprite galleries

`galleries.html` — the *see in gallery* link under the panel's controls, which
opens it scrolled to the selected sprite, or at the root of the galleries with
nothing selected — tags the same files sprite by sprite instead of level by
level. Down the left is a tree of every gallery: the classic games with a
directory per pack holding its tilesets, and the NeoLemmix styles with a
directory per author. On the right, a miniature of every terrain sprite in the
open gallery with the same tag buttons on each — the four classes and `auto`
on one row, `3D shade`, `invert`, `3D object`, `surface blend` and `colour
blend` on the next — and the current state lit. The gallery's head names its
profile file and counts what it holds: class tags, shade settings, pieces out
of either blend, pieces tagged as 3D objects.

It is the better tool for working through a whole tileset methodically; the
piece editor is the better tool for fixing the piece that looks wrong in the
level in front of you. They read and write the same files, so a save from
either shows up in the other on the next load. Saving, exporting and resetting
there are per gallery.

## The file format

A profile file is a small JSON object with five sections. Every one of them is
optional, and every entry inside them is optional: what is not named takes the
default.

```json
{
  "tileset": "orig_dirt",
  "terrain": {
    "default": "terrain",
    "byId": {
      "orig_dirt:bridge_01": "relief",
      "orig_dirt:sky_02": "backdrop"
    }
  },
  "emboss": {
    "byId": {
      "orig_dirt:water_01": false,
      "orig_dirt:cave_03": "invert"
    }
  },
  "blend": {
    "byId": { "orig_dirt:steel_01": false }
  },
  "colorBlend": {
    "byId": { "orig_dirt:sign_01": false }
  },
  "sculpt": {
    "byId": { "ray_food:mustard": true }
  }
}
```

| Section | Entry means | Absent means |
| --- | --- | --- |
| `terrain.byId` | The piece's depth class: `"backdrop"`, `"terrain"`, `"relief"` or `"overlay"` | `terrain.default`, itself `"terrain"` when absent |
| `emboss.byId` | `false` = no 3D shade; `"invert"` = darker pixels raised | On, lighter pixels raised |
| `blend.byId` | `false` = no surface blend | On |
| `colorBlend.byId` | `false` = no colour blend | On |
| `sculpt.byId` | `true` = read as a 3D object | Off |

Note the direction of the shade and blend sections: they are lists of
**exceptions**. Those three effects are on by default, so a file records only
the pieces tagged *out* of them, and turning one back on removes the entry
rather than writing `true`. An older file's redundant `true` still reads as on
and is cleared the first time that piece is touched. `sculpt` runs the other
way: it is off by default, so the file lists the pieces tagged *in*, and
turning one off removes the entry. Depth classes are different again, since
`terrain` is a real default rather than an effect: a `terrain.byId` entry names
a class, and `auto` removes it.

Anything else in the file is left alone when the page rewrites it, so extra
fields — `tileset` above, or notes of your own — survive a save.
