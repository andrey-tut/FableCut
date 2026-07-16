#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   FableCut render.js — HEADLESS рендер project.json → MP4 (БЕЗ браузера).

   Обходить браузерний експорт FableCut (який висне на важких відео).
   ffmpeg тут мінімальний (без libass/drawtext) → текст малюємо через Python PIL
   (кадри-накладки), редакцію PII — через drawbox, композит/склейку — ffmpeg.

   Screencast-проєкт: екран(V1 contain) + вебка-PiP(V2) + голос(A1) + прискорення
   (props.speed) + посинхронні субтитри (props.words, активне слово золоте)
   + редакція-регіон(V4) + інтро-плашка + опційна тиха фонова музика.

   Usage:
     node render.js --out ~/Movies/laura_recut.mp4
     node render.js --segments 2 --out /tmp/test.mp4        # швидкий тест
     node render.js --music track.mp3 --music-vol 0.06
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const PROJECT = path.join(ROOT, "project.json");
const FONT = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"]
  .find((f) => fs.existsSync(f));

function args(av) {
  const a = { out: path.join(ROOT, "exports", "recut.mp4"), segments: 0, music: "",
    musicVol: 0.04, introDur: 2.4, keepTemp: false, clicks: "", zoomF: 1.28 };
  for (let i = 0; i < av.length; i++) { const x = av[i];
    if (x === "--out") a.out = av[++i]; else if (x === "--segments") a.segments = parseInt(av[++i], 10);
    else if (x === "--music") a.music = av[++i]; else if (x === "--music-vol") a.musicVol = parseFloat(av[++i]);
    else if (x === "--intro-dur") a.introDur = parseFloat(av[++i]); else if (x === "--keep-temp") a.keepTemp = true;
    else if (x === "--clicks") a.clicks = av[++i]; else if (x === "--zoom-factor") a.zoomF = parseFloat(av[++i]); }
  return a;
}
const ff = (aa, timeout = 3600000) => {
  const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...aa], { encoding: "utf8", timeout });
  if (r.status !== 0) throw new Error("ffmpeg:\n" + (r.stderr || "").split("\n").slice(-8).join("\n"));
};
const resolveSrc = (src) => path.join(ROOT, src.replace(/^\//, ""));

function main() {
  const a = args(process.argv.slice(2));
  if (!FONT) throw new Error("нема системного шрифту (Arial) для субтитрів");
  const doc = JSON.parse(fs.readFileSync(PROJECT, "utf8"));
  const W = doc.width, H = doc.height, FPS = 30;
  const byId = Object.fromEntries(doc.media.map((m) => [m.id, m]));
  const V1 = doc.clips.filter((c) => c.track === "V1" && c.kind === "video").sort((x, y) => x.start - y.start);
  const camBy = {}, voiceBy = {};
  for (const c of doc.clips) {
    if (c.track === "V2" && c.kind === "video") camBy[c.start.toFixed(3)] = c;
    if (c.track === "A1") voiceBy[c.start.toFixed(3)] = c;
  }
  let runs = V1; if (a.segments > 0) runs = runs.slice(0, a.segments);
  if (!runs.length) throw new Error("нема V1-кліпів");
  const lastEnd = runs[runs.length - 1].start + runs[runs.length - 1].duration;
  const caps = doc.clips.filter((c) => c.name === "cap" && Array.isArray(c.props.words) && c.props.words.length
    && c.start < lastEnd + 0.5);
  const blurs = doc.clips.filter((c) => c.name === "blur" && c.start < lastEnd + 0.5);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fcrender_"));
  const screen = resolveSrc(byId["m_screen"].src), webcam = resolveSrc(byId["m_webcam"].src), mic = resolveSrc(byId["m_mic"].src);
  const pipW = Math.round(W * 0.22), pipH = Math.round(H * 0.22);

  // авто-зум по кліках Screen Studio (mouseclicks-0.json): punch-in до точки кліку
  let CLICKS = [];
  if (a.clicks && fs.existsSync(a.clicks)) {
    try { CLICKS = JSON.parse(fs.readFileSync(a.clicks, "utf8")).filter((e) => e.type === "mouseDown"); } catch {}
  }
  const spaceW = CLICKS.length ? Math.max(...CLICKS.map((c) => c.x)) : 1710;
  const spaceH = CLICKS.length ? Math.max(...CLICKS.map((c) => c.y)) : 1067;
  const sw0 = byId["m_screen"].width, sh0 = byId["m_screen"].height;
  const cs = Math.min(W / sw0, H / sh0), dispW = sw0 * cs, dispH = sh0 * cs, offX = (W - dispW) / 2, offY = (H - dispH) / 2;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  function zoomFor(sc) {
    if (!CLICKS.length || sc.duration < 1.0) return null;
    // НЕ зумимо сегменти з PII — фіксований блюр-бокс не має «розʼїхатись» від зуму
    const st = sc.start, en = sc.start + sc.duration;
    if (blurs.some((b) => st < b.start + b.duration && en > b.start)) return null;
    const t0 = sc.in, t1 = sc.in + sc.duration * (sc.props.speed || 1);
    const hit = CLICKS.filter((c) => c.processTimeMs / 1000 >= t0 && c.processTimeMs / 1000 <= t1);
    if (!hit.length) return null;
    const c = hit[hit.length - 1];
    const cx = offX + (c.x / spaceW) * dispW, cy = offY + (c.y / spaceH) * dispH;
    const Wc = even(W / a.zoomF), Hc = even(H / a.zoomF);
    return { Wc, Hc,
      x: Math.round(Math.min(Math.max(cx - Wc / 2, 0), W - Wc)),
      y: Math.round(Math.min(Math.max(cy - Hc / 2, 0), H - Hc)) };
  }
  console.log(`рендер ${runs.length} сегментів → ${a.out}${CLICKS.length ? " (авто-зум: " + CLICKS.length + " кліків)" : ""}`);

  // 1. посегментний композит (екран contain + вебка PiP + голос, з прискоренням)
  const segFiles = [];
  let bodyDur = 0;
  for (let i = 0; i < runs.length; i++) {
    const sc = runs[i], cc = camBy[sc.start.toFixed(3)], vc = voiceBy[sc.start.toFixed(3)];
    const sp = sc.props.speed || 1, win = (sc.duration * sp).toFixed(3);
    const px = Math.round(W / 2 + (cc ? cc.props.x : 0) - pipW / 2), py = Math.round(H / 2 + (cc ? cc.props.y : 0) - pipH / 2);
    const seg = path.join(tmp, `seg_${String(i).padStart(4, "0")}.mp4`);
    const zc = zoomFor(sc);
    const zoomChain = zc ? `;[bg]crop=${zc.Wc}:${zc.Hc}:${zc.x}:${zc.y},scale=${W}:${H},setsar=1[bgz]` : "";
    const bgLabel = zc ? "bgz" : "bg";
    const fc =
      `[0:v]setpts=PTS/${sp},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1[bg]${zoomChain};` +
      `[1:v]setpts=PTS/${sp},scale=${pipW}:${pipH}:force_original_aspect_ratio=increase,crop=${pipW}:${pipH}[pip];` +
      `[${bgLabel}][pip]overlay=${px}:${py}[v];[2:a]atempo=${sp}[a]`;
    ff(["-ss", String(sc.in), "-t", win, "-i", screen, "-ss", String(cc ? cc.in : sc.in), "-t", win, "-i", webcam,
      "-ss", String(vc ? vc.in : sc.in), "-t", win, "-i", mic, "-filter_complex", fc,
      "-map", "[v]", "-map", "[a]", "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", seg]);
    segFiles.push(seg); bodyDur += sc.duration;
    if ((i + 1) % 10 === 0 || i === runs.length - 1) console.log(`  сегменти ${i + 1}/${runs.length}`);
  }

  // 2. графіка (cold-open + дисклеймер) через PIL
  const CODUR = 7.0, leadDur = CODUR + a.introDur;
  const gfxDir = path.join(tmp, "gfx");
  const gfxSpec = { W, H, fps: FPS, font: FONT, gfxDir,
    coldopen: { dur: CODUR, lines: ["3 ФІРМИ", "1 АДРЕСА", "1 ТЕЛЕФОН"],
      sub: "Бізнес, який радять усі українці в Данії" },
    disclaimer: { text: "Публічні дані CVR / Virk + соцмережі.\nОцінка — особиста думка. Чутливе заблюровано." } };
  fs.writeFileSync(path.join(tmp, "gfx.json"), JSON.stringify(gfxSpec));
  console.log("  малюю графіку (cold-open + дисклеймер)…");
  const pg = spawnSync("python3", [path.join(ROOT, "_gfx.py"), path.join(tmp, "gfx.json")], { encoding: "utf8", timeout: 600000 });
  if (pg.status !== 0) throw new Error("PIL gfx:\n" + (pg.stderr || pg.stdout || "").split("\n").slice(-6).join("\n"));

  // 3. субтитри через PIL (зсув на leadDur = cold-open + інтро)
  const framesDir = path.join(tmp, "caps"), introPng = path.join(tmp, "intro.png");
  const bandH = Math.round(H * 0.26), capY = Math.round(H * 0.60);
  const totalDur = leadDur + bodyDur;
  const spec = { W, H, fps: FPS, introDur: leadDur, totalDur, bandH,
    font: FONT, fontSize: Math.round(H * 0.05), framesDir, introPng, introText: doc.name || "",
    captions: caps.map((c) => ({ start: c.start, dur: c.duration, uppercase: !!c.props.uppercase, words: c.props.words })) };
  fs.writeFileSync(path.join(tmp, "spec.json"), JSON.stringify(spec));
  console.log("  малюю субтитри (PIL)…");
  const py = spawnSync("python3", [path.join(ROOT, "_caps.py"), path.join(tmp, "spec.json")], { encoding: "utf8", timeout: 1800000 });
  if (py.status !== 0) throw new Error("PIL:\n" + (py.stderr || py.stdout || "").split("\n").slice(-6).join("\n"));

  // 4. cold-open відео + інтро-плашка + concat із сегментами
  const coMp4 = path.join(tmp, "coldopen.mp4");
  ff(["-framerate", String(FPS), "-i", path.join(gfxDir, "coldopen", "%06d.png"),
    "-f", "lavfi", "-t", String(CODUR), "-i", "anullsrc=r=48000:cl=stereo",
    "-map", "0:v", "-map", "1:a", "-t", String(CODUR), "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast",
    "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", coMp4]);
  const introMp4 = path.join(tmp, "intro.mp4");
  ff(["-loop", "1", "-t", String(a.introDur), "-i", introPng,
    "-f", "lavfi", "-t", String(a.introDur), "-i", "anullsrc=r=48000:cl=stereo",
    "-map", "0:v", "-map", "1:a", "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", introMp4]);
  const listFile = path.join(tmp, "list.txt");
  fs.writeFileSync(listFile, [coMp4, introMp4, ...segFiles].map((p) => `file '${p}'`).join("\n"));
  const pre = path.join(tmp, "pre.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", pre]);

  // 5. фінал: субтитри + редакція(drawbox) + дисклеймер + опц. музика
  let vf = `[0:v][1:v]overlay=0:${capY}:eof_action=pass[vc]`;
  let vlab = "vc";
  if (blurs.length) {
    const b0 = blurs[0], m = byId[b0.mediaId] || {};
    const bw = m.width || 320, bh = m.height || 140;
    const bx = Math.round(W / 2 + b0.props.x - bw / 2), by = Math.round(H / 2 + b0.props.y - bh / 2);
    const en = blurs.map((b) => `between(t,${(leadDur + b.start).toFixed(2)},${(leadDur + b.start + b.duration).toFixed(2)})`).join("+");
    vf += `;[${vlab}]drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=0x0d1117@1:t=fill:enable='${en}'[vb]`;
    vlab = "vb";
  }
  // дисклеймер: зациклений PNG, АЛЕ обмежений часом (інакше нескінченний вхід роздуває вихід!)
  const inputs = ["-i", pre, "-framerate", String(FPS), "-i", path.join(framesDir, "%06d.png"),
    "-loop", "1", "-t", (totalDur + 5).toFixed(1), "-i", path.join(gfxDir, "disclaimer.png")];
  vf += `;[${vlab}][2:v]overlay=0:0:enable='between(t,${leadDur.toFixed(2)},${(leadDur + 6).toFixed(2)})'[vd]`;
  vlab = "vd";
  let amap = "0:a";
  if (a.music && fs.existsSync(a.music)) {
    inputs.push("-stream_loop", "-1", "-i", a.music);
    // голос лишається на повній гучності (normalize=0!), музика ледь чутна
    vf += `;[0:a]volume=1.3[vv];[3:a]volume=${a.musicVol}[mv];[vv][mv]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[am]`;
    amap = "[am]";
  }
  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  ff([...inputs, "-filter_complex", vf, "-map", `[${vlab}]`, "-map", amap,
    "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-t", (totalDur + 5).toFixed(1), "-movflags", "+faststart", a.out]);

  if (!a.keepTemp) fs.rmSync(tmp, { recursive: true, force: true });
  const sz = (fs.statSync(a.out).size / 1048576).toFixed(1);
  console.log(`\n✓ ГОТОВО: ${a.out} (${sz} MB, ${(totalDur / 60).toFixed(1)} хв)`);
}

try { main(); } catch (e) { console.error("✗ " + e.message); process.exit(1); }
