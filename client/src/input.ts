import { clamp } from "./utils";

/**
 * Единый ввод: клавиатура+мышь на ПК и сенсорное управление на телефоне.
 * Игра каждый кадр читает состояние и «съедает» одноразовые нажатия.
 */
export class Input {
  // Непрерывные
  moveX = 0; // вправо +
  moveZ = 0; // вперёд +
  fire = false;
  sprint = false;
  crouch = false;
  /** Прицеливание с приближением (держать ПКМ / переключатель на телефоне) */
  aim = false;
  // Накопленный поворот за кадр, радианы
  lookDX = 0;
  lookDY = 0;
  // Одноразовые
  jumpPressed = false;
  cameraToggle = false;
  weaponSelect: number | null = null;
  weaponCycle = 0;
  /** Сесть в машину / выйти (E, кнопка «Машина») */
  use = false;
  /** Подзорная труба / бинокль: включить или выключить */
  scopeToggle = false;
  /**
   * Бомба: лечебные "weak" (G) / "strong" (H) / "any" (кнопка «Купол»);
   * боевые "boom" (F) / "frost" (R) / "combat" (кнопка «Бомба»)
   */
  bomb: "weak" | "strong" | "any" | "boom" | "frost" | "combat" | null = null;

  mouseSensitivity = 0.0022;
  touchSensitivity = 0.0055;
  readonly isTouch: boolean;
  pointerLocked = false;
  enabled = false;

  private keys = new Set<string>();
  private touchMove = { x: 0, z: 0 };
  private touchSprint = false;
  private touchCrouch = false;
  private touchFire = false;
  private touchAim = false;
  private mouseAim = false;

  constructor(private canvas: HTMLCanvasElement, isTouch: boolean) {
    this.isTouch = isTouch;
    this.bindKeyboardMouse();
    if (isTouch) this.bindTouch();
  }

  /** Вызывать раз в кадр до чтения состояния */
  poll(): void {
    let mx = 0;
    let mz = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) mz += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) mz -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) mx += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) mx -= 1;
    mx += this.touchMove.x;
    mz += this.touchMove.z;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    this.moveX = mx;
    this.moveZ = mz;
    this.sprint = this.keys.has("ControlLeft") || this.keys.has("ControlRight") || this.touchSprint;
    this.crouch = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.touchCrouch;
    this.fire = this.mouseFire || this.touchFire;
    this.aim = this.mouseAim || this.touchAim;
  }

  /** Сбросить одноразовые нажатия после кадра */
  endFrame(): void {
    this.lookDX = 0;
    this.lookDY = 0;
    this.jumpPressed = false;
    this.cameraToggle = false;
    this.weaponSelect = null;
    this.weaponCycle = 0;
    this.scopeToggle = false;
    this.bomb = null;
    this.use = false;
  }

  reset(): void {
    this.keys.clear();
    this.mouseFire = false;
    this.touchFire = false;
    this.touchMove.x = this.touchMove.z = 0;
    this.touchSprint = false;
    this.touchCrouch = false;
    this.touchAim = false;
    this.mouseAim = false;
    this.syncToggleButtons();
    this.endFrame();
  }

  // ---------------- ПК ----------------

  private mouseFire = false;

  private bindKeyboardMouse(): void {
    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      // Не даём браузеру прокручивать страницу и т.п.
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code) || e.ctrlKey) {
        e.preventDefault();
      }
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "Space") this.jumpPressed = true;
      if (e.code === "KeyV") this.cameraToggle = true;
      if (e.code === "KeyQ") this.weaponCycle = 1;
      if (e.code === "KeyB") this.scopeToggle = true;
      if (e.code === "KeyG") this.bomb = "weak";
      if (e.code === "KeyH") this.bomb = "strong";
      if (e.code === "KeyF") this.bomb = "boom";
      if (e.code === "KeyE") this.use = true;
      if (e.code === "KeyR") this.bomb = "frost";
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m) this.weaponSelect = Number(m[1]) - 1;
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouseFire = false;
      this.mouseAim = false;
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled || this.isTouchEvent) return;
      if (e.button === 0 && this.pointerLocked) this.mouseFire = true;
      if (e.button === 2 && this.pointerLocked) this.mouseAim = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.mouseAim = false;
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.enabled || !this.pointerLocked) return;
      // Защита от редких огромных скачков при захвате курсора
      const dx = clamp(e.movementX, -300, 300);
      const dy = clamp(e.movementY, -300, 300);
      this.lookDX += dx * this.mouseSensitivity;
      this.lookDY += dy * this.mouseSensitivity;
    });
    window.addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled) return;
        this.weaponCycle = e.deltaY > 0 ? 1 : -1;
      },
      { passive: true },
    );
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) {
        this.mouseFire = false;
        this.mouseAim = false;
      }
    });
    document.addEventListener("contextmenu", (e) => {
      if (this.enabled) e.preventDefault();
    });
  }

  requestPointerLock(): void {
    if (this.isTouch) return;
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => undefined);
    } catch {
      /* в некоторых браузерах недоступно */
    }
  }

  // ---------------- Телефон ----------------

  private isTouchEvent = false;
  private joyId: number | null = null;
  private joyCenter = { x: 0, y: 0 };
  private lookIds = new Map<number, { x: number; y: number }>();
  private btnSprint!: HTMLElement;
  private btnCrouch!: HTMLElement;
  private btnAim!: HTMLElement;

  private bindTouch(): void {
    const root = document.getElementById("touch")!;
    const joyZone = document.getElementById("joy-zone")!;
    const joyBase = document.getElementById("joy-base")!;
    const joyKnob = document.getElementById("joy-knob")!;
    const lookZone = document.getElementById("look-zone")!;
    const R = 55;

    const setKnob = (dx: number, dy: number) => {
      joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const baseRect = () => joyBase.getBoundingClientRect();

    joyZone.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        this.isTouchEvent = true;
        if (this.joyId !== null) return;
        const t = e.changedTouches[0];
        this.joyId = t.identifier;
        // Джойстик «прыгает» под палец, если коснулись не по нему
        const r = baseRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (Math.hypot(t.clientX - cx, t.clientY - cy) > R * 1.4) {
          joyBase.style.left = `${t.clientX - r.width / 2}px`;
          joyBase.style.top = `${t.clientY - r.height / 2}px`;
          joyBase.style.bottom = "auto";
          this.joyCenter = { x: t.clientX, y: t.clientY };
        } else {
          this.joyCenter = { x: cx, y: cy };
        }
        joyBase.classList.add("active");
        this.updateJoy(t.clientX, t.clientY, R, setKnob);
      },
      { passive: false },
    );
    const joyMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          e.preventDefault();
          this.updateJoy(t.clientX, t.clientY, R, setKnob);
        }
      }
    };
    const joyEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          this.joyId = null;
          this.touchMove.x = this.touchMove.z = 0;
          setKnob(0, 0);
          joyBase.classList.remove("active");
          joyBase.style.left = "";
          joyBase.style.top = "";
          joyBase.style.bottom = "";
        }
      }
    };
    joyZone.addEventListener("touchmove", joyMove, { passive: false });
    joyZone.addEventListener("touchend", joyEnd);
    joyZone.addEventListener("touchcancel", joyEnd);

    // Правая половина — свайп для обзора
    const lookStart = (e: TouchEvent) => {
      e.preventDefault();
      this.isTouchEvent = true;
      for (const t of Array.from(e.changedTouches)) this.lookIds.set(t.identifier, { x: t.clientX, y: t.clientY });
    };
    const lookMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        const p = this.lookIds.get(t.identifier);
        if (!p) continue;
        e.preventDefault();
        if (this.enabled) {
          this.lookDX += (t.clientX - p.x) * this.touchSensitivity;
          this.lookDY += (t.clientY - p.y) * this.touchSensitivity;
        }
        p.x = t.clientX;
        p.y = t.clientY;
      }
    };
    const lookEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) this.lookIds.delete(t.identifier);
    };
    lookZone.addEventListener("touchstart", lookStart, { passive: false });
    lookZone.addEventListener("touchmove", lookMove, { passive: false });
    lookZone.addEventListener("touchend", lookEnd);
    lookZone.addEventListener("touchcancel", lookEnd);

    // Кнопки
    const btn = (id: string, down: () => void, up?: () => void, alsoLook = false) => {
      const el = document.getElementById(id)!;
      el.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.isTouchEvent = true;
          el.classList.add("pressed");
          down();
          if (alsoLook) for (const t of Array.from(e.changedTouches)) this.lookIds.set(t.identifier, { x: t.clientX, y: t.clientY });
        },
        { passive: false },
      );
      if (alsoLook) el.addEventListener("touchmove", lookMove, { passive: false });
      const end = (e: TouchEvent) => {
        e.preventDefault();
        el.classList.remove("pressed");
        up?.();
        if (alsoLook) lookEnd(e);
      };
      el.addEventListener("touchend", end, { passive: false });
      el.addEventListener("touchcancel", end, { passive: false });
      return el;
    };
    // «Огонь» можно держать и одновременно вести пальцем — прицеливаться
    btn("btn-fire", () => (this.touchFire = true), () => (this.touchFire = false), true);
    btn("btn-jump", () => (this.jumpPressed = true));
    this.btnSprint = btn("btn-sprint", () => {
      this.touchSprint = !this.touchSprint;
      if (this.touchSprint) this.touchCrouch = false;
      this.syncToggleButtons();
    });
    this.btnCrouch = btn("btn-crouch", () => {
      this.touchCrouch = !this.touchCrouch;
      if (this.touchCrouch) this.touchSprint = false;
      this.syncToggleButtons();
    });
    btn("btn-camera", () => (this.cameraToggle = true));
    this.btnAim = btn("btn-aim", () => {
      this.touchAim = !this.touchAim;
      this.syncToggleButtons();
    });
    btn("btn-scope", () => (this.scopeToggle = true));
    btn("btn-dome", () => (this.bomb = "any"));
    btn("btn-bomb", () => (this.bomb = "combat"));
    btn("btn-car", () => (this.use = true));
    btn("btn-weapon", () => (this.weaponCycle = 1));
    root.classList.add("on");
  }

  /** Подсветка кнопок-переключателей «Бег» и «Присесть» */
  syncToggleButtons(): void {
    this.btnSprint?.classList.toggle("toggled", this.touchSprint);
    this.btnCrouch?.classList.toggle("toggled", this.touchCrouch);
    this.btnAim?.classList.toggle("toggled", this.touchAim);
  }

  /** Игра выключает прицел, например при смерти или в подзорной трубе */
  cancelAim(): void {
    this.mouseAim = false;
    if (this.touchAim) {
      this.touchAim = false;
      this.syncToggleButtons();
    }
  }

  /** Игра может выключить бег (например, при стрельбе) */
  cancelTouchSprint(): void {
    if (this.touchSprint) {
      this.touchSprint = false;
      this.syncToggleButtons();
    }
  }

  private updateJoy(x: number, y: number, R: number, setKnob: (dx: number, dy: number) => void): void {
    let dx = x - this.joyCenter.x;
    let dy = y - this.joyCenter.y;
    const len = Math.hypot(dx, dy);
    if (len > R) {
      dx = (dx / len) * R;
      dy = (dy / len) * R;
    }
    setKnob(dx, dy);
    const nx = dx / R;
    const nz = -dy / R;
    // Мёртвая зона
    const m = Math.hypot(nx, nz);
    if (m < 0.15) {
      this.touchMove.x = this.touchMove.z = 0;
    } else {
      this.touchMove.x = nx;
      this.touchMove.z = nz;
    }
  }
}
