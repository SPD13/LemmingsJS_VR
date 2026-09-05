"use strict";
/**
 * The desktop mouse during a VR session with controllers: a mark in the
 * headset at whatever the monitor's cursor is over.
 *
 * With controllers the hands own the pointer and the mouse acts on nothing
 * (app.js mouseAllowed), but the person at the monitor watches the
 * observer's picture (observer.js) and points at things on it - "that
 * lemming", "the basher". The player cannot see the monitor, so the point
 * is put into the room: a dot of its own colour, pink so it is neither the
 * beam's green nor the mouse-fallback's yellow, sitting on the thing under
 * the cursor. There is no depth to a mouse on a monitor, so the dot is not
 * a beam but a landing - on the terrain's surface, the ray marched through
 * the extrusion the way piece tagging does (editor.js surfacePick), so it
 * sits on the face of a wall and not on the plane behind it; on a lemming,
 * where it grows a little; on a skill card of the toolbar, or a window's
 * button. A click sends rings out of the dot, concentric and fading, for
 * as long as the button is held and one beat after, to pull the player's
 * eye to where the click was.
 *
 * The toolbar is the one thing the monitor shows somewhere other than
 * where it stands: for the observer's pass it rides that camera (its
 * frame is the identity there), so a mouse on it is a ray through the bar
 * at the camera, which is mapped into the room by the bar's own world
 * matrix. The dot then hangs off the element it landed on, in that
 * element's own space, so it shows on the bar in both pictures.
 *
 * The landing is worked out every frame from the last mouse position, not
 * just on mouse events: the board and the bar move in the room while the
 * mouse sits still, and the mark has to stay on what the cursor is over.
 * A mouse that has sat still for a couple of seconds is not pointing at
 * anything, though - its owner has let go of it - so the mark fades out
 * then, and comes back at the next move or click.
 */

const SPECTATOR_COLOR = 0xff6ad5;
const SPECTATOR_DOT = 0.008;      // metres, the dot's radius
const SPECTATOR_DOT_LEMMING = 1.6; // how much it grows over a lemming
const SPECTATOR_RING_MIN = 0.012; // metres, a ring is born this wide...
const SPECTATOR_RING_MAX = 0.055; // ...and fades out at this
const SPECTATOR_RINGS = 3;        // in flight at once, evenly staggered
const SPECTATOR_PERIOD = 900;     // ms, one ring's life
const SPECTATOR_STEP = 0.5;       // level pixels, the march through the extrusion
const SPECTATOR_IDLE = 2000;      // ms without a move or a click before the mark goes
const SPECTATOR_FADE = 400;       // ms it takes to go

class SpectatorPointer {
  /**
   * hooks:
   *  - sceneHit(raycaster) -> nearest hit on the interactive surfaces
   *                           (app.js raycastHit): windows, bar, board
   *  - boardHit(raycaster) -> the hit on the level's pick plane alone
   *  - board()             -> {worldGroup, terrain} of the level, or null
   *  - lemmingAt(x, y)     -> the world position of the lemming at these
   *                           sim coordinates, or null
   */
  constructor(scene, camera, guiRoot, hooks) {
    this.scene = scene;
    this.camera = camera;   // the observer's, the picture the mouse is on
    this.guiRoot = guiRoot;
    this.hooks = hooks;
    this.raycaster = new THREE.Raycaster();
    this._ndc = null;       // the mouse, in the monitor's clip space
    this._held = false;
    this._pressAt = -Infinity;
    this._releaseAt = -Infinity;
    this._activeAt = -Infinity; // the last move or click

    const mat = (opacity, side) => new THREE.MeshBasicMaterial({
      color: SPECTATOR_COLOR, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
      depthTest: false, // the mark stays visible on top of everything
      side: side || THREE.FrontSide,
    });
    // dot and rings in one group: placed together, and where the landing is
    // on the bar the group hangs off the bar element, counter-scaled
    this.group = new THREE.Group();
    this.group.visible = false;
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(SPECTATOR_DOT, 12, 8), mat(0.95));
    this.dot.renderOrder = VR_MARK_ORDER;
    this.group.add(this.dot);
    this.rings = [];
    const ringGeom = new THREE.RingGeometry(0.8, 1, 40);
    for (let i = 0; i < SPECTATOR_RINGS; i++) {
      const ring = new THREE.Mesh(ringGeom, mat(0.8, THREE.DoubleSide));
      ring.renderOrder = VR_MARK_ORDER;
      ring.visible = false;
      this.group.add(ring);
      this.rings.push(ring);
    }
    scene.add(this.group);
  }

  /** The mouse moved over the monitor: `ndc` is its place in clip space. */
  aim(ndc) {
    if (!this._ndc || !this._ndc.equals(ndc)) this._activeAt = performance.now();
    this._ndc = ndc;
  }

  /** The mouse left the monitor's picture. */
  leave() { this._ndc = null; this.press(false); }

  /** A mouse button went down (true) or the last one came up (false). */
  press(down) {
    if (down === this._held) return;
    this._held = down;
    const now = performance.now();
    this._activeAt = now;
    if (down) this._pressAt = now; else this._releaseAt = now;
  }

  /** True when `object` hangs off the toolbar's root. */
  _onBar(object) {
    for (let o = object; o; o = o.parent) if (o === this.guiRoot) return true;
    return false;
  }

  /** The ray through the mouse as the monitor shows the room. */
  _sceneRay() {
    this.raycaster.setFromCamera(this._ndc, this.camera);
    return this.raycaster;
  }

  /**
   * The same ray aimed at the bar as it stands in the room. For the
   * monitor's picture the bar sits at the observer camera with the identity
   * for its frame, so the bar's room matrix over the camera's inverse takes
   * a ray from one picture to the other.
   */
  _barRay() {
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const toRoom = new THREE.Matrix4().copy(this.camera.matrixWorld).invert()
      .premultiply(this.guiRoot.matrixWorld);
    this.raycaster.ray.applyMatrix4(toRoom);
    return this.raycaster;
  }

  /**
   * Where the ray lands on the terrain, in the level's own space: every
   * solid pixel a column from its class's back to its front, relief
   * included, and the first column the ray enters is the surface under the
   * cursor. Null when it crosses no solid pixel.
   */
  _surfacePoint(localRay, terrain) {
    const o = localRay.origin, d = localRay.direction;
    let t0 = 0, t1 = Infinity;
    const clip = (p, dd, lo, hi) => {
      if (Math.abs(dd) < 1e-9) return p >= lo && p <= hi;
      let a = (lo - p) / dd, b = (hi - p) / dd;
      if (a > b) { const swap = a; a = b; b = swap; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      return t1 >= t0;
    };
    const zTop = DEPTH_BANDS.reduce((m, b) => Math.max(m, b ? b.front : 0), 0) + RELIEF_TOP;
    if (!clip(o.x, d.x, 0, terrain.w) || !clip(o.y, d.y, 0, terrain.h) ||
        !clip(o.z, d.z, 0, zTop)) return null;
    for (let s = Math.max(t0, 0); s <= t1; s += SPECTATOR_STEP) {
      const x = Math.floor(o.x + d.x * s), y = Math.floor(o.y + d.y * s);
      if (x < 0 || y < 0 || x >= terrain.w || y >= terrain.h) continue;
      const i = y * terrain.w + x;
      const cls = terrain.depth[i];
      if (cls === DepthClass.EMPTY) continue;
      const band = DEPTH_BANDS[cls];
      const z = o.z + d.z * s;
      if (z <= band.front + (terrain.relief ? terrain.relief[i] : 0) && z >= band.back) {
        return new THREE.Vector3(o.x + d.x * s, o.y + d.y * s, z);
      }
    }
    return null;
  }

  /**
   * What the cursor is over this frame: {point, normal, parent, lemming} in
   * the room, or null for the sky. `parent` is the bar element the dot
   * should hang off, else null for the scene.
   */
  _landing() {
    const hooks = this.hooks;
    // the bar first: on the monitor it is drawn over everything
    if (this.guiRoot.parent) {
      const hit = hooks.sceneHit(this._barRay());
      if (hit && hit.object && this._onBar(hit.object)) {
        return { point: hit.point, parent: hit.object, normal: null, lemming: false };
      }
    }
    let hit = hooks.sceneHit(this._sceneRay());
    // the bar where it stands in the room is not in the monitor's picture:
    // the cursor is over whatever lies behind it there
    if (hit && hit.object && this._onBar(hit.object)) hit = hooks.boardHit(this._sceneRay());
    // a question up owns the ray (sceneHit) and the cursor beside its
    // answers lands on nothing there; the board behind it still counts
    if (!hit) hit = hooks.boardHit(this._sceneRay());
    if (!hit) return null;
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : null;
    if (hit.object.name !== "pick-plane") {
      return { point: hit.point, parent: null, normal, lemming: false };
    }
    // on the board: the lemming under the cursor, else the terrain's face
    const board = hooks.board();
    if (!board) return { point: hit.point, parent: null, normal, lemming: false };
    const group = board.worldGroup;
    const local = group.worldToLocal(hit.point.clone());
    const lem = hooks.lemmingAt(Math.round(local.x), Math.round(local.y));
    if (lem) return { point: lem, parent: null, normal, lemming: true };
    if (board.terrain) {
      const ray = this._sceneRay().ray.clone().applyMatrix4(
        new THREE.Matrix4().copy(group.matrixWorld).invert());
      ray.direction.normalize();
      const surface = this._surfacePoint(ray, board.terrain);
      if (surface) return { point: group.localToWorld(surface), parent: null, normal, lemming: false };
      // the sky over the level: the slab's back, where the backdrop is
      const back = new THREE.Vector3();
      if (ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), back)) {
        return { point: group.localToWorld(back), parent: null, normal, lemming: false };
      }
    }
    return { point: hit.point, parent: null, normal, lemming: false };
  }

  /** Per frame. `active`: a session with controllers, the mouse a spectator. */
  update(now, active) {
    // a still mouse: the mark fades over SPECTATOR_FADE once SPECTATOR_IDLE
    // has passed, unless a button is held (the rings are still running)
    const idle = this._held ? 0 : now - this._activeAt - SPECTATOR_IDLE;
    const fade = idle > 0 ? Math.max(0, 1 - idle / SPECTATOR_FADE) : 1;
    const on = active && !!this._ndc && fade > 0;
    if (!on) {
      if (this.group.visible) {
        this.group.visible = false;
        this.scene.add(this.group);
      }
      this._held = false;
      return;
    }
    const at = this._landing();
    if (!at) {
      this.group.visible = false;
      return;
    }
    const group = this.group;
    group.visible = true;
    if (at.parent) {
      // on the bar: in the element's own space, so it shows in both pictures;
      // the element is a scaled plane, so counter the scale or the dot is a lens
      if (group.parent !== at.parent) at.parent.add(group);
      group.position.copy(at.parent.worldToLocal(at.point.clone()));
      const s = at.parent.getWorldScale(new THREE.Vector3());
      group.scale.set(1 / (s.x || 1), 1 / (s.y || 1), 1 / (s.z || 1));
      group.quaternion.identity(); // the rings in the element's plane
    } else {
      if (group.parent !== this.scene) this.scene.add(group);
      group.position.copy(at.point);
      group.scale.setScalar(1);
      // the rings lie on the surface the dot sits on
      const normal = at.normal || new THREE.Vector3(0, 0, 1);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    }
    const dotScale = at.lemming ? SPECTATOR_DOT_LEMMING : 1;
    this.dot.scale.setScalar(dotScale);
    this.dot.material.opacity = 0.95 * fade;
    this._pulse(now, fade);
  }

  /**
   * The rings of a click: born at the dot, each a third of a period after
   * the last, growing and fading over a period; they keep coming while the
   * button is held, and the ones in flight at the release finish their run.
   */
  _pulse(now, fade) {
    const since = now - this._pressAt;
    const running = this._held || (now - this._releaseAt) < SPECTATOR_PERIOD;
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      const born = i * SPECTATOR_PERIOD / this.rings.length;
      if (!running || since < born) { ring.visible = false; continue; }
      const age = (since - born) % SPECTATOR_PERIOD;
      // released: a ring past its last full run is done
      if (!this._held && since - age > this._releaseAt - this._pressAt) {
        ring.visible = false;
        continue;
      }
      const k = age / SPECTATOR_PERIOD;
      const r = SPECTATOR_RING_MIN + (SPECTATOR_RING_MAX - SPECTATOR_RING_MIN) * k;
      ring.visible = true;
      ring.scale.set(r, r, 1);
      ring.material.opacity = 0.85 * (1 - k) * (1 - k) * fade;
    }
  }
}
