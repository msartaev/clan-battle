import "./style.css";
import type { ClanId } from "@clan-battle/shared";
import { CLANS } from "@clan-battle/shared";
import { Game } from "./game";
import { Input } from "./input";
import { isTouchDevice } from "./utils";

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
const testMode = params.has("test");
const touch = params.has("touch") || isTouchDevice();
const lowFx = touch || params.has("low");
const botCount = Math.max(1, Math.min(12, Number(params.get("bots")) || 7));

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
  setTimeout(() => {
    try {
      if (game && game.opts.clan !== clan) {
        game.dispose();
        game = null;
      }
      if (!game) {
        game = new Game(canvas, input, { clan, touch, lowFx, testMode, botCount });
        game.onDeath = (lives) => {
          $("dead-text").textContent =
            lives === 1 ? "Осталась последняя жизнь. Возрождение на базе…" : `Осталось жизней: ${lives}. Возрождение на базе…`;
          showScreen("dead");
        };
        game.onRespawn = () => showScreen(null);
        game.onGameOver = (kills) => {
          $("over-text").textContent = `Врагов повержено: ${kills}`;
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
