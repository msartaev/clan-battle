import "./style.css";
import type { ClanId, WeaponId } from "@clan-battle/shared";
import { CLANS } from "@clan-battle/shared";
import { Game } from "./game";
import { Input } from "./input";
import { isTouchDevice } from "./utils";

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
const testMode = params.has("test");
const touch = params.has("touch") || isTouchDevice();
// Качество графики: выбор игрока хранится в браузере; «Авто» — средне на телефоне, красиво на ПК
type Quality = "auto" | "high" | "medium" | "low";
const QUALITY_DETAIL = { high: 1, medium: 0.35, low: 0.15 } as const;
let quality: Quality = "auto";
try {
  const q = localStorage.getItem("cb_quality") as Quality | null;
  if (q && (q === "auto" || q in QUALITY_DETAIL)) quality = q;
} catch {
  /* хранилище недоступно — остаётся «Авто» */
}
if (params.has("low")) quality = "medium";
function resolvedQuality(): "high" | "medium" | "low" {
  return quality === "auto" ? (touch ? "medium" : "high") : quality;
}
// Размер вражеской команды (союзников на одного меньше — игрок тоже в команде): по умолчанию 5 на 5
const botCount = Math.max(1, Math.min(8, Number(params.get("bots")) || 5));

document.body.classList.toggle("touch", touch);

const canvas = $("game") as HTMLCanvasElement;
const input = new Input(canvas, touch);
let game: Game | null = null;
let clan: ClanId = (params.get("clan") as ClanId) in CLANS ? (params.get("clan") as ClanId) : "dragons";

const screens = ["start", "loading", "pause", "dead", "over"] as const;
function showScreen(id: (typeof screens)[number] | null): void {
  for (const s of screens) $(s).classList.toggle("hidden", s !== id);
}

// ----- Выбор клана -----
const clanButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".clan"));
function selectClan(c: ClanId): void {
  clan = c;
  clanButtons.forEach((b) => b.classList.toggle("selected", b.dataset.clan === c));
}
clanButtons.forEach((b) => b.addEventListener("click", () => selectClan(b.dataset.clan as ClanId)));
selectClan(clan);

// ----- Снаряжение: до 4 видов оружия и 2 видов бомб, выбор запоминается -----
type BombKind = "weak" | "boom" | "frost";
const LIMIT = { weapon: 4, bomb: 2 } as const;
let loadout: { weapon: string[]; bomb: string[] } = {
  weapon: ["weakPistol", "strongPistol", "clanWeapon", "sword"],
  bomb: ["weak", "boom"],
};
try {
  const saved = JSON.parse(localStorage.getItem("cb_loadout") ?? "null");
  if (saved?.weapon?.length && Array.isArray(saved.bomb)) loadout = saved;
} catch {
  /* нет сохранения — значения по умолчанию */
}
function renderLoadout(): void {
  for (const row of Array.from(document.querySelectorAll<HTMLElement>("#loadout .lo-row"))) {
    const kind = row.dataset.kind as "weapon" | "bomb";
    row.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("selected", loadout[kind].includes(b.dataset.id!)));
  }
}
document.querySelectorAll<HTMLElement>("#loadout .lo-row").forEach((row) => {
  const kind = row.dataset.kind as "weapon" | "bomb";
  row.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.id!;
      const list = loadout[kind];
      if (list.includes(id)) {
        // Хотя бы одно оружие должно остаться
        if (kind === "weapon" && list.length <= 1) return;
        loadout[kind] = list.filter((x) => x !== id);
      } else {
        if (list.length >= LIMIT[kind]) list.shift();
        list.push(id);
      }
      try {
        localStorage.setItem("cb_loadout", JSON.stringify(loadout));
      } catch {
        /* не сохранилось */
      }
      renderLoadout();
      game?.setLoadout(loadout.weapon as WeaponId[], loadout.bomb as BombKind[]);
    }),
  );
});
renderLoadout();

// ----- Качество графики -----
const qualityButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#quality button"));
function selectQuality(q: Quality): void {
  quality = q;
  qualityButtons.forEach((b) => b.classList.toggle("selected", b.dataset.q === q));
  try {
    localStorage.setItem("cb_quality", q);
  } catch {
    /* не сохранилось — не страшно */
  }
}
qualityButtons.forEach((b) =>
  b.addEventListener("click", () => {
    selectQuality(b.dataset.q as Quality);
    // Другое качество — мир строится заново при следующем запуске
    if (game) {
      game.dispose();
      game = null;
    }
  }),
);
qualityButtons.forEach((b) => b.classList.toggle("selected", b.dataset.q === quality));

// ----- Полноэкранный режим (по желанию; ошибки игнорируем) -----
async function enterFullscreen(): Promise<void> {
  if (testMode) return;
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    }
  } catch {
    /* браузер может не разрешить */
  }
  try {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (touch && o?.lock) await o.lock("landscape");
  } catch {
    /* iOS не умеет блокировать ориентацию */
  }
  try {
    // На ПК в полноэкранном режиме захватываем Ctrl+W и т.п., чтобы бег на Ctrl не закрывал вкладку
    const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }).keyboard;
    if (!touch && kb?.lock && document.fullscreenElement) {
      await kb.lock(["ControlLeft", "ControlRight", "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyT", "KeyN", "Space"]);
    }
  } catch {
    /* не поддерживается */
  }
}

// ----- Старт игры -----
function startGame(): void {
  input.reset();
  showScreen("loading");
  // Даём браузеру нарисовать «Загрузка…» перед тяжёлой сборкой сцены
  setTimeout(async () => {
    try {
      if (game && game.opts.clan !== clan) {
        game.dispose();
        game = null;
      }
      if (!game) {
        const q = resolvedQuality();
        game = await Game.create(canvas, input, { clan, touch, lowFx: q !== "high", detail: QUALITY_DETAIL[q], testMode, botCount });
        game.setLoadout(loadout.weapon as WeaponId[], loadout.bomb as BombKind[]);
        game.resetMatch();
        game.onDeath = (lives) => {
          $("dead-text").textContent =
            lives === 1 ? "Осталась последняя жизнь. Возрождение на базе…" : `Осталось жизней: ${lives}. Возрождение на базе…`;
          showScreen("dead");
        };
        game.onRespawn = () => showScreen(null);
        game.onGameOver = (r) => {
          $("over-title").textContent = r.winner === null ? (r.reason.includes("ничья") ? "Ничья" : "Ты выбыл") : r.won ? "Победа! 🏆" : "Поражение";
          const end = /[.!]$/.test(r.reason) ? "" : ".";
          $("over-text").textContent = `${r.reason}${end} Врагов повержено тобой: ${r.kills}`;
          showScreen("over");
          if (document.pointerLockElement) document.exitPointerLock();
        };
      } else {
        game.resetMatch();
      }
      game.setPaused(false);
      input.enabled = true;
      document.body.classList.add("in-game");
      game.hud.show(true);
      showScreen(null);
      (window as unknown as { __game: Game }).__game = game;
    } catch (e) {
      console.error(e);
      $("loading").innerHTML = `<div class="start-card"><h2>Не получилось запустить 3D</h2><p>${String(
        (e as Error)?.message ?? e,
      )}</p></div>`;
    }
  }, 30);
}

function toMenu(): void {
  input.enabled = false;
  game?.setPaused(true);
  game?.hud.show(false);
  document.body.classList.remove("in-game");
  if (document.pointerLockElement) document.exitPointerLock();
  showScreen("start");
}

$("play").addEventListener("click", () => {
  input.requestPointerLock();
  void enterFullscreen();
  startGame();
});
$("restart").addEventListener("click", () => {
  input.requestPointerLock();
  startGame();
});
$("to-menu").addEventListener("click", toMenu);
$("to-menu-pause").addEventListener("click", toMenu);
$("resume").addEventListener("click", () => {
  input.requestPointerLock();
  if (testMode) resume();
});

function resume(): void {
  if (!game) return;
  game.setPaused(false);
  input.enabled = true;
  if (game.state === "dead") showScreen("dead");
  else showScreen(null);
}

// На ПК: потеряли захват мыши (Esc) — пауза; захватили — продолжаем
document.addEventListener("pointerlockchange", () => {
  if (!game || touch || testMode) return;
  if (document.pointerLockElement === canvas) {
    resume();
  } else if (game.state !== "over" && document.body.classList.contains("in-game")) {
    game.setPaused(true);
    input.enabled = false;
    showScreen("pause");
  }
});
// Клик по игре без захвата мыши — снова захватить
canvas.addEventListener("click", () => {
  if (game && !touch && !document.pointerLockElement && document.body.classList.contains("in-game")) {
    input.requestPointerLock();
  }
});

// Ctrl+W в браузере не перехватить без полноэкранного режима — хотя бы спросим перед закрытием
window.addEventListener("beforeunload", (e) => {
  if (game && !testMode && document.body.classList.contains("in-game") && game.state !== "over") {
    e.preventDefault();
    e.returnValue = "";
  }
});

// Для автотестов: ?autostart — сразу в игру
if (params.has("autostart")) startGame();
