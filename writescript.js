#!/usr/bin/env node
/* Пише ЧИСТИЙ закадровий сценарій із сирого суржик-транскрипту (по СУТІ, не дослівно). */
"use strict";
const fs = require("fs"), path = require("path");
const P = require("./plan.js");
const CACHE = path.join(__dirname, ".cache");
async function main() {
  P.loadEnv();
  const S = JSON.parse(fs.readFileSync(path.join(CACHE, "sentences.json"), "utf8"));
  const text = S.map((s) => s.text).join(" ");
  const provider = process.env.OPENAI_API_KEY ? "openai" : "gemini";
  const prompt = `Ти сценарист YouTube бізнес-оглядів. Нижче СИРИЙ транскрипт (суржик укр+рос, потік свідомості, з whisper-помилками) відео, де автор розбирає бізнес бухгалтерки Лаури в Данії по ВІДКРИТИХ даних (Facebook, Instagram, Google, Krak, реєстр CVR/Virk, фінанси).

Напиши ЧИСТИЙ, зв'язний, цікавий ЗАКАДРОВИЙ текст (voiceover) грамотною УКРАЇНСЬКОЮ — по СУТІ що автор виявив (НЕ дослівно, прибери кашу й повтори). ~3.5–4 хв (≈550–650 слів).
Структура: сильний ГАЧОК → знахідки по черзі (онлайн-присутність і биті лінки → пропозиції реклами й ціни → 3 повʼязані фірми на 1 адресі й 1 телефоні → фінанси: прибуток менший за зарплату одного будівельника → головний мінус: немає сайту) → ВИСНОВОК + порада для свого бізнесу.
Тон: дружній, експертний, БЕЗ хейту, наголос що це публічні дані й особиста думка. Короткі абзаци-репліки (по 1–2 речення). Тільки текст наррації, без ремарок і заголовків.

ПОверни JSON {"script":"весь текст з абзацами через \\n\\n","words":число_слів}.

СИРИЙ ТРАНСКРИПТ:
${text}`;
  console.log("▶ Пишу чистий сценарій…");
  const r = await P.llmJSON(prompt, provider);
  fs.writeFileSync(path.join(CACHE, "clean_script.txt"), r.script || "");
  console.log(`\n✓ Чистий сценарій (~${r.words || "?"} слів ≈ ${Math.round((r.words || 600) / 150)} хв):\n`);
  console.log(r.script || "(порожньо)");
}
main().catch((e) => { console.error("✗ " + (e.message || e)); process.exit(1); });
