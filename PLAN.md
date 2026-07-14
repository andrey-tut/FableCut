# plan.js — «мозок» для FableCut (наше розширення)

FableCut редагує відео, але сам **не транскрибує й не обирає моменти**. `plan.js` — zero-dep
Node-міст (у стилі `analyze.js`), що закриває цю прогалину: довге інтерв'ю → готовий
`project.json`, який відкривається на таймлайні редактора.

```
відео → ffmpeg(аудіо) → OpenAI whisper-1 (слова) → Gemini 2.5 (моменти)
      → project.json: зшиті кліпи + синхронні караоке-субтитри + аспект/safe під формат
```

## Запуск

```bash
cp .env.example .env          # встав OPENAI_API_KEY + GOOGLE_API_KEY
node plan.js interview.mp4 --format vertical --intro --lang uk
node server.js                # → http://localhost:7777  (побачиш чорновик на таймлайні)
```

Спершу подивитись план без запису: `node plan.js interview.mp4 --format vertical --dry-run`

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
