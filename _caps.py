#!/usr/bin/env python3
"""PIL-рендерер субтитрів + інтро для render.js (ffmpeg тут без libass/drawtext).
Читає spec.json → малює інтро-PNG + послідовність кадрів смуги субтитрів
(активне слово золоте, по реальних whisper-таймкодах). Дедуп однакових кадрів."""
import sys, json, os, shutil
from PIL import Image, ImageDraw, ImageFont

spec = json.load(open(sys.argv[1]))
W, H, fps = spec["W"], spec["H"], spec["fps"]
introDur, totalDur = spec["introDur"], spec["totalDur"]
bandH = spec["bandH"]
font = ImageFont.truetype(spec["font"], spec["fontSize"])
caps = spec["captions"]
framesDir = spec["framesDir"]
os.makedirs(framesDir, exist_ok=True)
GOLD, WHITE, STROKE = (255, 209, 102, 255), (255, 255, 255, 255), (0, 0, 0, 255)

# інтро-плашка
if spec.get("introPng") and spec.get("introText"):
    im = Image.new("RGBA", (W, H), (13, 17, 23, 255))
    d = ImageDraw.Draw(im)
    fi = ImageFont.truetype(spec["font"], int(H * 0.06))
    txt = spec["introText"]
    words, line, lines = txt.split(), "", []
    for w in words:
        t = (line + " " + w).strip()
        if d.textlength(t, font=fi) > W * 0.8 and line:
            lines.append(line); line = w
        else:
            line = t
    if line:
        lines.append(line)
    lh = int(H * 0.06 * 1.3)
    y = H / 2 - lh * (len(lines) - 1) / 2
    for ln in lines:
        d.text((W / 2, y), ln, font=fi, fill=WHITE, anchor="mm",
               stroke_width=2, stroke_fill=STROKE)
        y += lh
    im.save(spec["introPng"])

empty = Image.new("RGBA", (W, bandH), (0, 0, 0, 0))
emptyPath = os.path.join(framesDir, "_empty.png")
empty.save(emptyPath)

def active_word(c, lt):
    for i, w in enumerate(c["words"]):
        if w["s"] <= lt < w["e"]:
            return i
    return -1

def find_cap(t):
    for i, c in enumerate(caps):
        if c["start"] <= t < c["start"] + c["dur"]:
            return i, c
    return -1, None

nframes = int(totalDur * fps) + 1
sw = ImageDraw.Draw(empty).textlength(" ", font=font)
last_key, last_path = None, None
for f in range(nframes):
    t = f / fps - introDur
    ci, c = find_cap(t)
    key = None
    if c:
        lt = t - c["start"]
        key = (ci, active_word(c, lt))
    path = os.path.join(framesDir, f"{f:06d}.png")
    if key == last_key and last_path:
        shutil.copyfile(last_path, path); continue
    if not c:
        shutil.copyfile(emptyPath, path); last_key, last_path = None, path; continue
    im = Image.new("RGBA", (W, bandH), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    words = [(w["w"].upper() if c.get("uppercase") else w["w"]) for w in c["words"]]
    widths = [d.textlength(x, font=font) for x in words]
    total = sum(widths) + sw * max(0, len(words) - 1)
    x = (W - total) / 2
    ai = key[1]
    for i, wd in enumerate(words):
        d.text((x, bandH / 2), wd, font=font, fill=(GOLD if i == ai else WHITE),
               anchor="lm", stroke_width=6, stroke_fill=STROKE)
        x += widths[i] + sw
    im.save(path)
    last_key, last_path = key, path
print(f"caption frames: {nframes}")
