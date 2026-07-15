#!/usr/bin/env node
/* Редакторський мозок (прямі API-виклики, надійніше за фонові workflow):
   197 речень → редактор обирає keep (хронологічно, цілі думки, без філерів/води/повторів)
   → QA перевіряє звʼязність → за потреби 1 виправлення. Пише .cache/editorial.keep.json. */
"use strict";
const fs = require("fs"), path = require("path");
const P = require("./plan.js");
const CACHE = path.join(__dirname, ".cache");

const RULES = `ЖОРСТКІ ПРАВИЛА:
1. ПОРЯДОК тільки ХРОНОЛОГІЧНИЙ (за id). Це скрінкаст — екран і голос синхронні; НЕ переставляй, інакше говорить про Google, а видно Facebook.
2. Лишай ЦІЛІ думки. Якщо речення — частина думки, лишай усю думку або викидай усю; НЕ рубай посеред.
3. ВИКИНЬ: філери (е-е-е, м-м-м, ммм), слова-паразити, фальш-старти (почав і переформулював), ПОВТОРИ тієї самої думки, воду, довгі роздуми «хейтити чи ні», відступи не по темі.
4. НЕ лишай «сирітських» стиків: між сусідніми лишеними реченнями екран/тема не має стрибати без містка.
5. Обовʼязково познач у "sensitive" момент оплати Stripe з особистими даними (~299-325с) для блюру.`;

async function main() {
  P.loadEnv();
  const sentences = JSON.parse(fs.readFileSync(path.join(CACHE, "sentences.json"), "utf8"));
  const text = sentences.map((s, i) => `[${i}] (${s.start.toFixed(0)}-${s.end.toFixed(0)}) ${s.text}`).join("\n");
  const provider = process.env.OPENAI_API_KEY ? "openai" : "gemini";

  console.log(`▶ Редакторський прохід — ЛАЙТ-ТРИМ (${sentences.length} речень, ${provider})…`);
  const editPrompt = `Нижче ${sentences.length} речень скрінкасту автора (суржик укр+рос): він розбирає бізнес Лаури в Данії — Facebook, Instagram, Google, Krak, Stripe, реєстр CVR/Virk, фінанси. Формат: [id] (start-end) текст.

ЗАВДАННЯ — ЛАЙТ-ТРИМ, НЕ агресивно. Це відео з ГОЛОСОМ І СЛОВАМИ автора — їх ЗБЕРІГАЄМО. Лиши ПРАКТИЧНО ВСЕ по суті, у ХРОНОЛОГІЧНОМУ порядку.
ВИКИНЬ ЛИШЕ:
1. філери-звуки: е-е-е, м-м-м, ммм;
2. явні фальш-старти (почав фразу, кинув і переформулював — лиши фінальну версію, не обидві);
3. ДОСЛІВНІ повтори тієї самої думки (лиши один раз);
4. чистий навігаційний треп БЕЗ змісту («давайте перейдем», «зайдем сюда», «нажимаем энтер»);
5. найдовші роздуми геть не по темі (напр. «хейтити чи ні»).
НЕ ріж суть. НЕ переставляй (тільки хронологічно). Лиши ЦІЛІ думки — не рубай посеред. Якщо сумніваєшся — ЛИШАЙ. Ціль: ~65–75% речень (це ТВІЙ орієнтир, не жорсткий).
${RULES}

Поверни ЛИШЕ JSON:
{"title":"заголовок","keep":[id,… ЗРОСТАЮЧЕ],
 "blocks":[{"topic":"…","screen":"google|facebook|instagram|krak|stripe|cvr|вступ|висновок","ids":[…]}],
 "sensitive":[{"start":сек,"end":сек,"what":"особисті дані Stripe"}],
 "removed_summary":"коротко що вирізав"}

РЕЧЕННЯ:
${text}`;
  let plan = await P.llmJSON(editPrompt, provider);
  let keep = (plan.keep || []).filter(Number.isInteger).filter((id) => sentences[id]).sort((a, b) => a - b);
  if (!keep.length) P.die("редактор не повернув keep");

  // QA
  const keptText = (k) => k.map((id) => sentences[id]?.text).filter(Boolean).join(" ");
  console.log("▶ QA-верифікація звʼязності…");
  const qaPrompt = (k) => `Ти прискіпливий QA-редактор. Нижче ФІНАЛЬНИЙ транскрипт монтажу (склеєні лишені речення по порядку). Перевір:
- читається як цілісна розповідь, без обірваних думок?
- немає різких стрибків теми (гугл→раптом фейсбук) посеред думки?
- не лишилось філерів (е-е-е/м-м-м), фальш-стартів, явних повторів?
Поверни JSON {"ok":bool,"problems":["конкретні місця/фрази"],"verdict":"1-2 речення"}.

ТРАНСКРИПТ:
${keptText(k)}`;
  let qa = {};
  try { qa = await P.llmJSON(qaPrompt(keep), provider); } catch { qa = { ok: null }; }

  // лайт-трим: QA лише інформативний (НЕ переріз агресивно, щоб не втратити суть/голос)

  const out = { title: plan.title, keep, blocks: plan.blocks || [], sensitive: plan.sensitive || [], removed_summary: plan.removed_summary, qa };
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, "editorial.keep.json"), JSON.stringify(out, null, 2));
  const dur = keep.map((id) => sentences[id]).reduce((n, s) => n + (s.end - s.start), 0);
  console.log(`\n✓ keep: ${keep.length}/${sentences.length} речень ≈ ${(dur / 60 / 1.06).toFixed(1)} хв (×1.06)`);
  console.log(`  заголовок: ${plan.title || ""}`);
  console.log(`  блоки: ${(plan.blocks || []).map((b) => `${b.screen}(${(b.ids || []).length})`).join(" · ")}`);
  console.log(`  🔒 sensitive: ${(plan.sensitive || []).map((s) => `[${(+s.start).toFixed(0)}-${(+s.end).toFixed(0)}]`).join(" ") || "—"}`);
  console.log(`  QA: ${qa.ok === true ? "✓ звʼязно" : qa.ok === false ? "⚠ " + (qa.problems || []).join("; ") : "?"} — ${qa.verdict || ""}`);
  console.log(`  вирізано: ${plan.removed_summary || ""}`);
}
main().catch((e) => { console.error("✗ " + (e.message || e)); process.exit(1); });
