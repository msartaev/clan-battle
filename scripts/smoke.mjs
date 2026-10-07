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
    await new Promise((r) => setTimeout(r, 8000));
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
    delete b.update;
    // Щит
    p.invulnerableUntil = 0;
    p.hp = 100;
    g.input.mouseAim = true;
    await frames(2);
    g["damagePlayer"](20);
    const blockedHp = p.hp;
    g.input.mouseAim = false;
    await frames(2);
    return { weapon: p.weapon, dealt, blockedHp };
  });
  console.log("sword test:", swordTest);
  if (swordTest.weapon !== "sword" || swordTest.dealt <= 7 || swordTest.blockedHp !== 90) errors.push("[desktop] sword test: меч или щит работают не так");
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
    // Рубим дерево
    const tr = g.world.treeSpots[0];
    p.collider.position.set(tr.x, 0, tr.z - 1.6);
    p.yaw = 0;
    p.selectWeapon(4);
    g["strike"](1);
    const wood = g.res.wood;
    // Торговец приходит
    g.res.wood = 20;
    g.res.leather = 5;
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
    const guard = g.bots.find((b) => b.guardHome && b.clan === p.clan && b.alive);
    // Враг подходит к охраннику
    const enemy = g.bots.find((b) => b.clan !== p.clan && !b.guardHome);
    enemy.spawn(guard.position.add(new V(1.2, 0, 0)), 0);
    enemy.update = () => {};
    const eh0 = enemy.hp;
    await frames(40);
    delete enemy.update;
    g["closeShop"]();
    return { wood, near, open, guard: !!guard, guardHp: guard?.maxHp, spikes: g["spikes"].length, enemyHurt: eh0 - enemy.hp, left: { ...g.res } };
  });
  console.log("trader test:", traderTest);
  if (traderTest.wood !== 1 || !traderTest.near || !traderTest.open || !traderTest.guard || traderTest.guardHp !== 200 || traderTest.spikes !== 1 || traderTest.enemyHurt <= 0)
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
    await frames(3);
    g.input.mouseFire = true;
    await frames(4);
    g.input.mouseFire = false;
    await frames(15);
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

await browser.close();
console.log("\nconsole/page errors:", errors.length ? errors : "none");
process.exit(errors.length ? 1 : 0);
