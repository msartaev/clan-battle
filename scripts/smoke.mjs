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
    // Только враги рядом; союзников уводим далеко, иначе враги будут стрелять в них
    g.bots.forEach((b, i) =>
      b.clan !== g.player.clan ? b.spawn(new V(40 + i, 0, 38), Math.PI * 1.2) : b.spawn(new V(-55 + i, 0, -55), 0),
    );
    // Кадры, а не время: на программном рендере 8 секунд — это всего десяток кадров
    const u = g.engine.frameId + 220;
    while (g.engine.frameId < u && g.player.hp >= 100 && g.player.lives === 3) await new Promise((r) => setTimeout(r, 20));
    return { hp: g.player.hp, lives: g.player.lives, state: g.state, botStates: g.bots.map((b) => b.state) };
  });
  console.log("bot test:", botTest);
  if (botTest.hp >= 100 && botTest.lives === 3) errors.push("[desktop] bot test: враги не нашли и не ранили игрока");

  // 5 на 5: союзники и враги друг напротив друга на поле — должны начать бой между собой
  const teamTest = await page.evaluate(async () => {
    const g = window.__game;
    const V = g.player.collider.position.constructor;
    g.player.collider.position.set(-55, 0, 55); // игрок в стороне
    const enemies = g.bots.filter((b) => b.clan !== g.player.clan);
    const allies = g.bots.filter((b) => b.clan === g.player.clan);
    enemies.forEach((b, i) => b.spawn(new V(30 + i * 2, 0, -30), Math.PI));
    allies.forEach((b, i) => b.spawn(new V(30 + i * 2, 0, -46), 0));
    // ~6 секунд игрового времени (кадры, а не время — см. выше)
    const until = g.engine.frameId + 120;
    while (g.engine.frameId < until) await new Promise((r) => setTimeout(r, 30));
    const hurt = (list) => list.filter((b) => !b.alive || b.hp < 100).length;
    return { enemies: enemies.length, allies: allies.length, enemiesHurt: hurt(enemies), alliesHurt: hurt(allies), teams: document.getElementById("teams").textContent };
  });
  console.log("team test:", teamTest);
  if (teamTest.enemies !== 5 || teamTest.allies !== 4) errors.push("[desktop] team test: не 5 на 5");
  if (teamTest.enemiesHurt + teamTest.alliesHurt === 0) errors.push("[desktop] team test: боты не воюют друг с другом");

  // Подзорная труба (B) и прицел (ПКМ): приближение, стрельба в трубе запрещена
  const scopeTest = await page.evaluate(async () => {
    const g = window.__game;
    g.state = "playing";
    g.player.alive = true;
    g.player.hp = 100;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 30));
    };
    g.input.scopeToggle = true;
    await frames(12);
    const scopedFov = g.camera.fov;
    const overlay = document.getElementById("scope").className;
    const ammo0 = g.player.ammo;
    g.input.mouseFire = true;
    await frames(4);
    g.input.mouseFire = false;
    const ammoScoped = g.player.ammo;
    g.input.scopeToggle = true;
    await frames(12);
    return { scoped: g.scoped, scopedFov: +scopedFov.toFixed(2), overlay, shotInScope: ammo0 !== ammoScoped, fovAfter: +g.camera.fov.toFixed(2) };
  });
  console.log("scope test:", scopeTest);
  if (scopeTest.scopedFov > 0.4 || scopeTest.shotInScope || scopeTest.fovAfter < 0.9) errors.push("[desktop] scope test: приближение или запрет стрельбы не работают");

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
    // Ждём кадры, а не время: на программном рендере кадр длится полсекунды, а шаг игры ограничен 0.05 с
    g.input.jumpPressed = true;
    let maxY = 0;
    const until = g.engine.frameId + 30;
    while (g.engine.frameId < until) {
      await new Promise((r) => setTimeout(r, 20));
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
  const waitFrames = (n) =>
    page.evaluate(async (n) => {
      const g = window.__game;
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    }, n);
  await page.keyboard.down("KeyW");
  await waitFrames(60);
  await page.keyboard.up("KeyW");
  const wallZ = await page.evaluate(() => window.__game.player.position.z);
  // Идём в дверь: должны зайти внутрь
  await page.evaluate(() => {
    const g = window.__game;
    g.player.collider.position.set(-16, 0, 2.5);
    g.player.yaw = Math.PI;
  });
  await page.keyboard.down("KeyW");
  await waitFrames(50);
  await page.keyboard.up("KeyW");
  const doorZ = await page.evaluate(() => window.__game.player.position.z);
  console.log("move test:", { ...moveTest, stoppedAtWallZ: +wallZ.toFixed(2), walkedThroughDoorZ: +doorZ.toFixed(2) });
  await page.screenshot({ path: path.join(shots, "05-inside-house.png") });

  // Аптечка: ранен — подобрал синюю аптечку — +25 здоровья
  const medTest = await page.evaluate(async () => {
    const g = window.__game;
    g.state = "playing";
    g.player.alive = true;
    g.player.hp = 50;
    g.player.lastDamageAt = g.now; // чтобы не мешало восстановление
    const m = g["medkits"].find((x) => x.active);
    g.player.collider.position.set(m.pos.x, 0, m.pos.z);
    const u = g.engine.frameId + 3;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    return { medkits: g["medkits"].length, hp: g.player.hp };
  });
  console.log("medkit test:", medTest);
  if (medTest.hp < 75) errors.push("[desktop] medkit test: аптечка не вылечила");

  // Захват флага: игрок стоит у вражеского бункера 10 игровых секунд — победа
  const flagTest = await page.evaluate(async () => {
    const g = window.__game;
    g.state = "playing";
    g.player.alive = true;
    g.player.hp = 100;
    g.player.invulnerableUntil = g.now + 999; // боты не мешают
    const enemy = g.player.clan === "dragons" ? "snakes" : "dragons";
    g.bots.forEach((b) => b.spawn(b.position.clone().set(0, 0, 60), 0));
    const fp = g.world.bases[enemy].flagPoint;
    let result = null;
    const orig = g.onGameOver;
    g.onGameOver = (r) => (result = r);
    g.player.collider.position.set(fp.x + 1, 0, fp.z + 1);
    const t0 = g.now;
    const until = g.engine.frameId + 260;
    while (g.engine.frameId < until && !result) await new Promise((r) => setTimeout(r, 20));
    g.onGameOver = orig;
    return { state: g.state, won: result?.won, reason: result?.reason, seconds: +(g.now - t0).toFixed(1) };
  });
  console.log("flag test:", flagTest);
  if (!flagTest.won) errors.push("[desktop] flag test: захват флага не дал победу");
  await page.evaluate(() => window.__game.resetMatch());

  // Звери: волк сам нападает на игрока; выстрелы его ранят
  const animalTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    g.player.invulnerableUntil = 0;
    g.player.hp = 100;
    g.bots.forEach((b) => b.spawn(b.position.clone().set(0, 0, 60), 0));
    const wolf = g.animals.find((a) => a.kind === "wolf");
    g.player.collider.position.set(-20, 0, 20);
    wolf.spawn(new g.player.collider.position.constructor(-20, 0, 26));
    let u = g.engine.frameId + 150;
    while (g.engine.frameId < u && g.player.hp >= 100) await new Promise((r) => setTimeout(r, 20));
    const hpAfterBite = g.player.hp;
    // Волк замирает в 6 м, игрок целится ему в бок от первого лица
    const V = g.player.collider.position.constructor;
    wolf.root.position.set(-20, 0, 26);
    wolf.update = () => {};
    g.setFirstPerson(true);
    const d = wolf.pos.subtract(g.player.position);
    g.player.yaw = Math.atan2(d.x, d.z);
    g.player.pitch = Math.atan2(g.player.eyeHeight - 0.5, Math.hypot(d.x, d.z));
    u = g.engine.frameId + 3;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    g.player.selectWeapon(1);
    g.player.ammo = 50;
    const wolfHp0 = wolf.hp;
    g.input.mouseFire = true;
    u = g.engine.frameId + 25;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    g.input.mouseFire = false;
    g.setFirstPerson(false);
    delete wolf.update;
    return { animals: g.animals.map((a) => a.kind).join(","), hpAfterBite, wolfHp0, wolfHp: wolf.hp, wolfTarget: !!wolf.target };
  });
  console.log("animal test:", animalTest);
  if (animalTest.hpAfterBite >= 100) errors.push("[desktop] animal test: волк не напал");
  if (animalTest.wolfHp >= animalTest.wolfHp0) errors.push("[desktop] animal test: выстрелы не ранили волка");
  await page.evaluate(() => window.__game.resetMatch());

  // Окна: выстрел разбивает стекло, через разбитое окно можно залезть в дом; рогатка ранит
  const windowTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    g.player.invulnerableUntil = g.now + 999;
    g.bots.forEach((b) => b.spawn(b.position.clone().set(0, 0, 60), 0));
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    const ws = g.world.windows;
    // Окно дома (подоконник 1 м), снаружи стоим в 4 м и целимся в центр стекла
    const w = ws.find((x) => Math.abs(x.sill - 1) < 0.01);
    const out = w.center.add(w.normal.scale(4));
    g.setFirstPerson(true);
    g.player.collider.position.set(out.x, 0, out.z);
    const d = w.center.subtract(new out.constructor(out.x, g.player.eyeHeight, out.z));
    g.player.yaw = Math.atan2(d.x, d.z);
    g.player.pitch = -Math.atan2(d.y, Math.hypot(d.x, d.z));
    g.player.selectWeapon(1);
    await frames(3);
    const ammo0 = g.player.ammo;
    g.input.mouseFire = true;
    for (let k = 0; k < 30 && !w.broken; k++) await frames(1);
    g.input.mouseFire = false;
    await frames(2);
    const broken = w.broken;
    const shots = ammo0 - g.player.ammo;
    // Лезем: подходим вплотную и идём в окно
    const near = w.center.add(w.normal.scale(0.6));
    g.player.collider.position.set(near.x, 0, near.z);
    g.player.yaw = Math.atan2(-w.normal.x, -w.normal.z);
    g.player.pitch = 0;
    if (!broken) return { windows: ws.length, broken, shots, state: g.state, alive: g.player.alive, weapon: g.player.weapon };
    return { windows: ws.length, broken, shots, side0: +((g.player.position.x - w.center.x) * w.normal.x + (g.player.position.z - w.center.z) * w.normal.z).toFixed(2), wn: [w.normal.x, w.normal.z] };
  });
  if (!windowTest.broken) console.log("window test (failed):", windowTest);
  await page.keyboard.down("KeyW");
  await page.evaluate(async () => {
    const g = window.__game;
    const u = g.engine.frameId + 8;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
  });
  await page.keyboard.up("KeyW");
  const vault = await page.evaluate(() => {
    const g = window.__game;
    const w = g.world.windows.find((x) => x.broken);
    g.setFirstPerson(false);
    if (!w) return NaN;
    return +((g.player.position.x - w.center.x) * w.normal.x + (g.player.position.z - w.center.z) * w.normal.z).toFixed(2);
  });
  console.log("window test:", { ...windowTest, sideAfter: vault });
  if (!windowTest.broken) errors.push("[desktop] window test: выстрел не разбил стекло");
  if (!(vault < 0)) errors.push("[desktop] window test: не получилось залезть в разбитое окно");

  const slingTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    p.owned.add("slingshot");
    p.selectWeapon(3);
    p.collider.position.set(0, 0, -25);
    p.yaw = 0;
    p.pitch = 0;
    const b = g.bots[2];
    b.spawn(new p.collider.position.constructor(0, 0, -17), Math.PI);
    b.update = () => {};
    g.setFirstPerson(true);
    let u = g.engine.frameId + 3;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    const hp0 = b.hp;
    g.input.mouseFire = true;
    u = g.engine.frameId + 12;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    g.input.mouseFire = false;
    u = g.engine.frameId + 10;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    delete b.update;
    g.setFirstPerson(false);
    return { weapon: p.weapon, hp0, hp: b.hp };
  });
  console.log("slingshot test:", slingTest);
  if (slingTest.weapon !== "slingshot" || slingTest.hp >= slingTest.hp0) errors.push("[desktop] slingshot test: рогатка не ранит");
  await page.evaluate(() => window.__game.resetMatch());

  // Лечебная бомба: купол лечит, не даёт умереть и запрещает стрелять из-под себя
  const domeTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    p.collider.position.set(-30, 0, -10);
    p.hp = 40;
    p.invulnerableUntil = 0;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    g.input.bomb = "weak";
    await frames(2);
    const weakLeft = g.bombs.weak;
    await frames(20);
    const hpHealed = p.hp;
    g["damagePlayer"](500);
    const aliveUnderDome = p.alive;
    const ammo0 = p.ammo;
    g.input.mouseFire = true;
    await frames(6);
    g.input.mouseFire = false;
    return { dome: !!g.dome, weakLeft, hpHealed: Math.round(hpHealed), aliveUnderDome, shotUnderDome: p.ammo !== ammo0 };
  });
  console.log("dome test:", domeTest);
  if (!domeTest.dome || domeTest.weakLeft !== 0 || domeTest.hpHealed <= 40 || !domeTest.aliveUnderDome || domeTest.shotUnderDome)
    errors.push("[desktop] dome test: купол работает не так");
  await page.evaluate(() => window.__game.resetMatch());

  // Подвал: в комнате стоим на его полу (-2.6), из люка по верхней ступеньке выходим на пол дома
  const cellarTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    p.collider.position.set(-16, -2.5, 8.5);
    await frames(6);
    const roomY = +p.position.y.toFixed(2);
    // Верхняя ступенька у восточного края люка
    p.collider.position.set(-11.45, 0.05, 10.2);
    await frames(4);
    const topStepY = +p.position.y.toFixed(2);
    return { roomY, topStepY };
  });
  console.log("cellar test:", cellarTest);
  if (Math.abs(cellarTest.roomY + 2.6) > 0.1 || cellarTest.topStepY < -0.1) errors.push("[desktop] cellar test: пол подвала или ступеньки не работают");
  await page.evaluate(() => window.__game.resetMatch());

  // Меч: замах с удержанием даёт больше урона; меч-щит гасит половину урона
  const swordTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    // Остальные боты далеко и без бомб: заморозка игрока сорвала бы замах (тест «мигал»)
    g.bots.forEach((x) => {
      x.spawn(new p.collider.position.constructor(-50, 0, 60), 0);
      x.bombs = { boom: 0, frost: 0 };
    });
    p.collider.position.set(0, 0, -25);
    p.yaw = 0;
    p.selectWeapon(4);
    const b = g.bots[1];
    b.spawn(new p.collider.position.constructor(0, 0, -23.6), Math.PI);
    b.update = () => {};
    await frames(2);
    const hp0 = b.hp;
    g.input.mouseFire = true;
    await frames(30); // ~1.5 с замаха
    g.input.mouseFire = false;
    await frames(3);
    const dealt = hp0 - b.hp;
    const dbg = { frozen: g["playerFrozenUntil"] > g.now, state: g.state, alive: p.alive, dist: +Math.hypot(b.position.x - p.position.x, b.position.z - p.position.z).toFixed(2), bAlive: b.alive };
    // Щит
    p.invulnerableUntil = 0;
    p.hp = 100;
    g.input.mouseAim = true;
    await frames(2);
    g["damagePlayer"](20);
    const blockedHp = p.hp;
    g.input.mouseAim = false;
    await frames(2);
    // Бот-мишень оживает только после проверки щита (иначе его выстрел портил замер)
    delete b.update;
    return { weapon: p.weapon, dealt, blockedHp, ...dbg };
  });
  console.log("sword test:", swordTest);
  if (swordTest.weapon !== "sword" || swordTest.dealt <= 7 || swordTest.blockedHp !== 90)
    errors.push("[desktop] sword test: меч или щит работают не так " + JSON.stringify(swordTest));
  await page.evaluate(() => window.__game.resetMatch());

  // Боевые бомбы: бросок долетает и взрывается; взрыв ранит врагов (не своих); заморозка останавливает
  const bombTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    const V = p.collider.position.constructor;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    p.collider.position.set(30, 0, -30);
    p.yaw = -2.3;
    p.pitch = 0.3;
    p.invulnerableUntil = g.now + 999;
    g.input.bomb = "boom";
    await frames(2);
    const boomLeft = g.bombs.boom;
    const thrownNow = g["thrown"].length;
    await frames(40);
    const landed = g["thrown"].length === 0;
    const enemy = g.bots.find((b) => b.clan !== p.clan);
    const ally = g.bots.find((b) => b.clan === p.clan);
    enemy.spawn(new V(20, 0, 20), 0);
    ally.spawn(new V(21, 0, 20), 0);
    g["explode"](new V(20.5, 0.2, 20), p.clan);
    const enemyHp = enemy.hp;
    const allyHp = ally.hp;
    enemy.spawn(new V(-20, 0, -20), 0);
    g["freezeAt"](new V(-20, 0.2, -20), p.clan);
    const x0 = enemy.position.x;
    const z0 = enemy.position.z;
    await frames(40);
    const moved = Math.hypot(enemy.position.x - x0, enemy.position.z - z0);
    return { boomLeft, thrownNow, landed, enemyHp, allyHp, frozen: enemy.frozenUntil > g.now, moved: +moved.toFixed(2) };
  });
  console.log("bomb test:", bombTest);
  if (bombTest.boomLeft !== 0 || bombTest.thrownNow !== 1 || !bombTest.landed || bombTest.enemyHp >= 100 || bombTest.allyHp !== 100 || !bombTest.frozen || bombTest.moved > 0.05)
    errors.push("[desktop] bomb test: боевые бомбы работают не так");
  await page.evaluate(() => window.__game.resetMatch());

  // Машина: сесть (E), проехать вперёд, выйти
  const carTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    const car = g.world.cars[0];
    const c = car.mesh.position;
    p.collider.position.set(c.x + 1.5, 0, c.z + 1.5);
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    await frames(2);
    g.input.use = true;
    await frames(2);
    const inCar = !!g.driving;
    return { inCar, x0: +c.x.toFixed(2), z0: +c.z.toFixed(2) };
  });
  await page.keyboard.down("KeyW");
  await page.evaluate(async () => {
    const g = window.__game;
    const u = g.engine.frameId + 30;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
  });
  await page.keyboard.up("KeyW");
  const carAfter = await page.evaluate(async () => {
    const g = window.__game;
    const c = g.world.cars[0].mesh.position;
    const pp = g.player.position;
    const out = { x: +c.x.toFixed(2), z: +c.z.toFixed(2), playerWithCar: Math.hypot(pp.x - c.x, pp.z - c.z) < 0.5 };
    g.input.use = true;
    const u = g.engine.frameId + 3;
    while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    return { ...out, exited: !g.driving, playerVisible: g.player.humanoid.root.isEnabled() };
  });
  console.log("car test:", carTest, carAfter);
  const drove = Math.hypot(carAfter.x - carTest.x0, carAfter.z - carTest.z0);
  if (!carTest.inCar || drove < 2 || !carAfter.playerWithCar || !carAfter.exited) errors.push("[desktop] car test: машина не едет или не пускает/не выпускает");
  await page.evaluate(() => window.__game.resetMatch());

  // Враги опаснее: бот кидает бомбу в игрока и замораживает; вплотную бьёт ножом
  const botBombTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    const V = p.collider.position.constructor;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    p.collider.position.set(30, 0, -32);
    p.hp = 100;
    p.invulnerableUntil = 0;
    g.bots.forEach((b) => b.spawn(new V(-50, 0, 60), 0));
    const b = g.bots.find((x) => x.clan !== p.clan);
    b.spawn(new V(30, 0, -18), Math.PI);
    b.bombs = { boom: 0, frost: 1 };
    g["botThrow"](b, "frost", g["playerTarget"]);
    await frames(40);
    const frozen = g["playerFrozenUntil"] > g.now;
    // Нож вплотную
    const hp0 = p.hp;
    g["botContext"]().melee(b, g["playerTarget"]);
    return { frozen, meleeHp: p.hp, hp0 };
  });
  console.log("bot bomb test:", botBombTest);
  if (!botBombTest.frozen || botBombTest.meleeHp >= botBombTest.hp0) errors.push("[desktop] bot bomb test: бомба бота или нож не работают");
  await page.evaluate(() => window.__game.resetMatch());

  // Торговец: дерево с деревьев мечом, охранник за ресурсы стережёт бункер и бьёт врага, шипы ранят
  const traderTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    const V = p.collider.position.constructor;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    p.invulnerableUntil = g.now + 999;
    g.bots.forEach((b) => b.spawn(new V(-50, 0, 60), 0));
    // Рубим дерево: каждый удар +1, после пятого оно падает (от игрока) и даёт ещё 3
    const tr = g.world.treeList.find((t) => t.fallT === 0);
    p.collider.position.set(tr.pos.x, tr.pos.y, tr.pos.z - 1.6);
    p.yaw = 0;
    p.selectWeapon(4);
    g["strike"](1);
    const wood = g.res.wood;
    for (let i = 0; i < 4; i++) g["strike"](1);
    const woodFelled = g.res.wood;
    await frames(60);
    tr.mesh.computeWorldMatrix(true);
    const wm = tr.mesh.getWorldMatrix().m;
    const top = { x: wm[4] * 5 + wm[12], y: wm[5] * 5 + wm[13], z: wm[6] * 5 + wm[14] };
    const fell = tr.fallT > 1.4 && !tr.trunk.isEnabled() && top.z > tr.pos.z + 2 && top.y < tr.pos.y + 2;
    // Торговец приходит
    g.res.wood = 60;
    g.res.leather = 15;
    g.nextTraderAt = g.now;
    await frames(2);
    const spot = g["trader"].root.position;
    p.collider.position.set(spot.x + 1, 0, spot.z);
    await frames(2);
    const near = g["nearTrader"]();
    g.input.use = true;
    await frames(2);
    const open = g["shopOpen"];
    g["buy"]("guard");
    g["buy"]("spikes");
    g["buy"]("fenceWeak");
    g["buy"]("fenceStrong");
    const inv = { ...g.inv };
    const left = { ...g.res };
    g["closeShop"]();
    // Ставим охранника руками в чистом поле
    const gx = spot.x + 1, gz = spot.z;
    p.collider.position.set(gx, 0, gz);
    p.yaw = 0;
    g.input.build = true;
    await frames(2);
    const buildingGuard = g.building;
    g.input.build = true; // шипы → охранник: по порядку инвентаря
    await frames(2);
    const placingWhat = g.building;
    g["placeBuild"]();
    const guard = g.bots.find((b) => b.guardHome && b.clan === p.clan && b.alive);
    const guardSpotOk = !!guard && Math.abs(guard.position.x - gx) < 1 && Math.abs(guard.position.z - (gz + 2)) < 1;
    // Враг подходит к охраннику
    const enemy = g.bots.find((b) => b.clan !== p.clan && !b.guardHome);
    enemy.spawn(guard.position.add(new V(1.2, 0, 0)), 0);
    enemy.update = () => {};
    const eh0 = enemy.hp;
    // Время игры идёт медленно (кадр ограничен), охраннику нужно заметить врага и подбежать
    for (let i = 0; i < 20 && enemy.hp >= eh0; i++) await frames(10);
    const guardHurt = eh0 - enemy.hp;
    // Электрозабор: ставим перед собой, враг у забора получает удар током, пули его ломают
    p.collider.position.set(-30, 0, -20);
    p.yaw = 0;
    g.setBuild("fenceStrong");
    await frames(2);
    g["placeBuild"]();
    const fence = g.fences[g.fences.length - 1];
    enemy.hp = 100;
    enemy.spawn(new V(fence.pos.x + 0.5, fence.pos.y, fence.pos.z + 0.5), 0);
    await frames(10);
    const zapped = 100 - enemy.hp;
    delete enemy.update;
    const fhp = fence.hp;
    g["hitFenceFrom"](fence.box, 3);
    const fenceDamaged = fhp - fence.hp;
    g["placeSpikes"](p.clan, new V(0, 0, 0));
    g.setBuild(null);
    return {
      wood, woodFelled, fell, near, open, inv, left, buildingGuard, placingWhat, guardSpotOk,
      guardHp: guard?.maxHp, enemyHurt: guardHurt, zapped, fenceDamaged, fences: g.fences.length,
    };
  });
  console.log("trader test:", traderTest);
  const tt = traderTest;
  if (tt.wood !== 1 || tt.woodFelled !== 8 || !tt.fell || !tt.near || !tt.open || tt.inv.guard !== 1 || tt.inv.spikes !== 1 || tt.inv.fenceWeak !== 1 || tt.inv.fenceStrong !== 1 ||
      tt.buildingGuard !== "spikes" || tt.placingWhat !== "guard" || !tt.guardSpotOk || tt.guardHp !== 200 || tt.zapped < 20 || tt.zapped >= 60 || tt.enemyHurt <= 0 || tt.fenceDamaged !== 3 || tt.fences !== 1)
    errors.push("[desktop] trader test: торговец, охранник или шипы работают не так");
  await page.evaluate(() => window.__game.resetMatch());

  // Липучка: попал — враг прилип и не сходит с места; шкура зверя падает и подбирается; снаряжение
  const stickyTest = await page.evaluate(async () => {
    const g = window.__game;
    g.resetMatch();
    g.state = "playing";
    const p = g.player;
    const V = p.collider.position.constructor;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    const ownedDefault = [...p.owned].sort().join(",");
    p.owned.add("sticky");
    p.selectWeapon(5);
    p.invulnerableUntil = g.now + 999;
    p.collider.position.set(0, 0, -25);
    p.yaw = 0;
    p.pitch = 0;
    g.setFirstPerson(true);
    g.bots.forEach((b) => b.spawn(new V(-50, 0, 60), 0));
    const b = g.bots.find((x) => x.clan !== p.clan && !x.guardHome);
    b.spawn(new V(0, 0, -15), Math.PI);
    // Пока летит шар слизи, бот стоит (иначе он иногда успевает отойти — тест «мигает»)
    b.update = () => {};
    await frames(3);
    g.input.mouseFire = true;
    await frames(4);
    g.input.mouseFire = false;
    await frames(15);
    delete b.update;
    const stuck = b.stuckUntil > g.now;
    const x0 = b.position.x;
    const z0 = b.position.z;
    await frames(30);
    const moved = Math.hypot(b.position.x - x0, b.position.z - z0);
    g.setFirstPerson(false);
    // Шкура
    const wolf = g.animals.find((a) => a.kind === "wolf");
    wolf.spawn(new V(10, 0, 10));
    wolf.takeDamage(999, null, g.now);
    await frames(3);
    const hides = g["hides"].length;
    const l0 = g.res.leather;
    p.collider.position.set(10, 0, 10);
    await frames(3);
    return { weapon: p.weapon, stuck, moved: +moved.toFixed(2), hides, leatherGained: g.res.leather - l0, ownedDefault };
  });
  console.log("sticky/hide test:", stickyTest);
  if (!stickyTest.stuck || stickyTest.moved > 0.05 || stickyTest.hides < 1 || stickyTest.leatherGained < 1)
    errors.push("[desktop] sticky/hide test: липучка или шкура работают не так");
  await page.evaluate(() => window.__game.resetMatch());

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

// ---------- Уровень 2: большая карта ----------
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  watch(page, "level2");
  await page.goto(URL + "?test&level=2", { waitUntil: "load" });
  await page.click("#play");
  await page.waitForFunction(() => !!window.__game, null, { timeout: 180000 });
  const l2 = await page.evaluate(async () => {
    const g = window.__game;
    const V = g.player.collider.position.constructor;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    g.player.invulnerableUntil = g.now + 999;
    // На вершину горы
    g.player.collider.position.set(58, 20, -58);
    await frames(6);
    const topY = +g.player.position.y.toFixed(1);
    // Бот на склоне стоит на земле, а не в воздухе/под землёй
    const b = g.bots.find((x) => x.clan !== g.player.clan);
    b.spawn(new V(58, 0, -40), 0);
    await frames(4);
    const slopeY = +b.position.y.toFixed(1);
    const groundY = +g.world.heightAt(b.position.x, b.position.z).toFixed(1);
    const droneShot = g.drones[0].takeDamage(999);
    return { level: g.world.level, topY, slopeY, groundY, drones: g.drones.length, droneShot, trees: g.world.treeSpots.length };
  });
  console.log("level 2:", l2);
  if (l2.level !== 2 || l2.topY < 10 || Math.abs(l2.slopeY - l2.groundY) > 0.3 || l2.drones < 2 || !l2.droneShot)
    errors.push("[level2] большая карта, гора или дроны работают не так");
  await page.screenshot({ path: path.join(shots, "09-level2-mountain-top.png") });
  await ctx.close();
}

// ---------- Уровень 3: соло на заводе ----------
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  watch(page, "level3");
  await page.goto(URL + "?test&level=3", { waitUntil: "load" });
  await page.click("#play");
  await page.waitForFunction(() => !!window.__game, null, { timeout: 180000 });
  const l3 = await page.evaluate(async () => {
    const g = window.__game;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    const allies = g.bots.filter((b) => b.clan === g.player.clan).length;
    const enemies = g.bots.filter((b) => b.clan !== g.player.clan).length;
    // Аптечка: подобрали — после времени появляется в другом месте
    const m = g["medkits"][0];
    const before = m.pos.clone();
    g.player.hp = 50;
    g.player.collider.position.set(m.pos.x, 0, m.pos.z);
    await frames(3);
    m.respawnAt = g.now;
    g.player.collider.position.set(0, 0, 40);
    await frames(3);
    const moved = Math.hypot(m.pos.x - before.x, m.pos.z - before.z);
    // Все враги выбыли — победа
    let result = null;
    const orig = g.onGameOver;
    g.onGameOver = (r) => (result = r);
    for (const b of g.bots) if (b.clan !== g.player.clan) {
      b.lives = 1;
      b.takeDamage(999, g.player.position, g.now);
    }
    await frames(3);
    g.onGameOver = orig;
    return { level: g.world.level, allies, enemies, medkitMoved: +moved.toFixed(1), won: result?.won, reason: result?.reason };
  });
  console.log("level 3:", l3);
  if (l3.level !== 3 || l3.allies !== 0 || l3.enemies !== 4 || l3.medkitMoved < 1 || !l3.won) errors.push("[level3] соло-уровень работает не так");
  await ctx.close();
}

// ---------- Уровень 4: снег, каждый сам за себя ----------
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  watch(page, "level4");
  await page.goto(URL + "?test&level=4", { waitUntil: "load" });
  await page.click("#play");
  await page.waitForFunction(() => !!window.__game, null, { timeout: 180000 });
  const l4 = await page.evaluate(async () => {
    const g = window.__game;
    const p = g.player;
    const V = p.collider.position.constructor;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    const kit = [...p.owned].sort().join(",");
    const bombs = g.bombs.weak + g.bombs.boom + g.bombs.frost;
    const bots = g.bots.length;
    // Боты воюют и между собой: у бота среди врагов есть другие боты
    const foes = g["foesOf"](g.bots[0]).filter((t) => t.bot).length;
    g.input.scopeToggle = true;
    await frames(2);
    const scoped = g.scoped;
    // Сугроб: стоим в центре — проваливаемся и замерзаем, минус жизнь
    const d = g.world.drifts[0];
    g.bots.forEach((b) => b.spawn(new V(-45, 0, 45), 0));
    p.invulnerableUntil = 0;
    const lives0 = p.lives;
    p.collider.position.set(d.x, 0, d.z);
    for (let k = 0; k < 200 && p.lives === lives0; k++) {
      p.collider.position.set(d.x, 0, d.z);
      await frames(1);
    }
    const livesAfter = p.lives;
    // Все соперники выбыли — победа
    g.state = "playing";
    p.alive = true;
    let result = null;
    const orig = g.onGameOver;
    g.onGameOver = (r) => (result = r);
    // Всех соперников — сразу в выбывшие (часть могла уже лежать и ждать возрождения)
    for (const b of g.bots) {
      b.lives = 0;
      b.hp = 0;
      b.state = "dead";
    }
    await frames(3);
    g.onGameOver = orig;
    return { level: g.world.level, kit, bombs, bots, foes, scoped, drifts: g.world.drifts.length, lives0, livesAfter, won: result?.won };
  });
  console.log("level 4:", l4);
  if (l4.level !== 4 || l4.kit !== "clanWeapon,slingshot" || l4.bombs !== 0 || l4.bots !== 3 || l4.foes !== 2 || l4.scoped || l4.livesAfter !== l4.lives0 - 1 || !l4.won)
    errors.push("[level4] снежный уровень работает не так");
  await page.screenshot({ path: path.join(shots, "10-level4-snow.png") });
  await ctx.close();
}

// ---------- Уровень 5: гонки ----------
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  watch(page, "level5");
  await page.goto(URL + "?test&level=5", { waitUntil: "load" });
  await page.click("#play");
  await page.waitForFunction(() => !!window.__game, null, { timeout: 180000 });
  const l5 = await page.evaluate(async () => {
    const g = window.__game;
    const p = g.player;
    const race = g.race;
    const frames = async (n) => {
      const u = g.engine.frameId + n;
      while (g.engine.frameId < u) await new Promise((r) => setTimeout(r, 20));
    };
    const driving0 = !!g.driving;
    const locked = !race.started;
    // Старт: боты поехали
    race.startAt = g.now;
    const prog0 = race.racers.slice(1).map((r) => race.progress(r));
    await frames(60);
    const moved = race.racers.slice(1).every((r, i) => race.progress(r) > prog0[i]);
    // Выстрел по сопернику: машина ломается после урона
    const rival = race.racers[1];
    const hp0 = rival.hp;
    race.damage(rival, 30);
    const hurt = hp0 - rival.hp;
    race.damage(rival, 999);
    const wrecked = !rival.mesh.isEnabled() && rival.lives === 2;
    // Машину игрока разбили — возвращается за руль у контрольной точки
    p.invulnerableUntil = 0;
    g["damagePlayer"](999);
    const deadState = g.state;
    for (let i = 0; i < 60 && g.state !== "playing"; i++) await frames(5);
    const backInCar = g.state === "playing" && !!g.driving && p.lives === 2;
    // Круги: проезжаем все контрольные точки 10 раз — победа
    let result = null;
    const orig = g.onGameOver;
    g.onGameOver = (r) => (result = r);
    for (const r of race.racers.slice(1)) r.skill = 0; // соперники стоят
    const t = g.world.track;
    for (let lap = 0; lap < 10 && !result; lap++) {
      for (let k = 1; k <= t.cps.length && !result; k++) {
        const pt = t.pts[t.cps[k % t.cps.length]];
        g.driving.mesh.position.set(pt.x, 0, pt.z);
        p.collider.position.set(pt.x, 0.05, pt.z);
        await frames(1);
      }
    }
    g.onGameOver = orig;
    return { level: g.world.level, driving0, locked, moved, hurt, wrecked, deadState, backInCar, laps: race.player.lap, won: result?.won, reason: result?.reason, bots: g.bots.length };
  });
  console.log("level 5:", l5);
  if (l5.level !== 5 || !l5.driving0 || !l5.locked || !l5.moved || l5.hurt !== 30 || !l5.wrecked || l5.deadState !== "dead" || !l5.backInCar || l5.laps !== 10 || !l5.won || l5.bots !== 0)
    errors.push("[level5] гонки работают не так");
  await page.screenshot({ path: path.join(shots, "11-level5-race.png") });
  await ctx.close();
}

await browser.close();
console.log("\nconsole/page errors:", errors.length ? errors : "none");
process.exit(errors.length ? 1 : 0);
