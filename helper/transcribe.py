#!/usr/bin/env python3
"""
AudioScribe v2 helper: transcribe with faster-whisper, then refine timing and
add per-sound (phoneme) timing with the Montreal Forced Aligner (MFA).

    python transcribe.py SOURCE OUTPUT.json [--model small] [--lang en]
                         [--start 12.0] [--end 17.5]
                         [--mfa /path/to/mfa] [--no-align]

--start/--end limit transcription to that part of the source (seconds).
Also writes OUTPUT.wav (16 kHz mono, same range) for playback in the panel.
--audio-only writes just that .wav, for transcripts made before it existed.

Output:
{
  "audio": "VO_take2.wav", "duration": 22.4, "range": [12.0, 17.5], "aligned": true,
  "segments": [ {"start": 0.4, "end": 3.1} ],
  "words": [ {"word": "Every", "start": 0.41, "end": 0.66, "seg": 0,
              "phones": [ {"p": "EH", "start": 0.41, "end": 0.49}, ... ] } ]
}
"peaks" is the waveform of the transcribed range for drawing:
{"rate": 100, "start": 12.0, "data": [0-255, ...]}, one value per 10 ms.

Times are in seconds of SOURCE media time. "phones" is missing for words the
aligner could not place; the panel falls back to word-level for those.

Progress goes to stderr as lines starting with "STATUS: ".
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave

SR = 16000


def status(msg):
    print("STATUS: " + msg, file=sys.stderr, flush=True)


def progress(frac):
    print("PROGRESS: %.3f" % max(0.0, min(1.0, frac)), file=sys.stderr, flush=True)


def norm(w):
    return re.sub(r"[^a-z0-9']", "", w.lower())


# ---------------------------------------------------------------- MFA lookup
def find_mfa(explicit):
    cands = []
    if explicit:
        cands.append(explicit)
    env = os.environ.get("MFA_BIN")
    if env:
        cands.append(env)
    exe_dir = os.path.dirname(sys.executable)
    cands += [os.path.join(exe_dir, "mfa"),
              os.path.join(exe_dir, "Scripts", "mfa.exe"),
              os.path.join(exe_dir, "mfa.exe")]
    w = shutil.which("mfa")
    if w:
        cands.append(w)
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


def env_for(mfa_path):
    """MFA shells out to Kaldi binaries in its conda env, so make sure that
    env's bin folders are on PATH even when launched from a GUI app."""
    env = dict(os.environ)
    d = os.path.dirname(mfa_path)
    root = os.path.dirname(d)
    extra = [d, os.path.join(root, "bin"), os.path.join(root, "Library", "bin"),
             os.path.join(root, "Scripts")]
    env["PATH"] = os.pathsep.join([p for p in extra if os.path.isdir(p)] + [env.get("PATH", "")])
    return env


# ------------------------------------------------------------ TextGrid parse
def parse_textgrid(path):
    """Minimal long-format TextGrid reader -> {tier_name: [(xmin, xmax, text)]}"""
    tiers, cur, iv = {}, None, None
    with open(path, encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if s.startswith("name ="):
                cur = s.split("=", 1)[1].strip().strip('"')
                tiers[cur] = []
                iv = None
            elif cur is None:
                continue
            elif s.startswith("xmin ="):
                iv = [float(s.split("=", 1)[1]), None]
            elif s.startswith("xmax =") and iv is not None:
                iv[1] = float(s.split("=", 1)[1])
            elif s.startswith("text =") and iv is not None:
                tiers[cur].append((iv[0], iv[1], s.split("=", 1)[1].strip().strip('"')))
                iv = None
    return tiers


def pick_tier(tiers, suffix):
    for name, ivs in tiers.items():
        if name.lower().endswith(suffix):
            return ivs
    return []


# ----------------------------------------------------------------- pipeline
def write_wav(path, samples):
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def peaks(clip, start, rate=100):
    """Max-amplitude envelope, rate values per second, scaled 0-255."""
    import numpy as np
    n = SR // rate
    m = len(clip) // n
    if m == 0:
        return {"rate": rate, "start": round(start, 3), "data": []}
    env = np.abs(clip[:m * n]).reshape(m, n).max(axis=1)
    ref = float(np.percentile(env, 99.5)) or 1.0
    data = np.clip(env / ref * 255, 0, 255).astype(int).tolist()
    return {"rate": rate, "start": round(start, 3), "data": data}


def transcribe(audio, model_size, lang):
    from faster_whisper import WhisperModel
    status("Loading Whisper " + model_size + " (first run downloads it)")
    model = WhisperModel(model_size, device="auto", compute_type="int8")
    status("Transcribing")
    segments, info = model.transcribe(audio, word_timestamps=True, vad_filter=True,
                                      language=lang or None)
    total = max(0.1, len(audio) / SR)
    segs, words = [], []
    for seg in segments:
        ws = [w for w in (seg.words or []) if (w.word or "").strip()]
        if not ws:
            continue
        si = len(segs)
        segs.append({"start": round(float(ws[0].start), 3), "end": round(float(ws[-1].end), 3)})
        for w in ws:
            words.append({"word": w.word.strip(), "start": round(float(w.start), 3),
                          "end": round(float(w.end), 3), "seg": si})
        status("Transcribing… %.0fs of %.0fs" % (float(seg.end), total))
        progress(0.05 + 0.65 * float(seg.end) / total)
    return segs, words


def align(audio, segs, words, mfa):
    """Run MFA once over a corpus with one utterance per Whisper segment."""
    tmp = tempfile.mkdtemp(prefix="audioscribe_")
    corpus, out = os.path.join(tmp, "corpus"), os.path.join(tmp, "out")
    os.makedirs(corpus)
    offsets = {}
    try:
        for si, seg in enumerate(segs):
            a = max(0.0, seg["start"] - 0.2)
            b = min(len(audio) / SR, seg["end"] + 0.2)
            name = "u%05d" % si
            offsets[name] = (si, a)
            write_wav(os.path.join(corpus, name + ".wav"), audio[int(a * SR):int(b * SR)])
            text = " ".join(w["word"] for w in words if w["seg"] == si)
            with open(os.path.join(corpus, name + ".lab"), "w", encoding="utf-8") as f:
                f.write(text)

        status("Timing individual sounds…")
        progress(0.72)
        cmd = [mfa, "align", corpus, "english_us_arpa", "english_us_arpa", out,
               "--clean", "--single_speaker", "--beam", "100", "--retry_beam", "400"]
        r = subprocess.run(cmd, env=env_for(mfa), capture_output=True, text=True)
        if r.returncode != 0:
            status("MFA failed, keeping word timing only: " + (r.stderr or r.stdout)[-300:].replace("\n", " "))
            return False

        by_seg = {}
        for root, _, files in os.walk(out):
            for fn in files:
                if fn.endswith(".TextGrid"):
                    stem = fn[:-9]
                    if stem in offsets:
                        by_seg[offsets[stem][0]] = (parse_textgrid(os.path.join(root, fn)), offsets[stem][1])

        placed = 0
        for si in range(len(segs)):
            if si not in by_seg:
                continue
            tiers, off = by_seg[si]
            mw = [(s + off, e + off, t) for s, e, t in pick_tier(tiers, "words") if t.strip()]
            mp = [(s + off, e + off, t) for s, e, t in pick_tier(tiers, "phones")
                  if t.strip() and t not in ("sil", "sp")]
            j = 0
            for w in (w for w in words if w["seg"] == si):
                target = norm(w["word"])
                hit = None
                for k in range(j, min(j + 3, len(mw))):
                    if norm(mw[k][2]) == target or mw[k][2] in ("<unk>", "spn"):
                        hit = k
                        break
                if hit is None:
                    continue
                s, e, _ = mw[hit]
                j = hit + 1
                w["start"], w["end"] = round(s, 3), round(e, 3)
                w["phones"] = [{"p": re.sub(r"\d", "", p), "start": round(ps, 3), "end": round(pe, 3)}
                               for ps, pe, p in mp if ps >= s - 1e-4 and pe <= e + 1e-4]
                placed += 1
        status("Aligned %d of %d words" % (placed, len(words)))
        progress(0.97)
        return placed > 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--model", default="small")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--mfa", default="")
    ap.add_argument("--no-align", action="store_true")
    ap.add_argument("--start", type=float, default=None)
    ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--audio-only", action="store_true")
    a = ap.parse_args()

    if not os.path.exists(a.src):
        print("File not found: " + a.src, file=sys.stderr)
        sys.exit(1)
    try:
        from faster_whisper import decode_audio
    except ImportError:
        print("faster-whisper isn't installed for this Python. Run: pip install faster-whisper",
              file=sys.stderr)
        sys.exit(1)

    status("Reading audio")
    progress(0.02)
    audio = decode_audio(a.src, sampling_rate=SR)
    dur = len(audio) / SR
    s = max(0.0, a.start or 0.0)
    e = min(dur, a.end if a.end is not None else dur)
    if e - s < 0.1:
        print("The layer's range is outside the source audio.", file=sys.stderr)
        sys.exit(1)
    wav_out = os.path.splitext(os.path.abspath(a.out))[0] + ".wav"
    os.makedirs(os.path.dirname(wav_out), exist_ok=True)
    write_wav(wav_out, audio[int(s * SR):int(e * SR)])
    if a.audio_only:
        progress(1.0)
        print(wav_out)
        return
    if s > 0 or e < dur:
        status("Transcribing %.1fs of %.1fs" % (e - s, dur))
    segs, words = transcribe(audio[int(s * SR):int(e * SR)], a.model, a.lang)
    for x in segs + words:
        x["start"] = round(x["start"] + s, 3)
        x["end"] = round(x["end"] + s, 3)

    aligned = False
    if not a.no_align and words:
        mfa = find_mfa(a.mfa)
        if mfa:
            aligned = align(audio, segs, words, mfa)
        else:
            status("MFA not found, keeping word timing only")

    data = {"audio": os.path.basename(a.src), "duration": round(dur, 3),
            "range": [round(s, 3), round(e, 3)], "aligned": aligned,
            "peaks": peaks(audio[int(s * SR):int(e * SR)], s),
            "segments": segs, "words": words}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(a.out)


if __name__ == "__main__":
    main()
