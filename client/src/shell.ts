import type { ClanId } from "@clan-battle/shared";
import { CLANS } from "@clan-battle/shared";
import { AV_H, AV_W, AvatarPreview, PALETTE, defaultAvatar, loadAvatar, saveAvatar, type AvatarData } from "./avatar";

/**
 * «Как настоящее приложение» (идея Даниэля): заставка с мечом, главный экран с твоим персонажем,
 * кланом сверху, кнопками Play, «Нарисовать персонажа» и «Подсоединиться».
 */

const $ = (id: string) => document.getElementById(id)!;
const SHELL = ["splash", "home", "editor", "connect"] as const;
type ShellScreen = (typeof SHELL)[number];

export interface ShellHooks {
  getClan(): ClanId;
  setClan(c: ClanId): void;
  /** Play — к выбору уровня и снаряжения (старый стартовый экран) */
  onPlay(): void;
}

export class Shell {
  private homePreview: AvatarPreview | null = null;
  private edPreview: AvatarPreview | null = null;
  private avatar: AvatarData = loadAvatar() ?? defaultAvatar();
  private draft: AvatarData = this.avatar;
  private color = PALETTE[6];
  private bound = false;

  constructor(private hooks: ShellHooks) {
    $("home-play").addEventListener("click", () => {
      this.leave();
      hooks.onPlay();
    });
    $("home-draw").addEventListener("click", () => this.openEditor());
    $("home-connect").addEventListener("click", () => this.show("connect"));
    $("connect-back").addEventListener("click", () => this.home());
    document.querySelectorAll<HTMLButtonElement>("#home .clan-arrow").forEach((b) =>
      b.addEventListener("click", () => {
        const order: ClanId[] = ["dragons", "snakes"];
        const i = order.indexOf(hooks.getClan());
        hooks.setClan(order[(i + order.length + Number(b.dataset.dir)) % order.length]);
        this.renderClan();
      }),
    );
  }

  private show(id: ShellScreen | null): void {
    for (const s of SHELL) $(s).classList.toggle("hidden", s !== id);
  }

  /** Заставка: меч медленно проходит по экрану, потом главный экран */
  splash(): void {
    this.show("splash");
    setTimeout(() => this.home(), 2700);
  }

  home(): void {
    this.edPreview?.dispose();
    this.edPreview = null;
    this.show("home");
    this.renderClan();
    if (!this.homePreview) this.homePreview = new AvatarPreview($("home-avatar") as HTMLCanvasElement);
    this.homePreview.show(this.avatar);
  }

  /** Ушли в игру — 3D-витрины больше не нужны */
  leave(): void {
    this.show(null);
    this.homePreview?.dispose();
    this.homePreview = null;
    this.edPreview?.dispose();
    this.edPreview = null;
  }

  private renderClan(): void {
    const c = this.hooks.getClan();
    $("home-clan-name").textContent = CLANS[c].name;
  }

  // ---------------- Рисовалка ----------------

  private openEditor(): void {
    this.homePreview?.dispose();
    this.homePreview = null;
    this.draft = { mode: this.avatar.mode, cells: [...this.avatar.cells] };
    this.show("editor");
    this.bindEditor();
    this.renderModes();
    this.renderPalette();
    this.edPreview = new AvatarPreview($("ed-preview") as HTMLCanvasElement);
    // Сетку рисуем после раскладки — тогда известен размер холста
    requestAnimationFrame(() => {
      this.drawGrid();
      this.edPreview?.show(this.draft);
    });
  }

  private bindEditor(): void {
    if (this.bound) return;
    this.bound = true;
    document.querySelectorAll<HTMLButtonElement>(".ed-modes button").forEach((b) =>
      b.addEventListener("click", () => {
        this.draft.mode = b.dataset.mode as AvatarData["mode"];
        this.renderModes();
        this.drawGrid();
        this.edPreview?.show(this.draft);
      }),
    );
    $("ed-back").addEventListener("click", () => this.home());
    $("ed-save").addEventListener("click", () => {
      this.avatar = { mode: this.draft.mode, cells: [...this.draft.cells] };
      saveAvatar(this.avatar);
      this.home();
    });
    $("ed-clear").addEventListener("click", () => {
      this.draft.cells.fill("");
      this.changed();
    });
    $("ed-reset").addEventListener("click", () => {
      this.draft.cells = defaultAvatar().cells;
      this.changed();
    });
    const grid = $("ed-grid") as HTMLCanvasElement;
    let painting = false;
    const paint = (e: PointerEvent) => {
      const r = grid.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * AV_W);
      const y = Math.floor(((e.clientY - r.top) / r.height) * AV_H);
      if (x < 0 || y < 0 || x >= AV_W || y >= AV_H) return;
      const mirror = ($("ed-mirror") as HTMLInputElement).checked;
      const set = (cx: number) => {
        this.draft.cells[y * AV_W + cx] = this.color;
      };
      set(x);
      if (mirror) set(AV_W - 1 - x);
      this.drawGrid();
    };
    grid.addEventListener("pointerdown", (e) => {
      painting = true;
      grid.setPointerCapture(e.pointerId);
      paint(e);
    });
    grid.addEventListener("pointermove", (e) => painting && paint(e));
    const stop = () => {
      if (!painting) return;
      painting = false;
      this.edPreview?.show(this.draft);
    };
    grid.addEventListener("pointerup", stop);
    grid.addEventListener("pointercancel", stop);
    window.addEventListener("resize", () => {
      if (!$("editor").classList.contains("hidden")) this.drawGrid();
    });
  }

  private changed(): void {
    this.drawGrid();
    this.edPreview?.show(this.draft);
  }

  private renderModes(): void {
    document.querySelectorAll<HTMLButtonElement>(".ed-modes button").forEach((b) => b.classList.toggle("selected", b.dataset.mode === this.draft.mode));
  }

  private renderPalette(): void {
    const el = $("ed-palette");
    el.innerHTML = "";
    for (const c of [...PALETTE, ""]) {
      const b = document.createElement("button");
      b.style.background = c || "transparent";
      b.textContent = c ? "" : "🧽";
      b.title = c ? c : "Ластик";
      b.classList.toggle("selected", c === this.color);
      b.addEventListener("click", () => {
        this.color = c;
        this.renderPalette();
      });
      el.appendChild(b);
    }
  }

  /** Сетка клеток: квадраты или кружки — как будет выглядеть фигура */
  private drawGrid(): void {
    const cv = $("ed-grid") as HTMLCanvasElement;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    const c = cv.getContext("2d")!;
    const cw = cv.width / AV_W;
    const ch = cv.height / AV_H;
    c.clearRect(0, 0, cv.width, cv.height);
    const round = this.draft.mode === "round";
    for (let y = 0; y < AV_H; y++) {
      for (let x = 0; x < AV_W; x++) {
        const col = this.draft.cells[y * AV_W + x];
        c.strokeStyle = "rgba(255,255,255,0.12)";
        c.lineWidth = 1;
        c.strokeRect(x * cw + 0.5, y * ch + 0.5, cw - 1, ch - 1);
        if (!col) continue;
        c.fillStyle = col;
        if (round) {
          c.beginPath();
          c.arc((x + 0.5) * cw, (y + 0.5) * ch, Math.min(cw, ch) * 0.56, 0, Math.PI * 2);
          c.fill();
        } else c.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2);
      }
    }
    // Линия симметрии
    c.strokeStyle = "rgba(255,255,255,0.3)";
    c.setLineDash([6, 6]);
    c.beginPath();
    c.moveTo(cv.width / 2, 0);
    c.lineTo(cv.width / 2, cv.height);
    c.stroke();
    c.setLineDash([]);
  }
}
