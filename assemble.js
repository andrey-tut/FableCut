#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   FableCut assemble.js — БАГАТОФАЙЛОВИЙ «розумний монтажер» (zero-dep, Node 18+).

   Кілька файлів одного інтерв'ю (дублі/частини/камери) → ОДИН структурований
   цікавий монтаж як FableCut project.json:
     1. транскрибує КОЖЕН файл (whisper-1, слово-таймкоди)
     2. Gemini читає ВСЕ разом і:
        • прибирає ПОВТОРИ (та сама думка в різних дублях → лишає найкращий)
        • будує ЛОГІЧНУ структуру (гачок → контекст → тези → висновок), не хронологію
     3. у кожному вибраному фрагменті jump-cut'ить ДОВГІ ПАУЗИ і філери («ееее», «ммм»)
        по словниках-таймкодах — усе кл/pами над ОРИГІНАЛАМИ (не руйнівно)
     4. зшиває на таймлайн + синхронні субтитри + секційні лейбли + маркери

   Usage:
     node assemble.js file1.mp4 file2.mp4 file3.mov [--format vertical|horizontal|reels|stories|ads]
        [--lang uk] [--select gemini|openai|auto] [--target-min 3] [--intro] [--no-sections]
        [--gap 0.55] [--keep-fillers] [--dry-run]

   Далі: node server.js → http://localhost:7777 (чорновик на таймлайні), доводиш руками/через MCP.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const P = require("./plan.js"); // PRESETS, ffprobe, extractAudio, transcribe, llmJSON, chunkWords, captionProps, loadEnv, uid, die, log

const ROOT = __dirname;
const MEDIA_DIR = path.join(ROOT, "media");
const PROJECT_FILE = path.join(ROOT, "project.json");

// Філери (консервативно — лише не-лексичні повтори, щоб не різати справжні слова).
const FILLER = /^[^\p{L}]*(?:е{2,}|а{2,}|о{2,}|м{2,}|мм+|ее+|э{2,}|um+|uh+|er+|hmm+|ehm+)[^\p{L}]*$/iu;

function parseArgs(argv) {
  const a = { format: "horizontal", lang: "uk", select: "auto", targetMin: 0,
    intro: false, sections: true, gap: 0.55, keepFillers: false, dryRun: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--format") a.format = argv[++i];
    else if (x === "--lang") a.lang = argv[++i];
    else if (x === "--select") a.select = argv[++i];
    else if (x === "--target-min") a.targetMin = parseFloat(argv[++i]);
    else if (x === "--gap") a.gap = parseFloat(argv[++i]);
    else if (x === "--intro") a.intro = true;
    else if (x === "--no-sections") a.sections = false;
    else if (x === "--keep-fillers") a.keepFillers = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (!x.startsWith("--")) a.files.push(x);
  }
  return a;
}

/* Розбиває слова фрагмента на «мовні пробіги», РІЖУЧИ довгі паузи й філери.
   Кожен пробіг стане окремим кліпом над оригіналом → пауза/філер зникають (jump-cut). */
function speechRuns(words, gap, keepFillers) {
  const runs = [];
  let cur = [];
  const push = () => {
    if (cur.length && cur[cur.length - 1].end - cur[0].start >= 0.35)
      runs.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    const t = (w.text || "").trim();
    if (!keepFillers && FILLER.test(t)) { push(); continue; }          // виріз філера
    if (cur.length && w.start - cur[cur.length - 1].end > gap) push();  // виріз паузи
    cur.push(w);
  }
  push();
  return runs;
}

/* Промпт структурування: дедуп + логічна композиція по ВСІХ файлах. */
function structurePrompt(lang, filesText, targetMin) {
  return `Ти досвідчений відео-редактор і сценарист. Нижче — транскрипти ДЕКІЛЬКОХ файлів ОДНОГО інтерв'ю (різні дублі/частини/камери) мовою «${lang}». Кожен рядок: [Fx START-END] текст.

Склади ОДИН цікавий, добре структурований монтаж:
1. Визнач ключові теми й думки.
2. Прибери ПОВТОРИ: якщо думку сказано кілька разів (у різних файлах/дублях) — залиш ОДИН найкращий варіант (найчіткіший, найкоротший, найкраща подача), решту відкинь.
3. Побудуй ЛОГІЧНУ структуру (НЕ хронологію): сильний гачок → контекст → ключові тези по наростанню → висновок/заклик.
4. Прибирай воду, відступи й слабкі дублі.${targetMin ? `\n5. Цільова тривалість ~${targetMin} хв.` : ""}

Поверни ЛИШЕ JSON:
{"title":"робоча назва","outline":[{"section":"назва секції","summary":"1 рядок"}],
 "segments":[{"file":"F1","start":сек,"end":сек,"section":"назва секції","topic":"про що (коротко)"}]}
Правила segments: у ФІНАЛЬНОМУ порядку монтажу; межі — на реченнях; кожен 5–45с; посилайся лише на наявні [Fx]; не бери один і той самий контент двічі.

ТРАНСКРИПТИ:
${filesText}`;
}

/* Збірка project.json з упорядкованих сегментів (кожен → jump-cut кліпи + субтитри). */
function buildMultiProject(files, ordered, meta, preset, args) {
  const byKey = Object.fromEntries(files.map((f) => [f.key, f]));
  const clips = [];
  const markers = [];
  let T = 0;
  let prevSection = null;
  let firstOfSeg;

  if (args.intro && meta.title) {
    clips.push({ id: P.uid("c_"), mediaId: null, kind: "text", track: "V3",
      start: 0, in: 0, duration: 2.4, name: "intro",
      props: { text: meta.title, font: preset.font, fontSize: Math.round(preset.fontSize * 1.1),
        color: "#ffffff", color2: "#ffd166", strokeWidth: 4, uppercase: true,
        align: "center", textAnim: "clip-reveal", y: 0 } });
  }

  for (const seg of ordered) {
    const f = byKey[seg.file];
    if (!f) continue;
    const s = Math.max(0, +seg.start), e = Math.min(f.duration, +seg.end);
    if (!(e > s)) continue;
    const segWords = f.words.filter((w) => w.start >= s - 0.2 && w.end <= e + 0.2);
    const runs = speechRuns(segWords, args.gap, args.keepFillers);
    if (!runs.length) continue;

    const segStartT = T;
    firstOfSeg = true;
    for (const run of runs) {
      const dur = run.end - run.start;
      clips.push({ id: P.uid("c_"), mediaId: f.id, kind: "video", track: "V1",
        start: +T.toFixed(3), in: +run.start.toFixed(3), duration: +dur.toFixed(3),
        name: seg.topic || f.name, props: { fit: "cover" },
        ...(firstOfSeg && (segStartT > 0) ? { transitionIn: { type: "fade", duration: 0.3 } } : {}) });
      // субтитри цього пробігу
      for (const line of P.chunkWords(run.words)) {
        const ls = line[0].start, le = line[line.length - 1].end;
        clips.push({ id: P.uid("c_"), mediaId: null, kind: "text", track: "V2",
          start: +(T + (ls - run.start)).toFixed(3), in: 0,
          duration: +Math.max(0.4, le - ls).toFixed(3), name: "cap",
          props: P.captionProps(preset, line.map((w) => w.text.trim()).join(" "),
            +Math.max(0.08, (le - ls) / line.length).toFixed(3)) });
      }
      T += dur;
      firstOfSeg = false;
    }

    // секційний лейбл (верхній банер) на початку нової секції
    if (args.sections && seg.section && seg.section !== prevSection) {
      clips.push({ id: P.uid("c_"), mediaId: null, kind: "text", track: "V3",
        start: +segStartT.toFixed(3), in: 0, duration: 2, name: "section",
        props: { text: seg.section, font: preset.font, fontSize: Math.round(preset.fontSize * 0.7),
          color: "#ffffff", bgColor: "#000000", bgOpacity: 0.5, uppercase: true, align: "center",
          textAnim: "rise-mask", y: -Math.round(preset.h * 0.34) } });
      prevSection = seg.section;
    }
    markers.push({ t: +segStartT.toFixed(2), label: (seg.topic || seg.section || "").slice(0, 24) });
  }

  if (preset.cta) {
    clips.push({ id: P.uid("c_"), mediaId: null, kind: "text", track: "V3",
      start: +Math.max(0, T - 3).toFixed(3), in: 0, duration: 3, name: "cta",
      props: { text: "Спробуй →", font: preset.font, fontSize: preset.fontSize,
        color: "#04120a", bgColor: "#3fb950", bgOpacity: 1, uppercase: true,
        align: "center", textAnim: "pop", y: Math.round(preset.h * 0.3) } });
  }

  let revision = 1;
  try { revision = (JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8")).revision || 0) + 1; } catch {}
  return { name: meta.title || `${args.format} · монтаж`,
    width: preset.w, height: preset.h, fps: 30, background: "#000000",
    revision, markers, media: files.map((f) => f.media), clips };
}

/* ── main ─────────────────────────────────────────────────────────────────── */
async function main() {
  P.loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args.files.length) {
    console.log(`assemble.js — багато файлів інтерв'ю → структурований монтаж\n
  node assemble.js f1.mp4 f2.mp4 … [--format horizontal|vertical|reels|stories|ads]
       [--lang uk] [--target-min N] [--intro] [--no-sections] [--gap 0.55]
       [--keep-fillers] [--select gemini|openai|auto] [--dry-run]`);
    process.exit(0);
  }
  const preset = P.PRESETS[args.format];
  if (!preset) P.die("невідомий --format. є: " + Object.keys(P.PRESETS).join(", "));

  // 1. ingest + transcribe кожен файл
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const files = [];
  for (let i = 0; i < args.files.length; i++) {
    const src = path.resolve(args.files[i]);
    if (!fs.existsSync(src)) P.die("немає файлу: " + src);
    const base = path.basename(src);
    const dest = path.join(MEDIA_DIR, base);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    const probe = P.ffprobe(dest);
    if (!probe.duration) P.die("ffprobe не зчитав: " + base);
    const key = "F" + (i + 1);
    console.log(`\n▶ [${key}] ${base} — транскрибую (${probe.duration.toFixed(0)}с)…`);
    const audio = P.extractAudio(dest);
    const { words, segments } = await P.transcribe(audio, args.lang);
    fs.rmSync(audio, { force: true });
    P.log(`${words.length} слів, ${segments.length} сегментів`);
    files.push({ key, name: base, id: P.uid("m_"), duration: +probe.duration.toFixed(3),
      words, segments,
      media: { id: undefined, name: base, kind: "video", src: "/media/" + base,
        duration: +probe.duration.toFixed(3), width: probe.width, height: probe.height } });
  }
  files.forEach((f) => { f.media.id = f.id; }); // media.id = mediaId

  // 2. структурування (дедуп + композиція) по ВСІХ файлах
  console.log("\n▶ Аналіз + структура (дедуп повторів, логічний порядок)…");
  const filesText = files.map((f) =>
    `\n=== ${f.key} (${f.name}) ===\n` +
    (f.segments.length ? f.segments : f.words.map((w) => ({ start: w.start, end: w.end, text: w.text })))
      .map((r) => `[${f.key} ${(+r.start).toFixed(1)}-${(+r.end).toFixed(1)}] ${r.text.trim()}`).join("\n")
  ).join("\n");
  const selector = args.select === "auto"
    ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "gemini" : "openai") : args.select;
  const plan = await P.llmJSON(structurePrompt(args.lang, filesText, args.targetMin), selector);
  const ordered = (plan.segments || []).filter((s) => s && s.file && s.start != null && s.end != null);
  if (!ordered.length) P.die("модель не повернула сегментів");

  console.log(`\n── СТРУКТУРА: ${plan.title || "(без назви)"} ──────────────`);
  (plan.outline || []).forEach((o, i) => console.log(`  §${i + 1} ${o.section}${o.summary ? " — " + o.summary : ""}`));
  console.log("  сегменти:");
  ordered.forEach((s, i) => console.log(
    `   ${i + 1}. [${s.file} ${(+s.start).toFixed(1)}–${(+s.end).toFixed(1)}] ${s.section ? "«" + s.section + "» " : ""}${s.topic || ""}`));
  console.log("──────────────────────────────────────────");
  console.log(`формат: ${args.format} ${preset.w}×${preset.h} · движок: ${selector} · паузи>${args.gap}с ріжу${args.keepFillers ? "" : " + філери"}`);

  if (args.dryRun) { P.log("--dry-run: project.json не записано"); return; }

  // 3. збірка + запис
  const doc = buildMultiProject(files, ordered, { title: plan.title }, preset, args);
  const tmp = PROJECT_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, PROJECT_FILE);
  const vids = doc.clips.filter((c) => c.kind === "video").length;
  console.log(`\n✓ project.json (rev ${doc.revision}): ${doc.clips.length} кліпів (${vids} відео-фрагментів після jump-cut), ${doc.media.length} джерел`);
  console.log("  Відкрий редактор:  node server.js  →  http://localhost:7777");
}

if (require.main === module) main().catch((e) => P.die(e.message || String(e)));
module.exports = { speechRuns, buildMultiProject, structurePrompt };
