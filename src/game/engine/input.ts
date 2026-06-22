/* Input: movement (WASD / arrows / analog joystick) + edge-triggered attack.
   Movement vector magnitude scales walk speed (light joystick push = slow). */

const KEYMAP: Record<string, "up" | "down" | "left" | "right"> = {
  w: "up", arrowup: "up", s: "down", arrowdown: "down",
  a: "left", arrowleft: "left", d: "right", arrowright: "right"
};

export const input = {
  x: 0, y: 0,                 // current move vector (-1..1 each axis)
  attackQueued: false,        // edge-triggered; consume() clears it
  enabled: false,             // scenes flip this so menus don't move the player
  _keys: new Set<string>(),
  _joy: { active: false, x: 0, y: 0, id: -1 }
};

let attackPressed = false, skillPressed = false, dashPressed = false;
export function consumeAttack(): boolean {
  if (attackPressed) { attackPressed = false; return true; }
  return false;
}
export function consumeSkill(): boolean {
  if (skillPressed) { skillPressed = false; return true; }
  return false;
}
export function consumeDash(): boolean {
  if (dashPressed) { dashPressed = false; return true; }
  return false;
}
export function setEnabled(on: boolean) {
  input.enabled = on;
  if (!on) { input._keys.clear(); input.x = input.y = 0; resetJoy(); }
}

function recompute() {
  if (input._joy.active && (input._joy.x || input._joy.y)) {
    input.x = input._joy.x; input.y = input._joy.y; return;
  }
  let x = 0, y = 0;
  if (input._keys.has("left")) x -= 1;
  if (input._keys.has("right")) x += 1;
  if (input._keys.has("up")) y -= 1;
  if (input._keys.has("down")) y += 1;
  input.x = x; input.y = y;
}

const knob = () => document.getElementById("joystickKnob");
const JOY_MAX = 42, JOY_DEAD = 0.22;
function resetJoy() {
  input._joy.active = false; input._joy.x = input._joy.y = 0; input._joy.id = -1;
  const k = knob(); if (k) k.style.transform = "translate(0px,0px)";
}

export function initInput() {
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (KEYMAP[k] && input.enabled) { input._keys.add(KEYMAP[k]); recompute(); e.preventDefault(); }
    if ((k === " " || k === "j" || k === "enter") && input.enabled) { attackPressed = true; e.preventDefault(); }
    if ((k === "q" || k === "k") && input.enabled) { skillPressed = true; e.preventDefault(); }
    if ((k === "shift" || k === "l") && input.enabled) { dashPressed = true; e.preventDefault(); }
  });
  window.addEventListener("keyup", (e) => {
    const k = KEYMAP[e.key.toLowerCase()];
    if (k) { input._keys.delete(k); recompute(); }
  });

  const joy = document.getElementById("joystick");
  if (joy) {
    const move = (e: PointerEvent) => {
      if (input._joy.id !== e.pointerId) return;
      const r = joy.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const ang = Math.atan2(e.clientY - cy, e.clientX - cx);
      const reach = Math.min(Math.hypot(e.clientX - cx, e.clientY - cy), JOY_MAX);
      const kx = Math.cos(ang) * reach, ky = Math.sin(ang) * reach;
      const k = knob(); if (k) k.style.transform = `translate(${kx}px,${ky}px)`;
      const nx = kx / JOY_MAX, ny = ky / JOY_MAX;
      if (Math.hypot(nx, ny) < JOY_DEAD) { input._joy.x = input._joy.y = 0; }
      else { input._joy.x = nx; input._joy.y = ny; }
      recompute(); e.preventDefault();
    };
    joy.addEventListener("pointerdown", (e) => {
      if (!input.enabled) return;
      input._joy.active = true; input._joy.id = e.pointerId;
      input._keys.clear(); joy.setPointerCapture(e.pointerId); move(e); e.preventDefault();
    });
    joy.addEventListener("pointermove", move);
    joy.addEventListener("pointerup", () => { resetJoy(); recompute(); });
    joy.addEventListener("pointercancel", () => { resetJoy(); recompute(); });
  }

  const bind = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("pointerdown", (e) => { e.preventDefault(); if (input.enabled) fn(); });
  };
  bind("attackBtn", () => { attackPressed = true; });
  bind("skillBtn", () => { skillPressed = true; });
  bind("dashBtn", () => { dashPressed = true; });
}

export const isTouch =
  matchMedia("(hover: none) and (pointer: coarse)").matches || "ontouchstart" in window;
