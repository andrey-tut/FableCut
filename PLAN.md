# plan.js — «мозок» для FableCut (наше розширення)

FableCut редагує відео, але сам **не транскрибує й не обирає моменти**. `plan.js` — zero-dep
Node-міст (у стилі `analyze.js`), що закриває цю прогалину: довге інтерв'ю → готовий
`project.json`, який відкривається на таймлайні редактора.

```
відео → ffmpeg(аудіо) → OpenAI whisper-1 (слова) → Gemini 2.5 (моменти)
      → project.json: зшиті кліпи + синхронні караоке-субтитри + аспект/safe під формат
```

## ⭐ Багато файлів → структурований монтаж (assemble.js) — основний сценарій

Кілька дублів/частин/камер одного інтерв'ю → аналіз усього → дедуп повторів →
логічна структура → jump-cut пауз і філерів → зшивка:

```bash
cp .env.example .env          # встав OPENAI_API_KEY + GOOGLE_API_KEY
node assemble.js part1.mp4 part2.mp4 part3.mov --format horizontal --intro --lang uk
node server.js                # → http://localhost:7777
```
- прибирає **ПОВТОРИ** (та сама думка в різних дублях → лишає найкращий варіант)
- будує **структуру**: гачок → контекст → тези → висновок (не хронологія), секційні лейбли
- ріже **довгі паузи** (`--gap 0.55`) і **філери** «ееее/ммм» (вимкнути: `--keep-fillers`)
- `--target-min N` — цільова тривалість · `--dry-run` — лише план без запису

## 🎥 Запис екрана (Screen Studio: екран+вебка+мікрофон) → перекроєний монтаж (screencast.js)

Синхронні канали ОДНОГО запису → пересценарій + прискорення + блюр PII. Дістає сирі
канали навіть з `.screenstudio`-бандла (без платного експорту):

```bash
node screencast.js --dir /path/to/recording --lang uk --speed 1.06 --target-min 5 --dry-run
node screencast.js --dir /path/to/recording --lang uk --speed 1.06     # повний збір
node server.js
```
- транскрибує мікрофон → LLM робить ТІСНИЙ **пересценарій** (recut по тексту, логічна структура)
- **jump-cut** пауз/філерів; синхронно кладе екран(V1) + вебку-PiP(V2) + голос(A1); ×`--speed`
- **блюр PII**: vision (gpt-4o) знаходить регіон особистих даних (Stripe тощо) → SVG-бокс над ним
- субтитри(V3), секційні лейбли, маркери. Важкі файли **лінкуються** (не копіюються). Кеш у `.cache/`

Прапорці: `--speed 1.06`, `--target-min N`, `--format horizontal|vertical`, `--gap 0.5`, `--no-blur`, `--fresh`.

## 🎬 Експорт у MP4 БЕЗ браузера (render.js)

FableCut експортує у браузері — а він висне на важких відео. `render.js` рендерить
**headless** через ffmpeg (текст — через Python PIL `_caps.py`, бо цей ffmpeg без libass/drawtext):

```bash
node render.js --out ~/Movies/recut.mp4            # весь проєкт
node render.js --segments 2 --out /tmp/test.mp4    # швидкий тест
node render.js --music track.mp3 --music-vol 0.06  # + тиха фонова музика
```
Збирає екран(contain) + вебку-PiP + голос + прискорення, **посинхронні субтитри**
(активне слово золоте), **редакцію PII** (drawbox), інтро-плашку. Потребує `python3` + Pillow.

## Один файл → кліпи-моменти (plan.js)

```bash
node plan.js interview.mp4 --format vertical --intro --lang uk
node server.js
```
Спершу план без запису: `node plan.js interview.mp4 --format vertical --dry-run`

## Формати (канва + стиль субтитрів + к-сть моментів)

| `--format` | Канва | Субтитри | Дефолт кліпів |
|---|---|---|---|
| `horizontal` | 1920×1080 | спокійні знизу | 6 (cut-down) |
| `vertical` | 1080×1920 | великі word-pop | 5 |
| `reels` | 1080×1920 | Bebas, word-pop | 5 |
| `stories` | 1080×1920 | Anton, вище (safe) | 4 |
| `ads` | 1080×1920 | + CTA в кінці | 3 |

Прапорці: `--clips N`, `--lang uk`, `--select gemini|openai|auto`, `--intro`, `--title "..."`, `--dry-run`.

## Далі — редагування словами (через MCP)

Коли чорновик на таймлайні, доводиш його або **руками в UI**, або **командами агенту**
(зареєструй MCP: `claude mcp add -s user fablecut -- node "<шлях>/FableCut/mcp-server.js"`):
«прибери 3-й момент», «зроби переходи whip», «підклади музику −18dB», «переклади субтитри EN».
Агент патчить `project.json` (`fablecut_patch_project`), UI перезавантажується за ~150мс.

## Що ще можна нарощувати

- неперервний трекінг обличчя для кропу (зараз `fit:cover` центрує статично);
- окремий project на кожен момент (`--split`) для пачки Reels;
- дубляж/озвучка (Chatterbox/CosyVoice) як окремий крок → нова аудіо-доріжка A1.
