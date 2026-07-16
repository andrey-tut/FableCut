#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   FableCut screencast.js — Screen Studio-style композитор (zero-dep, Node 18+).

   Синхронні канали ОДНОГО запису (екран + вебка + мікрофон) →
   перекроєний по сценарію, прискорений, з блюром PII монтаж (project.json):
     1. транскрибує мікрофон (whisper-1, кеш)
     2. LLM робить ТІСНИЙ пересценарій (гачок→…→CTA), лишає момент Stripe для блюру
     3. jump-cut пауз/філерів; синхронно кладе екран(V1) + вебку-PiP(V2) + голос(A1)
     4. прискорює все на --speed (деф. 1.06×); субтитри(V3); блюр-бокс над PII(V4)
        — регіон PII визначає vision (gpt-4o) по кадру з моменту оплати

   Usage:
     node screencast.js --dir /Users/mac/Movies/laura --lang uk --speed 1.06 --target-min 5 --dry-run
     node screencast.js --dir /Users/mac/Movies/laura            # повний збір
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const P = require("./plan.js");
const { speechRuns } = require("./assemble.js");

const ROOT = __dirname, MEDIA = path.join(ROOT, "media"), CACHE = path.join(ROOT, ".cache");
const PROJECT = path.join(ROOT, "project.json");

function args(argv) {
  const a = { dir: "", screen: "", webcam: "", mic: "", lang: "uk", speed: 1.06,
    format: "horizontal", targetMin: 5, gap: 0.5, cam: "br", dryRun: false, fresh: false, noBlur: false, keep: "" };
  for (let i = 0; i < argv.length; i++) { const x = argv[i];
    if (x === "--dir") a.dir = argv[++i]; else if (x === "--screen") a.screen = argv[++i];
    else if (x === "--webcam") a.webcam = argv[++i]; else if (x === "--mic") a.mic = argv[++i];
    else if (x === "--lang") a.lang = argv[++i]; else if (x === "--speed") a.speed = parseFloat(argv[++i]);
    else if (x === "--format") a.format = argv[++i]; else if (x === "--target-min") a.targetMin = parseFloat(argv[++i]);
    else if (x === "--gap") a.gap = parseFloat(argv[++i]); else if (x === "--cam") a.cam = argv[++i];
    else if (x === "--dry-run") a.dryRun = true; else if (x === "--fresh") a.fresh = true;
    else if (x === "--no-blur") a.noBlur = true; else if (x === "--keep") a.keep = argv[++i]; }
  return a;
}

const findOne = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => re.test(f)) : null);
function autoFind(a) {
  if (a.dir) {
    a.screen = a.screen || path.join(a.dir, findOne(a.dir, /channel-2-display.*\.mp4$/) || "");
    a.webcam = a.webcam || path.join(a.dir, findOne(a.dir, /channel-4-webcam.*\.mp4$/) || "");
    a.mic = a.mic || path.join(a.dir, findOne(a.dir, /channel-3-microphone.*\.m4a$/) || "");
  }
  for (const k of ["screen", "webcam", "mic"]) if (!a[k] || !fs.existsSync(a[k])) P.die(`не знайдено ${k} (${a[k] || "?"})`);
}

function transcribeCached(mic, lang, fresh) {
  const cf = path.join(CACHE, path.basename(mic) + ".words.json");
  if (!fresh && fs.existsSync(cf)) { P.log("транскрипт з кешу"); return JSON.parse(fs.readFileSync(cf, "utf8")); }
  P.log("транскрибую мікрофон…");
  const audio = P.extractAudio(mic);
  return P.transcribe(audio, lang).then((r) => { fs.rmSync(audio, { force: true });
    fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(r)); return r; });
}

function recutPrompt(transcript, targetMin) {
  return `Ти монтажер-сценарист коротких відео. Нижче транскрипт ~23-хв відео-огляду (суржик: укр+рос) — автор аналізує бізнес людини (Лаура). Зроби ТІСНИЙ, цікавий ПЕРЕСЦЕНАРІЙ (recut по тексту):
- залиш найсильніші, найдотепніші, найінформативніші моменти; прибери повтори, воду, довгі роздуми, відступи;
- логічна структура: сильний гачок → хто така Лаура → аналіз (Facebook / Instagram / Google / фінанси-CVR) → висновок → CTA («як вам формат»);
- ОБОВʼЯЗКОВО залиш момент, де він показує оплату Stripe і каже що там його особисті дані (~305-325с) — і познач його в "sensitive" (там блюримо);
- ціль ~${targetMin} хв.
Поверни ЛИШЕ JSON:
{"title":"…","hook":"…","target_min":${targetMin},
 "outline":[{"section":"…","summary":"…"}],
 "segments":[{"start":сек,"end":сек,"section":"…","topic":"…"}],
 "sensitive":[{"start":сек,"end":сек,"what":"що приховати"}]}
Правила segments: у ФІНАЛЬНОМУ порядку монтажу; межі на реченнях; кожен 6–45с; лише реальні таймкоди з транскрипту.

ТРАНСКРИПТ:
${transcript}`;
}

/* vision: кадр із моменту оплати → bbox PII (частки 0-1 від кадру екрана) */
function grabFrame(screen, t) {
  const out = path.join(CACHE, "pii_frame.jpg");
  spawnSync("ffmpeg", ["-y", "-ss", String(t), "-i", screen, "-frames:v", "1", "-q:v", "3", out], { encoding: "utf8" });
  return fs.existsSync(out) ? out : null;
}
async function visionRegion(framePath) {
  const key = process.env.OPENAI_API_KEY;
  const b64 = fs.readFileSync(framePath).toString("base64");
  const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o", temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "text", text: "Це кадр екрана з платіжною сторінкою Stripe. Поверни JSON {found:true/false, x,y,w,h} — bounding box (ЧАСТКИ 0..1 від усього кадру) області, де видно ОСОБИСТІ/чутливі дані (імʼя, email, адреса, номер картки, телефон, місто). Візьми ЩЕДРУ рамку, щоб точно все накрити. Якщо нема — found:false." },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } }] }] }) });
  if (!res.ok) return null;
  try { const j = JSON.parse((await res.json()).choices[0].message.content);
    return j.found ? j : null; } catch { return null; }
}

/* contain-мапінг: точка/розмір у сирому кадрі екрана → канва (px від центру) */
function containMap(canvasW, canvasH, srcW, srcH) {
  const s = Math.min(canvasW / srcW, canvasH / srcH);
  const dispW = srcW * s, dispH = srcH * s;
  const offX = (canvasW - dispW) / 2, offY = (canvasH - dispH) / 2;
  return { s, offX, offY };
}

function writeRedactSVG(w, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="#0b0f16"/>
  <rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="none" stroke="#3a4152" stroke-width="3"/>
  <text x="${w / 2}" y="${h / 2}" fill="#8892a6" font-family="Arial" font-size="${Math.min(h * 0.4, 34)}" font-weight="700" text-anchor="middle" dominant-baseline="middle">🔒 приховано</text>
</svg>`;
  fs.mkdirSync(MEDIA, { recursive: true });
  fs.writeFileSync(path.join(MEDIA, "redact.svg"), svg);
  return "/media/redact.svg";
}

/* EDL: keep-id речень → плоскі ЧИСТІ фрагменти (філери вирізані, тільки мертві паузи).
   gap=0.9с — консервативно, щоб НЕ рубати природний ритм думки. Хронологічно. */
function keepRuns(keepIds, sentences, words, gap, blocks) {
  const sectionOf = {};
  for (const b of (blocks || [])) for (const id of (b.ids || [])) if (sectionOf[id] == null) sectionOf[id] = b.screen || b.topic || "";
  const runs = [];
  for (const id of [...keepIds].sort((x, y) => x - y)) {
    const s = sentences[id]; if (!s) continue;
    const w = words.slice(s.i0, s.i1 + 1).filter((x) => !P.isFiller(x.text));
    if (!w.length) continue;
    let cur = [w[0]];
    const flush = () => {
      if (cur.length && cur[cur.length - 1].end - cur[0].start >= 0.2)
        runs.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur.slice(), section: sectionOf[id] || "" });
    };
    for (let k = 1; k < w.length; k++) {
      if (w[k].start - cur[cur.length - 1].end > gap) { flush(); cur = []; }
      cur.push(w[k]);
    }
    flush();
  }
  return runs;
}

/* лінк (не копія — файли важкі) у media/ */
function linkMedia(src) {
  fs.mkdirSync(MEDIA, { recursive: true });
  const base = path.basename(src), dest = path.join(MEDIA, base);
  if (!fs.existsSync(dest)) { try { fs.symlinkSync(src, dest); } catch { fs.copyFileSync(src, dest); } }
  return "/media/" + base;
}

/* Субтитри → ЧИСТА УКРАЇНСЬКА: whisper дає суржик з рос. літерами; нормалізуємо всі
   репліки одним батч-викликом, зберігаючи таймінг (рівний розподіл слів по спану run). */
async function correctRunsToUk(runs, provider) {
  const texts = runs.map((r, i) => `[${i}] ${r.words.map((w) => w.text.trim()).join(" ")}`).join("\n");
  const prompt = `Нижче ${runs.length} коротких реплік із відео (суржик укр+рос, з whisper-помилками розпізнавання). Перепиши КОЖНУ ЧИСТОЮ УКРАЇНСЬКОЮ мовою — українськими словами й літерами. Виправ помилки розпізнавання: напр. "цикошапцы"→"логотипчик у шапці", "административная"→"адміністративна", "что"→"що", "Всем привет"→"Всім привіт", "бачим"→"бачимо", "дизнаться"→"дізнатися". Збережи СЕНС і приблизну кількість слів (це субтитри до мовлення). НЕ додавай зайвого, не скорочуй.
Формат входу: [i] текст. Поверни ЛИШЕ JSON: {"uk":[[i,"чиста українська"], … для ВСІХ i від 0 до ${runs.length - 1}]}.

РЕПЛІКИ:
${texts}`;
  try {
    const r = await P.llmJSON(prompt, provider);
    const byI = {};
    for (const pr of (r.uk || [])) if (Array.isArray(pr)) byI[pr[0]] = String(pr[1] || "");
    runs.forEach((run, i) => { run.uk = (byI[i] && byI[i].trim()) || run.words.map((w) => w.text.trim()).join(" "); });
  } catch (e) { P.log("нормалізація UA не вдалась, лишаю оригінал: " + (e.message || e)); }
}
function ukWordsFor(run) {
  const ws = String(run.uk || "").split(/\s+/).filter(Boolean);
  if (!ws.length) return run.words;
  const S = run.start, span = Math.max(0.15, run.end - run.start);
  const lens = ws.map((w) => w.length + 1), tot = lens.reduce((a, b) => a + b, 0);
  let t = S; const out = [];
  for (let i = 0; i < ws.length; i++) { const d = span * lens[i] / tot; out.push({ text: ws[i], start: t, end: t + d }); t += d; }
  return out;
}

function buildScreencast(m, script, a, region) {
  const preset = P.PRESETS[a.format];
  const W = preset.w, H = preset.h, sp = a.speed;
  // PiP вебка — низ-право
  const pipScale = 0.22, pipMx = 40;
  const pipW = W * pipScale, pipH = H * pipScale;
  const pipX = W / 2 - pipW / 2 - pipMx, pipY = H / 2 - pipH / 2 - pipMx;
  const map = containMap(W, H, m.screen.width, m.screen.height);

  const clips = [], markers = [], redactClips = [];
  let T = 0, prevSection = null;

  // Плоский список ЧИСТИХ фрагментів. EDL-режим (script._runs) — вже цілі думки без
  // філерів (keepRuns). Інакше — старий recut через speechRuns по сегментах.
  let allRuns = [];
  if (script._runs && script._runs.length) {
    allRuns = script._runs;
  } else {
    for (const seg of script.segments) {
      const s = Math.max(0, +seg.start), e = Math.min(m.screen.duration, +seg.end);
      if (!(e > s)) continue;
      const segWords = m.words.filter((w) => w.start >= s - 0.2 && w.end <= e + 0.2);
      for (const run of speechRuns(segWords, a.gap, false))
        allRuns.push({ start: run.start, end: run.end, words: run.words, section: seg.section, topic: seg.topic });
    }
  }

  for (const run of allRuns) {
    const Lsrc = run.end - run.start, D = Lsrc / sp;
    if (!(D > 0)) continue;
    const segT = T, newSection = run.section && run.section !== prevSection;
    const base = { start: +T.toFixed(3), in: +run.start.toFixed(3), duration: +D.toFixed(3) };
    // екран V1
    clips.push({ id: P.uid("c_"), mediaId: m.screen.id, kind: "video", track: "V1", ...base,
      name: "screen", props: { fit: "contain", speed: sp, volume: 0 },
      ...(newSection && segT > 0 ? { transitionIn: { type: "fade", duration: 0.25 } } : {}) });
    // вебка PiP V2
    clips.push({ id: P.uid("c_"), mediaId: m.webcam.id, kind: "video", track: "V2", ...base,
      name: "cam", props: { fit: "cover", speed: sp, volume: 0, scale: pipScale, x: Math.round(pipX), y: Math.round(pipY), cornerRadius: 22 } });
    // голос A1
    clips.push({ id: P.uid("c_"), mediaId: m.mic.id, kind: "audio", track: "A1", ...base,
      name: "voice", props: { speed: sp, volume: 1 } });
    // субтитри V3 — ЧИСТА УКРАЇНСЬКА (run.uk), час масштабуємо на /sp
    const capWords = run.uk ? ukWordsFor(run) : run.words;
    for (const line of P.chunkWords(capWords)) {
      const ls = line[0].start, le = line[line.length - 1].end;
      const spans = line.map((w) => ({ w: w.text.trim(),
        s: +Math.max(0, (w.start - ls) / sp).toFixed(3), e: +((w.end - ls) / sp).toFixed(3) }));
      clips.push({ id: P.uid("c_"), mediaId: null, kind: "text", track: "V3",
        start: +(T + (ls - run.start) / sp).toFixed(3), in: 0,
        duration: +Math.max(0.4, (le - ls) / sp).toFixed(3), name: "cap",
        props: P.captionProps(preset, line.map((w) => w.text.trim()).join(" "),
          +Math.max(0.08, (le - ls) / sp / line.length).toFixed(3), spans) });
    }
    // блюр PII: перетин run з sensitive
    if (region) for (const sv of (script.sensitive || [])) {
      const bs = Math.max(run.start, +sv.start), be = Math.min(run.end, +sv.end);
      if (be > bs) redactClips.push({ start: +(T + (bs - run.start) / sp).toFixed(3),
        duration: +Math.max(0.3, (be - bs) / sp).toFixed(3) });
    }
    // секційний лейбл при зміні блоку
    if (newSection) {
      clips.push({ id: P.uid("c_"), mediaId: null, kind: "text", track: "V3",
        start: +segT.toFixed(3), in: 0, duration: 2, name: "section",
        props: { text: run.section, font: preset.font, fontSize: Math.round(preset.fontSize * 0.7),
          color: "#fff", bgColor: "#000", bgOpacity: 0.5, uppercase: true, align: "center",
          textAnim: "rise-mask", y: -Math.round(H * 0.34) } });
      markers.push({ t: +segT.toFixed(2), label: (run.section || "").slice(0, 22) });
      prevSection = run.section;
    }
    T += D;
  }

  // redaction svg-бокс над PII-регіоном (у канві, з урахуванням contain)
  const media = [m.screen.media, m.webcam.media, m.mic.media];
  if (region && redactClips.length) {
    const rw = Math.round(region.w * m.screen.width * map.s);
    const rh = Math.round(region.h * m.screen.height * map.s);
    const cx = Math.round(map.offX + (region.x + region.w / 2) * m.screen.width * map.s - W / 2);
    const cy = Math.round(map.offY + (region.y + region.h / 2) * m.screen.height * map.s - H / 2);
    const src = writeRedactSVG(rw, rh);
    media.push({ id: "m_redact", name: "redact.svg", kind: "svg", src, duration: 0, width: rw, height: rh });
    for (const rc of redactClips) clips.push({ id: P.uid("c_"), mediaId: "m_redact", kind: "svg",
      track: "V4", start: rc.start, in: 0, duration: rc.duration, name: "blur",
      props: { fit: "none", x: cx, y: cy } });
  }

  let revision = 1;
  try { revision = (JSON.parse(fs.readFileSync(PROJECT, "utf8")).revision || 0) + 1; } catch {}
  return { name: script.title || "Screencast recut", width: W, height: H, fps: 30,
    background: "#000000", revision, markers, media, clips };
}

async function main() {
  P.loadEnv();
  const a = args(process.argv.slice(2));
  if (!a.dir && !a.screen) { console.log("node screencast.js --dir <folder> [--speed 1.06] [--target-min 5] [--format horizontal|vertical] [--dry-run]"); process.exit(0); }
  autoFind(a);
  const preset = P.PRESETS[a.format]; if (!preset) P.die("невідомий --format");

  // 1. транскрипт
  console.log("\n▶ Транскрипт");
  const { words, segments } = await transcribeCached(a.mic, a.lang, a.fresh);
  P.log(`${words.length} слів, ${(words[words.length - 1]?.end / 60 || 0).toFixed(1)} хв`);

  // 2. EDL (--keep, редакторський keep-список) АБО старий пересценарій (recut)
  const scriptCache = path.join(CACHE, "screencast.script.json");
  let script;
  if (a.keep) {
    console.log("\n▶ EDL з keep-списку редакторської команди");
    const sentences = JSON.parse(fs.readFileSync(path.join(CACHE, "sentences.json"), "utf8"));
    const kd = JSON.parse(fs.readFileSync(a.keep, "utf8"));
    const keepIds = Array.isArray(kd) ? kd : (kd.keep || []);
    const oldScript = fs.existsSync(scriptCache) ? JSON.parse(fs.readFileSync(scriptCache, "utf8")) : {};
    const runs = keepRuns(keepIds, sentences, words, 0.9, kd.blocks);
    if (!runs.length) P.die("keepRuns порожній");
    const ukProvider = process.env.OPENAI_API_KEY ? "openai" : "gemini";
    console.log("  ✍ нормалізую субтитри в чисту українську…");
    await correctRunsToUk(runs, ukProvider);
    script = { title: kd.title || oldScript.title || "Recut", _runs: runs, sensitive: kd.sensitive || oldScript.sensitive || [] };
    const total = runs.reduce((n, r) => n + (r.end - r.start), 0) / a.speed;
    console.log(`  ${keepIds.length} речень → ${runs.length} чистих фрагментів (філери вирізані, хронологічно)`);
    console.log(`  🔒 блюр: ${(script.sensitive || []).map((s) => `[${(+s.start).toFixed(0)}–${(+s.end).toFixed(0)}]`).join(" ") || "—"}`);
    console.log(`  ≈ ${(total / 60).toFixed(1)} хв після прискорення ×${a.speed}`);
  } else {
    console.log("\n▶ Пересценарій (recut по тексту)");
    if (!a.fresh && fs.existsSync(scriptCache)) { script = JSON.parse(fs.readFileSync(scriptCache, "utf8")); P.log("сценарій з кешу"); }
    else {
      const tText = (segments.length ? segments : words).map((r) => `[${(+r.start).toFixed(1)}] ${(r.text || r.word).trim()}`).join("\n");
      const provider = process.env.OPENAI_API_KEY ? "openai" : "gemini";
      script = await P.llmJSON(recutPrompt(tText, a.targetMin), provider);
      fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(scriptCache, JSON.stringify(script, null, 2));
    }
    const segs = (script.segments || []).filter((x) => x && x.start != null && x.end != null);
    if (!segs.length) P.die("recut не повернув сегментів");
    script.segments = segs;
    const total = segs.reduce((n, s) => n + (+s.end - +s.start), 0) / a.speed;
    console.log(`\n── СЦЕНАРІЙ: ${script.title || ""} ──`);
    if (script.hook) console.log(`  гачок: ${script.hook}`);
    (script.outline || []).forEach((o, i) => console.log(`  §${i + 1} ${o.section} — ${o.summary || ""}`));
    segs.forEach((s, i) => console.log(`   ${i + 1}. [${(+s.start).toFixed(0)}–${(+s.end).toFixed(0)}] «${s.section || ""}» ${s.topic || ""}`));
    (script.sensitive || []).forEach((s) => console.log(`  🔒 блюр [${(+s.start).toFixed(0)}–${(+s.end).toFixed(0)}] ${s.what || ""}`));
    console.log(`  ≈ ${(total / 60).toFixed(1)} хв після нарізки+прискорення ×${a.speed}`);
  }

  if (a.dryRun) { P.log("--dry-run: без збірки"); return; }

  // 3. vision-регіон PII
  let region = null;
  if (!a.noBlur && (script.sensitive || []).length) {
    console.log("\n▶ Vision: шукаю регіон PII на кадрі оплати…");
    const mid = (+script.sensitive[0].start + +script.sensitive[0].end) / 2;
    const fr = grabFrame(a.screen, mid);
    if (fr) { region = await visionRegion(fr); P.log(region ? `регіон знайдено: ${JSON.stringify(region)}` : "регіон не визначено — блюр пропущено (додай вручну)"); }
  }

  // 4. media + збірка
  console.log("\n▶ Збірка project.json");
  const sp = P.ffprobe(a.screen), wp = P.ffprobe(a.webcam), mpd = P.ffprobe(a.mic) || {};
  const micDur = mpd.duration || sp.duration;
  const m = {
    words,
    screen: { id: "m_screen", width: sp.width, height: sp.height, duration: sp.duration,
      media: { id: "m_screen", name: path.basename(a.screen), kind: "video", src: linkMedia(a.screen), duration: sp.duration, width: sp.width, height: sp.height } },
    webcam: { id: "m_webcam", width: wp.width, height: wp.height, duration: wp.duration,
      media: { id: "m_webcam", name: path.basename(a.webcam), kind: "video", src: linkMedia(a.webcam), duration: wp.duration, width: wp.width, height: wp.height } },
    mic: { id: "m_mic", duration: micDur,
      media: { id: "m_mic", name: path.basename(a.mic), kind: "audio", src: linkMedia(a.mic), duration: micDur } },
  };
  const doc = buildScreencast(m, script, a, region);
  fs.writeFileSync(PROJECT + ".tmp", JSON.stringify(doc, null, 2));
  fs.renameSync(PROJECT + ".tmp", PROJECT);
  const vids = doc.clips.filter((c) => c.name === "screen").length;
  console.log(`\n✓ project.json (rev ${doc.revision}): ${vids} фрагментів (jump-cut), екран+вебка+голос синхронно, ×${a.speed}${region ? ", блюр PII" : ""}`);
  console.log("  node server.js → http://localhost:7777");
}

if (require.main === module) main().catch((e) => P.die(e.stack || e.message || String(e)));
module.exports = { buildScreencast, containMap, recutPrompt };
