"use strict";
/**
 * The monitor during a VR session: an observer's view of the game.
 *
 * Inside a session three draws only into the headset's layer; the page's
 * own canvas shows nothing of ours, and a runtime's mirror of one eye swings
 * with every turn of the head. Someone watching the monitor wants the board
 * as the player has arranged it - panned, tilted, dollied, scaled - without
 * riding the player's head. In VR the world never moves and the board does
 * (vr.js), so a camera parked where the head was when the board was placed
 * or last recentred (app.js placeDioramaForXR) sees every one of those
 * changes and none of the head's own motion. That is this camera.
 *
 * Its picture is a second render into the canvas each Nth headset frame,
 * the XR manager switched off for the call so three draws to the drawing
 * buffer instead of the layer (r147 leaves the canvas at window size in a
 * session). The beam, the hand marks, the impact dot and the board cursor
 * are scene objects, so the observer sees where the player is pointing as
 * a matter of course. The skill bar is the exception: in the room it stands
 * wherever the player left it, so for the pass it rides this camera the way
 * it rides the desktop's, which puts it along the bottom of the monitor -
 * the hovered tile popped out and the selected skill framed, since those are
 * the same meshes and the same bitmap the headset shows. A beam landing on
 * the bar is marked by a dot pinned to what it hit, since the scene's own
 * dot sits at the bar's place in the room.
 */

// A little wider than the desktop's 50°: the bar hangs VR_GUI_Y below and
// VR_GUI_Z ahead of the head, and at 50° a raised tile would touch the edge.
const OBSERVER_FOV = 52;
// The pass costs a full frame at the monitor's size; every second headset
// frame is smooth enough to watch and leaves the headset its budget.
const OBSERVER_EVERY = 2;

class ObserverView {
  constructor(renderer, scene, guiRoot) {
    this.renderer = renderer;
    this.scene = scene;
    this.guiRoot = guiRoot;
    // metres, the session's clip planes (app.js sets the same on the head)
    this.camera = new THREE.PerspectiveCamera(
      OBSERVER_FOV, window.innerWidth / window.innerHeight, 0.05, 300);
    scene.add(this.camera); // children of a camera render only once it is in the graph
    // the impact dot's recipe (vr.js), pinned to the bar element the beam hit
    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.009, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0xb9ffcb, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      }));
    this.marker.renderOrder = VR_MARK_ORDER;
    this.marker.visible = false;
    this._frame = 0;
    this._anchored = false;
  }

  /** Park the camera at the head and turn it to the board's focus. Called
   *  with each placement of the board: a session's first frame, a recentre,
   *  a level change - and at no other time, so the head is free to move. */
  anchor(headPos, lookAt) {
    this.camera.position.copy(headPos);
    this.camera.lookAt(lookAt);
    this.camera.updateMatrixWorld(true);
    this._anchored = true;
  }

  /** The monitor's aspect follows the window, not the headset. */
  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** True when `object` hangs off the skill bar's root. */
  _onBar(object) {
    for (let o = object; o; o = o.parent) if (o === this.guiRoot) return true;
    return false;
  }

  /**
   * Draw the observer's picture into the canvas, after the headset's frame.
   * `pointer` is the pointing hand's landing this frame ({controller, hit})
   * or null. Everything moved for the pass is put back before it returns.
   */
  render(pointer) {
    if (!this._anchored) return;
    if (++this._frame % OBSERVER_EVERY) return;
    const renderer = this.renderer;
    const gui = this.guiRoot;
    // the beam on the bar: pin the marker to what it hit, in that thing's
    // own space, while the world matrices are still the headset frame's
    let dot = null, dotWas = false;
    const hit = pointer && pointer.hit;
    if (hit && hit.object && this._onBar(hit.object)) {
      hit.object.add(this.marker);
      this.marker.position.copy(hit.object.worldToLocal(hit.point.clone()));
      // a sphere of a fixed radius in metres; the bar's parts are scaled
      // planes, so counter that scale or the dot comes out as a lens
      const s = hit.object.getWorldScale(new THREE.Vector3());
      this.marker.scale.set(1 / (s.x || 1), 1 / (s.y || 1), 1 / (s.z || 1));
      this.marker.visible = true;
      dot = pointer.controller.userData.dot; // sits at the bar's place in the room
      if (dot) { dotWas = dot.visible; dot.visible = false; }
    }
    // the bar onto this camera, as it rides the desktop's: guiRoot is laid
    // out as if it were a head, so the identity puts it along the bottom
    const parent = gui.parent;
    const pos = gui.position.clone(), quat = gui.quaternion.clone(), scale = gui.scale.clone();
    this.camera.add(gui);
    gui.position.set(0, 0, 0);
    gui.quaternion.identity();
    gui.scale.setScalar(1);
    try {
      renderer.xr.enabled = false;
      renderer.setRenderTarget(null);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.xr.enabled = true;
      if (parent) parent.add(gui); else this.camera.remove(gui);
      gui.position.copy(pos);
      gui.quaternion.copy(quat);
      gui.scale.copy(scale);
      // and its world matrices with it: the render above computed them at
      // this camera, and the next frame's controller rays are cast against
      // the bar before the headset's render recomputes them - left as they
      // are, every second frame would find the bar somewhere else, and the
      // hover and the dot would flicker between the two places
      gui.updateMatrixWorld(true);
      if (this.marker.parent) this.marker.parent.remove(this.marker);
      this.marker.visible = false;
      if (dot) dot.visible = dotWas;
    }
  }
}
