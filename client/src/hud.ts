import { CLANS, RULES, WEAPON_ORDER, weaponDisplayName, type ClanId, type WeaponId } from "@clan-battle/shared";

const $ = (id: string) => document.getElementById(id)!;

const HEART_FULL =
  '<svg viewBox="0 0 24 22"><path d="M12 21 L2.5 11.5 A5.5 5.5 0 0 1 12 4 A5.5 5.5 0 0 1 21.5 11.5 Z" fill="#ff3b4e" stroke="#fff" stroke-width="1.5"/></svg>';
const HEART_EMPTY =
  '<svg viewBox="0 0 24 22"><path d="M12 21 L2.5 11.5 A5.5 5.5 0 0 1 12 4 A5.5 5.5 0 0 1 21.5 11.5 Z" fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/></svg>';

/** Интерфейс поверх игры (обычный HTML — легче, чем 3D-интерфейс, и чётче на телефоне) */
export class Hud {
  private root = $("hud");
  private hpNum = $("hp-num");
  private hpFill = $("hp-fill");
  private ammo = $("ammo");
  private weaponName = $("weapon-name");
  private kills = $("kills");
  private lives = $("lives");
  private fps = $("fps");
  private toast = $("toast");
  private hitmarker = $("hitmarker");
  private vignette = $("vignette");
  private status = $("status");
  private hiddenBadge = $("hidden-badge");
  private teamDragons = document.querySelector<HTMLElement>("#teams .t-dragons b")!;
  private teamSnakes = document.querySelector<HTMLElement>("#teams .t-snakes b")!;
  private timer = $("timer");
  private bombsEl = $("bombs");
  private resEl = $("res");
  private capture = $("capture");
  private captureLabel = document.querySelector<HTMLElement>("#capture .cap-label")!;
  private captureFill = document.querySelector<HTMLElement>("#capture .cap-bar i")!;
  private slots = Array.from(document.querySelectorAll<HTMLElement>("#slots .slot"));
  private cache: Record<string, string | number | boolean> = {};
  private toastTimer = 0;
  private hitTimer = 0;
  private vignetteTimer = 0;

  constructor(private clan: ClanId) {
    const c = CLANS[clan];
    document.documentElement.style.setProperty("--clan", c.color);
    document.documentElement.style.setProperty("--clan-accent", c.accent);
    $("clan-badge").textContent = c.name;
    // Клановый предмет для разведки: у Драконов подзорная труба, у Змей бинокль
    $("btn-scope").textContent = clan === "dragons" ? "Труба" : "Бинокль";
    this.slots.forEach((s, i) => {
      const id = WEAPON_ORDER[i];
      const short =
        id === "weakPistol" ? "Слабый" : id === "strongPistol" ? "Сильный" : id === "slingshot" ? "Рогатка" : id === "sword" ? "Меч" : c.weaponName;
      s.innerHTML = `<span>${i + 1}</span>${short}`;
    });
  }

  /** Обработчик нажатия на слот оружия (для телефона) */
  onSlotTap(cb: (i: number) => void): void {
    this.slots.forEach((s, i) => {
      s.ontouchstart = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cb(i);
      };
    });
  }

  show(v: boolean): void {
    this.root.classList.toggle("hidden", !v);
  }

  private set(key: string, v: string | number | boolean, apply: () => void): void {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    apply();
  }

  update(dt: number, s: { hp: number; ammo: number; weapon: WeaponId; kills: number; lives: number; fps: number; status: string; hidden: boolean; owned: WeaponId[]; swordLevel: number; res: { wood: number; leather: number }; bombs: { weak: number; strong: number; boom: number; frost: number }; domeLeft: number; teams: Record<ClanId, number>; timeLeft: number; capture: { text: string; t: number; color: string } | null }): void {
    const hp = Math.ceil(s.hp);
    this.set("hp", hp, () => {
      this.hpNum.textContent = String(hp);
      this.hpFill.style.width = `${(hp / RULES.maxHp) * 100}%`;
      this.hpFill.classList.toggle("low", hp <= 30);
    });
    const melee = s.weapon === "sword";
    this.set("ammo", melee ? "melee" : s.ammo, () => {
      // Меч патроны не тратит — показываем подсказку вместо счётчика
      this.ammo.innerHTML = melee ? "держи — замах, отпусти — удар" : `<b>${s.ammo}</b> патронов`;
      this.ammo.classList.toggle("empty", !melee && s.ammo <= 0);
    });
    const bombsText = `${s.bombs.weak}|${s.bombs.strong}|${s.bombs.boom}|${s.bombs.frost}|${Math.ceil(s.domeLeft)}`;
    this.set("bombs", bombsText, () => {
      const dome = s.domeLeft > 0 ? `<span class="dome-on">Купол: ${Math.ceil(s.domeLeft)} с</span> · ` : "";
      this.bombsEl.innerHTML = `${dome}Купол ${s.bombs.weak}+${s.bombs.strong} · 💥 ${s.bombs.boom} · 🧊 ${s.bombs.frost}`;
    });
    this.set("res", `${s.res.wood}|${s.res.leather}`, () => {
      this.resEl.textContent = s.res.wood || s.res.leather ? `🪵 ${s.res.wood} · 🟫 ${s.res.leather}` : "";
    });
    this.set("owned", s.owned.join(","), () => {
      this.slots.forEach((el, i) => (el.style.display = s.owned.includes(WEAPON_ORDER[i]) ? "" : "none"));
    });
    this.set("weapon", `${s.weapon}${s.swordLevel}`, () => {
      this.weaponName.textContent = weaponDisplayName(s.weapon, this.clan, s.swordLevel);
      const idx = WEAPON_ORDER.indexOf(s.weapon);
      this.slots.forEach((el, i) => el.classList.toggle("active", i === idx));
    });
    this.set("kills", s.kills, () => {
      this.kills.innerHTML = `Убито: <b>${s.kills}</b>`;
    });
    this.set("lives", s.lives, () => {
      let h = "";
      for (let i = 0; i < RULES.lives; i++) h += i < s.lives ? HEART_FULL : HEART_EMPTY;
      this.lives.innerHTML = h;
    });
    this.set("fps", s.fps, () => {
      this.fps.textContent = `${s.fps} FPS`;
    });
    this.set("teams", `${s.teams.dragons}:${s.teams.snakes}`, () => {
      this.teamDragons.textContent = String(s.teams.dragons);
      this.teamSnakes.textContent = String(s.teams.snakes);
    });
    const sec = Math.max(0, Math.ceil(s.timeLeft));
    const clock = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    this.set("timer", clock, () => {
      this.timer.textContent = clock;
      this.timer.classList.toggle("urgent", sec <= 60);
    });
    const cap = s.capture;
    this.set("capText", cap ? cap.text : "", () => {
      this.capture.classList.toggle("show", !!cap);
      if (cap) {
        this.captureLabel.textContent = cap.text;
        this.captureFill.style.background = cap.color;
      }
    });
    if (cap) this.captureFill.style.width = `${Math.round(cap.t * 100)}%`;
    this.set("status", s.status, () => {
      this.status.textContent = s.status;
    });
    this.set("hidden", s.hidden, () => {
      this.hiddenBadge.classList.toggle("show", s.hidden);
    });

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove("show");
    }
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmarker.classList.remove("show", "kill");
    }
    if (this.vignetteTimer > 0) {
      this.vignetteTimer -= dt;
      if (this.vignetteTimer <= 0) this.vignette.classList.remove("show");
    }
  }

  message(text: string, seconds = 1.6, color = "#ffffff"): void {
    this.toast.textContent = text;
    this.toast.style.color = color;
    this.toast.classList.add("show");
    this.toastTimer = seconds;
  }

  hit(kill: boolean): void {
    this.hitmarker.classList.add("show");
    this.hitmarker.classList.toggle("kill", kill);
    this.hitTimer = kill ? 0.35 : 0.12;
  }

  damage(): void {
    this.vignette.classList.add("show");
    this.vignetteTimer = 0.18;
  }

  reset(): void {
    this.cache = {};
    this.toast.classList.remove("show");
    this.hitmarker.classList.remove("show", "kill");
    this.vignette.classList.remove("show");
  }
}
