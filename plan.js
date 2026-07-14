#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   FableCut plan.js — the "brain" bridge (zero-dependency, Node 18+).

   Довге відео (інтерв'ю) → готовий FableCut project.json:
     1. ffmpeg витягує стиснене аудіо
     2. OpenAI whisper-1 → транскрипт зі СЛОВНИКОВИМИ таймкодами
     3. Gemini 2.5 Flash (fallback GPT) → обирає N найцікавіших моментів
     4. збирає project.json: зшиті кліпи + синхронні караоке-субтитри
        + аспект/стиль/safe-зони під формат (horizontal|vertical|reels|stories|ads)

   Далі відкрий редактор (node server.js → http://localhost:7777) — побачиш
   чорновик на таймлайні й доводиш руками або командами агенту (через MCP).

   Usage:
     node plan.js <video> [--format vertical] [--clips 5] [--lang uk]
                          [--select gemini|openai|auto] [--intro] [--title "..."] [--dry-run]

   Ключі: OPENAI_API_KEY (+ GOOGLE_API_KEY/GEMINI_API_KEY) — з env або ./.env
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const MEDIA_DIR = path.join(ROOT, "media");
const PROJECT_FILE = path.join(ROOT, "project.json");

/* ── формат-пресети: канва + стиль субтитрів + дефолти ───────────────────── */
const PRESETS = {
  horizontal: { w: 1920, h: 1080, clips: 6, cap: "subtitle", capY: 0.34,
                font: "Roboto", fontSize: 46, anim: "none", intro: "impact" },
  vertical:   { w: 1080, h: 1920, clips: 5, cap: "reels", capY: 0.20,
                font: "Archivo Black", fontSize: 76, anim: "word-pop", intro: "kinetic" },
  reels:      { w: 1080, h: 1920, clips: 5, cap: "reels", capY: 0.20,
                font: "Bebas Neue", fontSize: 82, anim: "word-pop", intro: "neon" },
  stories:    { w: 1080, h: 1920, clips: 4, cap: "reels", capY: 0.16,
                font: "Anton", fontSize: 80, anim: "word-pop", intro: "boldRise" },
  ads:        { w: 1080, h: 1920, clips: 3, cap: "reels", capY: 0.20, cta: true,
                font: "Anton", fontSize: 84, anim: "word-pop", intro: "impact" },
};

/* ── дрібні утиліти ───────────────────────────────────────────────────────── */
const uid = (p) => p + Math.random().toString(36).slice(2, 8);
const die = (m) => { console.error("✗ " + m); process.exit(1); };
const log = (m) => console.log("  " + m);

function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function parseArgs(argv) {
  const a = { format: "vertical", clips: 0, lang: "uk", select: "auto",
              intro: false, title: "", dryRun: false, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--format") a.format = argv[++i];
    else if (x === "--clips") a.clips = parseInt(argv[++i], 10);
    else if (x === "--lang") a.lang = argv[++i];
    else if (x === "--select") a.select = argv[++i];
    else if (x === "--title") a.title = argv[++i];
    else if (x === "--intro") a.intro = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (!x.startsWith("--")) a._.push(x);
  }
  return a;
}

function ffprobe(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate", "-show_entries", "format=duration",
    "-of", "json", file], { encoding: "utf8", timeout: 15000 });
  try {
    const j = JSON.parse(r.stdout);
    const s = (j.streams && j.streams[0]) || {};
    const [n, d] = (s.r_frame_rate || "30/1").split("/").map(Number);
    return { duration: parseFloat(j.format.duration), width: s.width, height: s.height,
             fps: Math.round((n / (d || 1)) || 30) };
  } catch { return {}; }
}

function extractAudio(src) {
  const out = path.join(os.tmpdir(), "fc_" + uid("") + ".mp3");
  const r = spawnSync("ffmpeg", ["-y", "-i", src, "-ac", "1", "-ar", "16000",
    "-b:a", "32k", out], { encoding: "utf8" });
  if (r.status !== 0) die("ffmpeg extract audio failed:\n" + (r.stderr || "").split("\n").slice(-4).join("\n"));
  return out;
}

/* ── 2. транскрипція (OpenAI whisper-1, слово-таймкоди) ───────────────────── */
async function transcribe(audioPath, lang) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) die("немає OPENAI_API_KEY (потрібен для транскрипції). див. .env.example");
  const buf = fs.readFileSync(audioPath);
  if (buf.length > 25 * 1024 * 1024) die("аудіо > 25MB — вкороти відео або знизь бітрейт");
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");
  fd.append("model", "whisper-1");
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "word");
  fd.append("timestamp_granularities[]", "segment");
  if (lang) fd.append("language", lang);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions",
    { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
  if (!res.ok) die("whisper-1 HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const j = await res.json();
  const words = (j.words || []).map((w) => ({ text: w.word, start: +w.start, end: +w.end }));
  const segments = (j.segments || []).map((s) => ({ start: +s.start, end: +s.end, text: s.text }));
  return { words, segments };
}

/* ── 3. вибір моментів (Gemini | OpenAI) ──────────────────────────────────── */
function buildTranscriptText(segments, words) {
  const rows = segments.length ? segments
    : words.map((w) => ({ start: w.start, end: w.end, text: w.text }));
  return rows.map((r) => `[${r.start.toFixed(1)}-${r.end.toFixed(1)}] ${r.text.trim()}`).join("\n");
}

function selectPrompt(lang, n, transcript) {
  return `Ти монтажер коротких відео. Нижче — таймкодований транскрипт інтерв'ю мовою «${lang}».
Обери ${n} НАЙЦІКАВІШИХ самодостатніх моментів для монтажу.
Правила: кожен 20–60с; ПОЧАТОК і КІНЕЦЬ на межах речень (не рубати думку); не перетинаються;
бери сильні гачки, інсайти, емоційні піки, цитати.
Поверни ЛИШЕ JSON: {"clips":[{"start":сек,"end":сек,"title":"короткий заголовок","hook":"перший рядок-гачок"}]}

ТРАНСКРИПТ:
${transcript}`;
}

function coerceClips(raw, n, maxDur) {
  const out = [];
  for (const c of (raw.clips || []).slice(0, n * 2)) {
    let s = +c.start, e = +c.end;
    if (!(e > s)) continue;
    if (e - s > 75) e = s + 60;
    if (e - s < 6) continue;
    if (maxDur) { s = Math.max(0, s); e = Math.min(e, maxDur); }
    out.push({ start: s, end: e, title: String(c.title || "").trim(), hook: String(c.hook || "").trim() });
  }
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, n);
}

async function selectGemini(transcript, lang, n, maxDur) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: selectPrompt(lang, n, transcript) }] }],
      generationConfig: { response_mime_type: "application/json", temperature: 0.4 } }) });
  if (!res.ok) die("Gemini HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const j = await res.json();
  const txt = j.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return coerceClips(JSON.parse(txt), n, maxDur);
}

async function selectOpenAI(transcript, lang, n, maxDur) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const res = await fetch("https://api.openai.com/v1/chat/completions",
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model, temperature: 0.4, response_format: { type: "json_object" },
        messages: [{ role: "user", content: selectPrompt(lang, n, transcript) }] }) });
  if (!res.ok) die("OpenAI HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const j = await res.json();
  return coerceClips(JSON.parse(j.choices[0].message.content), n, maxDur);
}

/* ── 4. збірка project.json ───────────────────────────────────────────────── */
function chunkWords(words) {
  const lines = [];
  let cur = [];
  const flush = () => { if (cur.length) { lines.push(cur); cur = []; } };
  for (const w of words) {
    const chars = cur.reduce((s, x) => s + x.text.length + 1, 0);
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length >= 4 || chars > 24 || gap > 0.6) flush();
    cur.push(w);
  }
  flush();
  return lines;
}

function captionProps(preset, text, wordRate) {
  const y = Math.round(preset.h * preset.capY);
  if (preset.cap === "reels") {
    return { text, font: preset.font, fontSize: preset.fontSize, color: "#ffffff",
      strokeWidth: 6, strokeColor: "#000000", bgColor: "#000000", bgOpacity: 0.35,
      textAnim: preset.anim, wordRate, uppercase: true, align: "center", y };
  }
  return { text, font: preset.font, fontSize: preset.fontSize, color: "#ffffff",
    strokeWidth: 3, strokeColor: "#000000", bgColor: "#000000", bgOpacity: 0.5,
    textAnim: "none", align: "center", y };
}

function buildProject(media, moments, words, preset, args) {
  const clips = [];
  let T = 0; // позиція на таймлайні

  if (args.intro || preset.cta) {
    const title = args.title || moments[0]?.title || media.name;
    // інтро-плашка 0..2.2с
    if (args.intro) {
      clips.push({ id: uid("c_"), mediaId: null, kind: "text", track: "V2",
        start: 0, in: 0, duration: 2.2, name: "intro",
        props: { text: title, font: preset.font, fontSize: Math.round(preset.fontSize * 1.15),
          color: "#ffffff", color2: "#ffd166", strokeWidth: 4, uppercase: true, align: "center",
          textAnim: "clip-reveal", y: 0 } });
    }
  }

  moments.forEach((m, i) => {
    const dur = Math.min(m.end, media.duration) - m.start;
    if (dur <= 0) return;
    // 4a. відео-кліп моменту на V1
    clips.push({ id: uid("c_"), mediaId: media.id, kind: "video", track: "V1",
      start: +T.toFixed(3), in: +m.start.toFixed(3), duration: +dur.toFixed(3),
      name: m.title || `moment ${i + 1}`,
      props: { fit: "cover" },  // cover = заповнити канву (важливо для 16:9→9:16)
      ...(i > 0 ? { transitionIn: { type: "fade", duration: 0.25 } } : {}) });

    // 4b. синхронні субтитри на V2 (слова цього моменту → рядки)
    const mw = words.filter((w) => w.start >= m.start - 0.2 && w.end <= m.end + 0.2);
    for (const line of chunkWords(mw)) {
      const ls = line[0].start, le = line[line.length - 1].end;
      const text = line.map((w) => w.text.trim()).join(" ");
      const wr = Math.max(0.08, (le - ls) / line.length);
      clips.push({ id: uid("c_"), mediaId: null, kind: "text", track: "V2",
        start: +(T + (ls - m.start)).toFixed(3), in: 0, duration: +Math.max(0.4, le - ls).toFixed(3),
        name: "cap", props: captionProps(preset, text, +wr.toFixed(3)) });
    }
    T += dur;
  });

  // 4c. ads-CTA в кінці
  if (preset.cta) {
    clips.push({ id: uid("c_"), mediaId: null, kind: "text", track: "V2",
      start: +Math.max(0, T - 3).toFixed(3), in: 0, duration: 3, name: "cta",
      props: { text: args.title ? args.title : "Спробуй →", font: preset.font,
        fontSize: preset.fontSize, color: "#04120a", bgColor: "#3fb950", bgOpacity: 1,
        uppercase: true, align: "center", textAnim: "pop", y: Math.round(preset.h * 0.30) } });
  }

  const markers = [];
  let mt = args.intro ? 2.2 : 0;
  moments.forEach((m) => { markers.push({ t: +mt.toFixed(2), label: (m.title || "").slice(0, 20) });
    mt += Math.min(m.end, media.duration) - m.start; });

  let revision = 1;
  try { revision = (JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8")).revision || 0) + 1; } catch {}

  return { name: args.title || `${args.format} · ${media.name}`,
    width: preset.w, height: preset.h, fps: 30, background: "#000000",
    revision, markers, media: [media], clips };
}

/* ── main ─────────────────────────────────────────────────────────────────── */
async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args._.length) {
    console.log(`FableCut plan.js — відео → готовий project.json з субтитрами\n
  node plan.js <video> [--format vertical|horizontal|reels|stories|ads]
                       [--clips N] [--lang uk] [--select gemini|openai|auto]
                       [--intro] [--title "..."] [--dry-run]\n
  формати: ${Object.keys(PRESETS).join(" · ")}`);
    process.exit(0);
  }
  const preset = PRESETS[args.format];
  if (!preset) die("невідомий --format. є: " + Object.keys(PRESETS).join(", "));
  const n = args.clips || preset.clips;
  const src = path.resolve(args._[0]);
  if (!fs.existsSync(src)) die("немає файлу: " + src);

  // 1. import media
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const base = path.basename(src);
  const dest = path.join(MEDIA_DIR, base);
  if (!fs.existsSync(dest)) { log("копіюю у media/…"); fs.copyFileSync(src, dest); }
  const probe = ffprobe(dest);
  if (!probe.duration) die("ffprobe не зчитав відео");
  const media = { id: uid("m_"), name: base, kind: "video", src: "/media/" + base,
    duration: +probe.duration.toFixed(3), width: probe.width, height: probe.height };
  log(`відео: ${probe.width}×${probe.height} · ${probe.duration.toFixed(1)}с · ${probe.fps}fps`);

  // 2. transcribe
  console.log("\n▶ Транскрипція (whisper-1)…");
  const audio = extractAudio(dest);
  const { words, segments } = await transcribe(audio, args.lang);
  fs.rmSync(audio, { force: true });
  if (!words.length) die("порожній транскрипт");
  log(`${words.length} слів, ${segments.length} сегментів`);

  // 3. select
  console.log("\n▶ Вибір моментів…");
  let selector = args.select === "auto"
    ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "gemini" : "openai")
    : args.select;
  const transcript = buildTranscriptText(segments, words);
  const moments = selector === "gemini"
    ? await selectGemini(transcript, args.lang, n, media.duration)
    : await selectOpenAI(transcript, args.lang, n, media.duration);
  if (!moments.length) die("модель не повернула моментів");

  console.log("\n── ПЛАН ──────────────────────────────────");
  moments.forEach((m, i) => {
    console.log(`  ${i + 1}. [${m.start.toFixed(1)}–${m.end.toFixed(1)}] ${(m.end - m.start).toFixed(0)}s  ${m.title}`);
    if (m.hook) console.log(`      ↳ ${m.hook}`);
  });
  console.log("──────────────────────────────────────────");
  console.log(`формат: ${args.format} ${preset.w}×${preset.h} · субтитри: ${preset.cap} · движок: ${selector}`);

  if (args.dryRun) { log("--dry-run: project.json не записано"); return; }

  // 4. build + write
  const doc = buildProject(media, moments, words, preset, args);
  const tmp = PROJECT_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, PROJECT_FILE);
  console.log(`\n✓ project.json оновлено (rev ${doc.revision}): ${doc.clips.length} кліпів`);
  console.log("  Відкрий редактор:  node server.js  →  http://localhost:7777");
  console.log("  (якщо вже відкритий — таймлайн перезавантажиться сам за ~150мс)");
}

if (require.main === module) main().catch((e) => die(e.message || String(e)));
module.exports = { PRESETS, buildProject, chunkWords, captionProps, ffprobe };
