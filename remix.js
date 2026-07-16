#!/usr/bin/env node
/* Швидкий ре-мікс АУДІО без повного пере-рендеру відео (~2 хв замість ~15).
   Реконструює голос із джерела за project.json (ті самі сегменти atempo, що й render.js),
   мікшує з музикою на заданій гучності, муксить на існуюче відео (video copy).
   Для тюнінгу гучності музики/голосу без чекання рендеру. */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");
const ROOT = __dirname, PROJECT = path.join(ROOT, "project.json");
const ff = (aa, t = 1800000) => {
  const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...aa], { timeout: t, encoding: "utf8" });
  if (r.status !== 0) throw new Error("ffmpeg:\n" + (r.stderr || "").split("\n").slice(-6).join("\n"));
};
const resolveSrc = (src) => path.join(ROOT, src.replace(/^\//, ""));
function args(av) {
  const a = { video: "", out: "", music: "", musicVol: 0.01, voiceVol: 1.3, lead: 9.4 };
  for (let i = 0; i < av.length; i++) { const x = av[i];
    if (x === "--video") a.video = av[++i]; else if (x === "--out") a.out = av[++i];
    else if (x === "--music") a.music = av[++i]; else if (x === "--music-vol") a.musicVol = parseFloat(av[++i]);
    else if (x === "--voice-vol") a.voiceVol = parseFloat(av[++i]); else if (x === "--lead") a.lead = parseFloat(av[++i]); }
  return a;
}
function main() {
  const a = args(process.argv.slice(2));
  if (!a.video || !a.out) { console.log("node remix.js --video in.mp4 --out out.mp4 --music m.mp3 --music-vol 0.01 [--voice-vol 1.3] [--lead 9.4]"); process.exit(0); }
  const doc = JSON.parse(fs.readFileSync(PROJECT, "utf8"));
  const byId = Object.fromEntries(doc.media.map((m) => [m.id, m]));
  const mic = resolveSrc(byId["m_mic"].src);
  const voice = doc.clips.filter((c) => c.track === "A1").sort((x, y) => x.start - y.start);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remix_"));
  console.log(`реконструюю голос: ${voice.length} сегментів + ${a.lead}с lead…`);

  // 1. голос: lead-тиша + сегменти mic(atempo) у порядку start (contiguous) → concat
  const parts = [];
  const sil = path.join(tmp, "000000_lead.wav");
  ff(["-f", "lavfi", "-t", String(a.lead), "-i", "anullsrc=r=48000:cl=stereo", "-c:a", "pcm_s16le", sil]);
  parts.push(sil);
  voice.forEach((c, i) => {
    const sp = c.props.speed || 1, win = (c.duration * sp).toFixed(3);
    const seg = path.join(tmp, `${String(i + 1).padStart(6, "0")}.wav`);
    ff(["-ss", String(c.in), "-t", win, "-i", mic, "-af", `atempo=${sp},aresample=48000`, "-ac", "2", "-c:a", "pcm_s16le", seg]);
    parts.push(seg);
  });
  const list = path.join(tmp, "l.txt"); fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
  const voiceWav = path.join(tmp, "voice.wav");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", voiceWav]);

  // 2. мікс voice*voiceVol + music*musicVol (normalize=0 — голос лишається повним)
  const audio = path.join(tmp, "audio.m4a");
  const inp = ["-i", voiceWav]; let af;
  if (a.music && fs.existsSync(a.music)) {
    inp.push("-stream_loop", "-1", "-i", a.music);
    af = `[0:a]volume=${a.voiceVol}[v];[1:a]volume=${a.musicVol}[m];[v][m]amix=inputs=2:duration=first:normalize=0[o]`;
  } else { af = `[0:a]volume=${a.voiceVol}[o]`; }
  ff([...inp, "-filter_complex", af, "-map", "[o]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", audio]);

  // 3. мукс на відео (copy — швидко)
  ff(["-i", a.video, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", a.out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  const sz = (fs.statSync(a.out).size / 1048576).toFixed(1);
  console.log(`✓ ре-мікс готово: ${a.out} (${sz} MB, музика ${a.musicVol}, голос ×${a.voiceVol})`);
}
try { main(); } catch (e) { console.error("✗ " + (e.message || e)); process.exit(1); }
