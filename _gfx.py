#!/usr/bin/env python3
"""PIL-графіка для render.js: cold-open (гачок наперед) + дисклеймер-плашка.
Читає gfx.json → малює послідовність cold-open + disclaimer.png."""
import sys, json, os
from PIL import Image, ImageDraw, ImageFont

spec = json.load(open(sys.argv[1]))
W, H, fps = spec["W"], spec["H"], spec["fps"]
FONT = spec["font"]
gfx = spec["gfxDir"]
os.makedirs(gfx, exist_ok=True)
def font(sz): return ImageFont.truetype(FONT, int(sz))
WHITE=(255,255,255,255); GOLD=(255,209,102,255); STROKE=(0,0,0,255); MUT=(150,160,175,255)

def ease(u):  # ease-out back
    u = max(0.0, min(1.0, u)); c1=1.70158; c3=c1+1; v=u-1
    return 1 + c3*v*v*v + c1*v*v

# ── cold-open: рядки тріади зʼявляються по черзі з pop, тоді підзаголовок ──
co = spec["coldopen"]; codur = co["dur"]; lines = co["lines"]; sub = co["sub"]
codir = os.path.join(gfx, "coldopen"); os.makedirs(codir, exist_ok=True)
fbig = font(H*0.115); fsub = font(H*0.042)
STAG = 0.65  # затримка між рядками
nframes = int(codur*fps)
for f in range(nframes):
    t = f/fps
    im = Image.new("RGB", (W, H), (11,14,20)); d = ImageDraw.Draw(im)
    y0 = H*0.34
    for i, ln in enumerate(lines):
        st = i*STAG
        if t < st: continue
        u = min(1.0, (t-st)/0.28)
        s = ease(u)
        lf = font(max(6, fbig.size*s))
        col = GOLD if i == len(lines)-1 else WHITE  # останній («1 телефон») золотий
        d.text((W/2, y0 + i*H*0.145), ln, font=lf, fill=col, anchor="mm",
               stroke_width=max(1,int(3*s)), stroke_fill=STROKE)
    if t >= len(lines)*STAG + 0.2:
        d.text((W/2, H*0.83), sub, font=fsub, fill=MUT, anchor="mm")
    im.save(os.path.join(codir, f"{f:06d}.png"))

# ── disclaimer.png: плашка знизу ──
dl = spec["disclaimer"]["text"].split("\n")
im = Image.new("RGBA", (W, H), (0,0,0,0)); d = ImageDraw.Draw(im)
fdl = font(H*0.026); lh = int(H*0.026*1.45); pad = int(H*0.022)
tw = max(d.textlength(l, font=fdl) for l in dl); bh = lh*len(dl)
cy = H*0.86
x0, x1 = W/2-tw/2-pad*1.6, W/2+tw/2+pad*1.6
y0, y1 = cy-pad, cy+bh+pad
d.rounded_rectangle([x0,y0,x1,y1], radius=14, fill=(11,14,20,215), outline=(90,100,115,255), width=2)
y = y0+pad*0.6
for l in dl:
    d.text((W/2, y), l, font=fdl, fill=(212,218,226,255), anchor="ma")
    y += lh
im.save(os.path.join(gfx, "disclaimer.png"))
print(f"gfx: cold-open {nframes} кадрів + disclaimer")
