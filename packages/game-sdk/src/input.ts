import type { ControlButtonSpec, PlayerInputState } from "@aa-game/protocol";
import { normalize } from "./headless/math.js";

export interface UnifiedInputOptions {
  controlsRoot: HTMLElement;
  showVirtualControls: boolean;
  joystick: boolean;
  buttons: ControlButtonSpec[];
}

/**
 * Unified PC (WASD / Arrow / Space / Shift) + Mobile (HTML Virtual Joystick & Buttons)
 * input layer. Game logic only ever reads normalized semantic actions.
 */
export class UnifiedInputController {
  private readonly pressedKeys = new Set<string>();
  private readonly controlsRoot: HTMLElement;
  private virtualMoveX = 0;
  private virtualMoveY = 0;
  private virtualPrimary = false;
  private virtualSecondary = false;
  private seq = 0;
  private readonly cleanups: Array<() => void> = [];

  constructor(options: UnifiedInputOptions) {
    this.controlsRoot = options.controlsRoot;

    const onKeyDown = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
        e.preventDefault();
      }
      this.pressedKeys.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.pressedKeys.delete(e.code);
    };
    const onBlur = () => {
      this.pressedKeys.clear();
      this.virtualMoveX = 0;
      this.virtualMoveY = 0;
      this.virtualPrimary = false;
      this.virtualSecondary = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    this.cleanups.push(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    });

    this.renderVirtualControls(options);
  }

  private renderVirtualControls(options: UnifiedInputOptions): void {
    this.controlsRoot.innerHTML = "";
    if (!options.showVirtualControls) return;

    const wrapper = document.createElement("div");
    wrapper.style.cssText =
      "position:absolute;inset:0;box-sizing:border-box;pointer-events:none;display:flex;justify-content:space-between;align-items:flex-end;gap:clamp(6px, 2vw, 14px);padding:0 max(clamp(8px, 3vw, 18px), env(safe-area-inset-right)) max(clamp(10px, 3vh, 20px), env(safe-area-inset-bottom)) max(clamp(8px, 3vw, 18px), env(safe-area-inset-left));z-index:20;";

    if (options.joystick) {
      const base = document.createElement("div");
      // Avoid expensive CSS backdrop-filter blur over high-frequency WebGL canvases.
      // Scale gracefully via clamp() so narrow split-view iframes never clip controls.
      base.style.cssText =
        "width:clamp(72px, 26vw, 108px);height:clamp(72px, 26vw, 108px);flex-shrink:0;border-radius:999px;background:radial-gradient(circle, rgba(30,41,59,0.52), rgba(15,23,42,0.72));border:2px solid rgba(148,163,184,0.45);pointer-events:auto;touch-action:none;position:relative;display:flex;align-items:center;justify-content:center;";
      const knob = document.createElement("div");
      knob.style.cssText =
        "width:clamp(30px, 11vw, 44px);height:clamp(30px, 11vw, 44px);border-radius:999px;background:rgba(56,189,248,0.85);box-shadow:0 0 14px rgba(56,189,248,0.55);transform:translate(0px,0px);pointer-events:none;";
      base.appendChild(knob);

      let activePointerId: number | null = null;

      const updateStick = (clientX: number, clientY: number) => {
        const rect = base.getBoundingClientRect();
        const maxRadius = Math.max(16, rect.width * 0.315);
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = clientX - cx;
        let dy = clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxRadius) {
          dx = (dx / dist) * maxRadius;
          dy = (dy / dist) * maxRadius;
        }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        this.virtualMoveX = Number((dx / maxRadius).toFixed(3));
        this.virtualMoveY = Number((dy / maxRadius).toFixed(3));
      };

      const resetStick = () => {
        activePointerId = null;
        knob.style.transform = "translate(0px, 0px)";
        this.virtualMoveX = 0;
        this.virtualMoveY = 0;
      };

      base.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        activePointerId = e.pointerId;
        base.setPointerCapture(e.pointerId);
        updateStick(e.clientX, e.clientY);
      });
      base.addEventListener("pointermove", (e) => {
        if (e.pointerId !== activePointerId) return;
        e.preventDefault();
        updateStick(e.clientX, e.clientY);
      });
      base.addEventListener("pointerup", (e) => {
        if (e.pointerId === activePointerId) resetStick();
      });
      base.addEventListener("pointercancel", (e) => {
        if (e.pointerId === activePointerId) resetStick();
      });

      wrapper.appendChild(base);
    } else {
      wrapper.appendChild(document.createElement("div"));
    }

    const btnCol = document.createElement("div");
    btnCol.style.cssText = "display:flex;gap:clamp(6px, 2vw, 12px);align-items:center;pointer-events:none;flex-shrink:0;";
    for (const btnSpec of options.buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = btnSpec.label;
      const bg = btnSpec.color ?? (btnSpec.id === "primary" ? "rgba(56,189,248,0.85)" : "rgba(244,114,182,0.85)");
      btn.style.cssText = `width:clamp(46px, 17vw, 68px);height:clamp(46px, 17vw, 68px);padding:0;display:flex;align-items:center;justify-content:center;border-radius:999px;border:2px solid rgba(255,255,255,0.45);background:${bg};color:#0f172a;font-weight:700;font-size:clamp(10px, 3.4vw, 13px);white-space:nowrap;pointer-events:auto;touch-action:none;user-select:none;box-shadow:0 4px 16px rgba(0,0,0,0.35);`;

      const setPressed = (down: boolean) => {
        btn.style.transform = down ? "scale(0.92)" : "scale(1)";
        if (btnSpec.id === "primary") this.virtualPrimary = down;
        else this.virtualSecondary = down;
      };

      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        setPressed(true);
      });
      btn.addEventListener("pointerup", () => setPressed(false));
      btn.addEventListener("pointercancel", () => setPressed(false));
      btnCol.appendChild(btn);
    }

    wrapper.appendChild(btnCol);
    this.controlsRoot.appendChild(wrapper);
  }

  sample(): PlayerInputState {
    let kx = 0;
    let ky = 0;
    if (this.pressedKeys.has("KeyA") || this.pressedKeys.has("ArrowLeft")) kx -= 1;
    if (this.pressedKeys.has("KeyD") || this.pressedKeys.has("ArrowRight")) kx += 1;
    if (this.pressedKeys.has("KeyW") || this.pressedKeys.has("ArrowUp")) ky -= 1;
    if (this.pressedKeys.has("KeyS") || this.pressedKeys.has("ArrowDown")) ky += 1;

    const rawX = Math.abs(this.virtualMoveX) > 0.05 ? this.virtualMoveX : kx;
    const rawY = Math.abs(this.virtualMoveY) > 0.05 ? this.virtualMoveY : ky;
    const dir = normalize(rawX, rawY);

    const primary =
      this.virtualPrimary ||
      this.pressedKeys.has("Space") ||
      this.pressedKeys.has("KeyJ") ||
      this.pressedKeys.has("Enter");
    const secondary =
      this.virtualSecondary ||
      this.pressedKeys.has("ShiftLeft") ||
      this.pressedKeys.has("ShiftRight") ||
      this.pressedKeys.has("KeyK");

    this.seq += 1;
    return {
      moveX: Number(dir.x.toFixed(3)),
      moveY: Number(dir.y.toFixed(3)),
      primary,
      secondary,
      seq: this.seq,
    };
  }

  destroy(): void {
    for (const fn of this.cleanups) fn();
    this.controlsRoot.innerHTML = "";
  }
}
