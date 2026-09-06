# Environment pictures

The pictures the 3D page hangs around the board - a floor, a wall and a
ceiling per depth layer - made offline for a style, one folder per style
name (`<style>/floor.png`, `wall.png`, `ceiling.png` for the first layer,
`floor-1.png`, `wall-1.png`, `ceiling-1.png` for the next, and so on; a
wall that is not the last keeps its cut-out skyline in its alpha) and
listed in `index.json`,
which the page reads once so it never asks for a picture that is not there.
With a folder here the page shows these instead of the collage it draws
itself from the level's pieces (`3d/js/envgen.js`, the "environment" effect
in `3d/README.md`); without one, the collage.

They are made with `node tools/env-gen.js <style>`: the page's own collage
is polished through a local Stable Diffusion server speaking the
Automatic1111 API (Draw Things with its API server on, ComfyUI behind a
bridge, A1111 itself) as an img2img pass at a low denoise, then brought
back to the plane's pixel size and quantised to the style's palette. Each
folder carries an `env.json` with the settings it was made with; a
`contact.html` next to the folders shows the collage, the model's answer
and the finished picture side by side. `--dry` writes the collages alone,
into `tmp/env-dry/`, to look at without a model.

A picture too low and wide for the model (the far walls) is the
collage itself. These pictures derive from the styles' own art - the terrain pieces of the
NeoLemmix styles package, drawn by their authors - through the collage they
are seeded with. They are made here, kept here and are not part of that
package.
