// Дымовой тест: открывает собранную игру в headless Chromium, проверяет консоль,
// делает скриншоты и немного «играет» через тестовые хуки.
// Запуск: сначала `npm run build && npm run preview`, затем `npm run smoke`.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const URL = process.env.GAME_URL ?? "http://127.0.0.1:4173/";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shots = path.join(root, "docs", "screenshots");
mkdirSync(shots, { recursive: true });

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function watch(page, label) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${label}] console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[${label}] pageerror: ${e.message}`));
}

// Полный Chromium, а не headless shell: в shell программный WebGL (SwiftShader)
// на сборке сцены уходит в бесконечный рост памяти и вкладка падает.
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

// ---------- ПК ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  watch(page, "desktop");
  await page.goto(URL + "?test", { waitUntil: "load" });
  await sleep(500);
  await page.screenshot({ path: path.join(shots, "01-start-screen.png") });

  await page.click("#play");
  await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
  await sleep(2500);

  const info = await page.evaluate(() => {
    const g = window.__game;
    return {
      webgl: g.engine.webGLVersion,
      meshes: g.scene.meshes.length,
      activeMeshes: g.scene.getActiveMeshes().length,
      bots: g.bots.length,
      hp: g.player.hp,
      ammo: g.player.ammo,
      lives: g.player.lives,
    };
  });
  console.log("desktop scene:", info);

  // Ставим игрока в деревню, двух ботов — перед ним, чтобы попали в кадр
  await page.evaluate(() => {
    const g = window.__game;
    g.player.collider.position.set(-2, 0, 1.5);
    g.player.yaw = Math.PI * 0.85;
    g.player.pitch = 0.08;
    const B = window.__game.bots;
    B[0].spawn(new g.player.collider.position.constructor(-4.5, 0, -6), 0.2);
    B[1].spawn(new g.player.collider.position.constructor(-0.5, 0, -9), -0.3);
    for (const b of B) b.state = "wander";
  });
  // Немного пройти вперёд по-настоящему (клавиатура)
  await page.keyboard.down("KeyW");
  await sleep(600);
  await page.keyboard.up("KeyW");
  await page.keyboard.press("Digit3");
  await page.evaluate(() => {
    window.__game.input.mouseFire = true;
  });
  await sleep(450);
  await page.evaluate(() => {
    window.__game.input.mouseFire = false;
  });
  await sleep(120);
  await page.screenshot({ path: path.join(shots, "02-gameplay-3rd-person.png") });

  // Переключаем на 1-е лицо клавишей V
  await page.keyboard.press("KeyV");
  await page.keyboard.press("Digit2");
  await sleep(700);
  await page.screenshot({ path: path.join(shots, "03-gameplay-1st-person.png") });

  // Проверка стрельбы: ставим бота прямо перед камерой и стреляем сильным пистолетом
  const shootResult = await page.evaluate(async () => {
    const g = window.__game;
    const V = g.player.collider.position.constructor;
    g.player.collider.position.set(0, 0, -25);
    g.player.yaw = 0;
    g.player.pitch = 0.0;
    g.player.ammo = 50;
    const b = g.bots[2];
    b.spawn(new V(0, 0, -17), Math.PI);
    b.state = "wander";
    const killsBefore = g.kills;
    const hpBefore = b.hp;
    g.player.selectWeapon(1);
    // На программном рендере кадры идут по 2–3 в секунду, поэтому ждём кадры, а не время:
    // сначала камера должна переехать к телепортированному игроку, потом один выстрел
    const frames = async (n) => {
      const until = g.engine.frameId + n;
      while (g.engine.frameId < until) await new Promise((r) => setTimeout(r, 50));
    };
    await frames(3);
    b.spawn(new V(0, 0, -17), Math.PI);
    g.input.mouseFire = true;
    const t0 = Date.now();
    while (g.player.ammo === 50 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
    g.input.mouseFire = false;
    await frames(2);
    return { killsBefore, killsAfter: g.kills, botHpBefore: hpBefore, botHpAfter: b.hp, botState: b.state, ammoLeft: g.player.ammo };
  });
  console.log("shoot test:", shootResult);
  if (shootResult.botHpAfter >= shootResult.botHpBefore) errors.push("[desktop] shoot test: выстрел в упор не ранил бота");

  // Проверка ботов: стоим на открытом месте — боты должны найти и ранить игрока
  const botTest = await page.evaluate(async () => {
    const g = window.__game;
    const V = g.player.collider.position.constructor;
    g.player.collider.position.set(30, 0, 30);
    g.player.hp = 100;
    g.player.invulnerableUntil = 0;
    g.bots.forEach((b, i) => b.spawn(new V(40 + i, 0, 38), Math.PI * 1.2));
    await new Promise((r) => setTimeout(r, 8000));
    return { hp: g.player.hp, lives: g.player.lives, state: g.state, botStates: g.bots.map((b) => b.state) };
  });
  console.log("bot test:", botTest);

  // Проверка прыжка и коллизий с домом
  const moveTest = await page.evaluate(async () => {
    const g = window.__game;
    g.state = "playing";
    g.player.alive = true;
    g.player.hp = 100;
    g.bots.forEach((b) => b.spawn(b.position.clone().set(55, 0, 55), 0));
    g.player.collider.position.set(-16, 0, 2.5); // перед домом (-16,-5), дверь смотрит на +z
    g.player.yaw = Math.PI; // смотрим на -z, в сторону дома
    g.player.selectWeapon(0);
    // Прыжок
    g.input.jumpPressed = true;
    let maxY = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 30));
      maxY = Math.max(maxY, g.player.position.y);
    }
    return { maxJumpY: +maxY.toFixed(2) };
  });
  // Идём в стену сбоку от двери: должны остановиться
  await page.evaluate(() => {
    const g = window.__game;
    g.player.collider.position.set(-18.6, 0, 2.5);
    g.player.yaw = Math.PI;
  });
  await page.keyboard.down("KeyW");
  await sleep(2500);
  await page.keyboard.up("KeyW");
  const wallZ = await page.evaluate(() => window.__game.player.position.z);
  // Идём в дверь: должны зайти внутрь
  await page.evaluate(() => {
    const g = window.__game;
    g.player.collider.position.set(-16, 0, 2.5);
    g.player.yaw = Math.PI;
  });
  await page.keyboard.down("KeyW");
  await sleep(2000);
  await page.keyboard.up("KeyW");
  const doorZ = await page.evaluate(() => window.__game.player.position.z);
  console.log("move test:", { ...moveTest, stoppedAtWallZ: +wallZ.toFixed(2), walkedThroughDoorZ: +doorZ.toFixed(2) });
  await page.screenshot({ path: path.join(shots, "05-inside-house.png") });

  // Конец игры: три смерти
  const overTest = await page.evaluate(async () => {
    const g = window.__game;
    for (let i = 0; i < 3; i++) {
      g.player.invulnerableUntil = 0;
      g.state = "playing";
      g.player.alive = true;
      g["damagePlayer"](1000);
    }
    return { state: g.state, lives: g.player.lives };
  });
  await sleep(400);
  console.log("game over test:", overTest);
  await page.screenshot({ path: path.join(shots, "06-game-over.png") });
  await page.click("#restart");
  await sleep(800);
  const afterRestart = await page.evaluate(() => ({ state: window.__game.state, lives: window.__game.player.lives, kills: window.__game.kills }));
  console.log("after restart:", afterRestart);
  const fps = await page.evaluate(() => window.__game.engine.getFps().toFixed(1));
  console.log("desktop fps (swiftshader, CPU):", fps);
  await ctx.close();
}

// ---------- Телефон ----------
{
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  });
  const page = await ctx.newPage();
  watch(page, "mobile");
  await page.goto(URL + "?test&clan=snakes", { waitUntil: "load" });
  await sleep(500);
  await page.screenshot({ path: path.join(shots, "07-mobile-start.png") });
  await page.tap("#play");
  await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
  await sleep(2500);
  const touchOn = await page.evaluate(() => ({
    bodyTouch: document.body.classList.contains("touch"),
    touchVisible: getComputedStyle(document.getElementById("touch")).display !== "none",
    scaling: window.__game.engine.getHardwareScalingLevel(),
    renderSize: [window.__game.engine.getRenderWidth(), window.__game.engine.getRenderHeight()],
  }));
  console.log("mobile:", touchOn);

  // Сенсорный джойстик: двигаем палец по левой зоне через CDP-события касания
  const cdp = await ctx.newCDPSession(page);
  const posBefore = await page.evaluate(() => window.__game.player.position.clone());
  const jb = await page.locator("#joy-base").boundingBox();
  const cx = jb.x + jb.width / 2;
  const cy = jb.y + jb.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: cy - 50, id: 1 }] });
  await sleep(1200);
  // Пока держим джойстик — жмём «Огонь» вторым пальцем и тянем для поворота
  const fb = await page.locator("#btn-fire").boundingBox();
  const fx = fb.x + fb.width / 2;
  const fy = fb.y + fb.height / 2;
  const yawBefore = await page.evaluate(() => window.__game.player.yaw);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: cx, y: cy - 50, id: 1 },
      { x: fx, y: fy, id: 2 },
    ],
  });
  await sleep(200);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: cx, y: cy - 50, id: 1 },
      { x: fx - 60, y: fy, id: 2 },
    ],
  });
  await sleep(300);
  await page.screenshot({ path: path.join(shots, "04-mobile-gameplay-touch.png") });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(100);
  const after = await page.evaluate(() => ({
    pos: window.__game.player.position.clone(),
    yaw: window.__game.player.yaw,
    ammo: window.__game.player.ammo,
  }));
  console.log("mobile touch test:", {
    moved: +Math.hypot(after.pos._x - posBefore._x, after.pos._z - posBefore._z).toFixed(2),
    yawChanged: +(after.yaw - yawBefore).toFixed(3),
    ammoAfterFire: after.ammo,
  });
  // Кнопка «Камера» → 1-е лицо
  await page.tap("#btn-camera");
  await sleep(600);
  const fp = await page.evaluate(() => window.__game.firstPerson);
  console.log("mobile camera toggle -> firstPerson:", fp);
  await page.screenshot({ path: path.join(shots, "08-mobile-1st-person.png") });
  const fps = await page.evaluate(() => window.__game.engine.getFps().toFixed(1));
  console.log("mobile fps (swiftshader, CPU):", fps);
  await ctx.close();
}

await browser.close();
console.log("\nconsole/page errors:", errors.length ? errors : "none");
process.exit(errors.length ? 1 : 0);
