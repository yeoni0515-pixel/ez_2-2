"""해파리 만개 배경 음악 합성 (저작권 걱정 없는 직접 생성 음원)

    pip install numpy scipy
    python scripts/generate-music.py [길이(초)]

느린 앰비언트 패드 + 물속처럼 맑은 종소리 + 낮은 베이스.
구간은 대본 흐름에 맞춤:
  0:00~2:40  도입·소설 소개      D장조, 밝고 떠다니는 느낌
  2:40~4:00  인물 대사·독백      B단조 쪽, 더 비우고 어둡게, 종소리 줄임
  4:00~끝    마무리 질문         다시 D장조로 따뜻하게 돌아와 사라짐
결과: public/music/bgm.mp3 (Remotion이 이 파일을 씀)
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
ROOT = Path(__file__).resolve().parent.parent
DURATION = float(sys.argv[1]) if len(sys.argv) > 1 else 289.6
rng = np.random.default_rng(515)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


# (시작 초, 화음 MIDI 음들) — 각 화음은 다음 화음까지 이어지고 3초씩 겹쳐 바뀜
D, Bm, G, A, Em, Fsm = (
    [50, 57, 62, 64, 66, 69],  # Dadd9
    [47, 54, 62, 64, 66, 69],  # Bm11
    [43, 55, 62, 66, 69, 73],  # Gmaj7#11 느낌
    [45, 57, 61, 64, 69, 71],  # Aadd9
    [40, 55, 59, 62, 66, 69],  # Em9
    [42, 54, 61, 64, 69, 73],  # F#m11
)
plan = []
t = 0.0
for chord in [D, Bm, G, A] * 5:  # 0 ~ 160s, 8초씩
    plan.append((t, chord))
    t += 8
for chord in [Bm, G, Em, Fsm] * 2 + [Bm, Em]:  # 160 ~ 240s, 8초씩, 더 어둡게
    plan.append((t, chord))
    t += 8
for chord in [G, A, D, Bm, G, A, D]:  # 240s ~ 끝
    plan.append((t, chord))
    t += 7
plan.append((t, D))

n = int(DURATION * SR)
time = np.arange(n) / SR
left = np.zeros(n)
right = np.zeros(n)
XF = 3.0  # 화음 겹침 시간


def window(start, end):
    """start~end 동안 1, 앞뒤 XF초 코사인 크로스페이드"""
    w = np.zeros(n)
    a, b = int(max(0, start - XF / 2) * SR), int(min(DURATION, end + XF / 2) * SR)
    if b <= a:
        return w, a, b
    seg = time[a:b]
    up = np.clip((seg - (start - XF / 2)) / XF, 0, 1)
    down = np.clip(((end + XF / 2) - seg) / XF, 0, 1)
    w[a:b] = np.sin(np.pi / 2 * np.minimum(up, down)) ** 2
    return w, a, b


def section_level(t):
    """구간별 전체 세기: 대사 구간은 조금 작게"""
    return np.interp(t, [0, 155, 165, 238, 248, DURATION], [1.0, 1.0, 0.72, 0.72, 0.95, 0.95])


# --- 패드 ---
for i, (start, chord) in enumerate(plan):
    end = plan[i + 1][0] if i + 1 < len(plan) else DURATION
    w, a, b = window(start, end)
    if b <= a:
        continue
    seg = time[a:b]
    for j, m in enumerate(chord):
        f = hz(m + (12 if m < 52 and j > 0 else 0))
        amp = 0.05 if j == 0 else 0.032
        for det, ch in ((-0.11, 0), (0.11, 1)):
            ff = f * 2 ** (det / 12 / 4)
            vib = 1 + 0.0015 * np.sin(2 * np.pi * (0.13 + 0.02 * j) * seg + j)
            ph = 2 * np.pi * ff * seg * vib + rng.uniform(0, 6.28)
            tone = np.sin(ph) + 0.25 * np.sin(2 * ph) + 0.08 * np.sin(3 * ph)
            breathe = 0.75 + 0.25 * np.sin(2 * np.pi * 0.05 * seg + j * 1.7)
            (left if ch == 0 else right)[a:b] += amp * tone * breathe * w[a:b]
    # 낮은 베이스 (근음)
    fb = hz(chord[0] - 12 if chord[0] >= 45 else chord[0])
    bass = 0.07 * np.sin(2 * np.pi * fb * seg) * w[a:b]
    left[a:b] += bass
    right[a:b] += bass

sos = butter(2, 2400, "low", fs=SR, output="sos")
left, right = sosfilt(sos, left), sosfilt(sos, right)

# --- 종소리 (D장조 펜타토닉 높은 음역, 띄엄띄엄) ---
bell_notes = [74, 76, 78, 81, 83, 86, 88]
t = 2.5
while t < DURATION - 6:
    dialogue = 160 <= t < 242
    m = rng.choice(bell_notes[:5] if dialogue else bell_notes)
    f = hz(m)
    dur = 4.5
    a, b = int(t * SR), min(n, int((t + dur) * SR))
    seg = time[a:b] - t
    env = np.exp(-seg * 1.3) * np.clip(seg / 0.004, 0, 1)
    tone = np.sin(2 * np.pi * f * seg) + 0.35 * np.sin(2 * np.pi * f * 2.756 * seg) * np.exp(-seg * 3)
    pan = rng.uniform(0.2, 0.8)
    vol = 0.05 * (0.5 if dialogue else 1.0) * rng.uniform(0.6, 1.0)
    left[a:b] += vol * (1 - pan) * tone * env
    right[a:b] += vol * pan * tone * env
    t += rng.uniform(5.0, 9.0) if dialogue else rng.uniform(2.6, 5.5)

level = section_level(time)
left *= level
right *= level

# --- 잔향 (물속처럼 긴 리버브) ---
ir_len = int(4.5 * SR)
ir_t = np.arange(ir_len) / SR
for ch in (0, 1):
    ir = rng.standard_normal(ir_len) * np.exp(-ir_t * 1.4)
    ir = sosfilt(butter(1, 3500, "low", fs=SR, output="sos"), ir)
    ir /= np.sqrt(np.sum(ir**2))
    dry = left if ch == 0 else right
    wet = fftconvolve(dry, ir)[:n]
    mixed = 0.55 * dry + 0.45 * wet
    if ch == 0:
        left = mixed
    else:
        right = mixed

# 앞뒤 페이드
fade = np.clip(time / 4.0, 0, 1) * np.clip((DURATION - time) / 7.0, 0, 1)
stereo = np.stack([left * fade, right * fade], axis=1)
stereo /= np.max(np.abs(stereo)) / 0.8

out = ROOT / "public" / "music"
out.mkdir(parents=True, exist_ok=True)
tmp = out / "bgm-raw.wav"
pcm = (stereo * 32767).astype("<i2")
import wave

with wave.open(str(tmp), "wb") as wf:
    wf.setnchannels(2)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    wf.writeframes(pcm.tobytes())

# 음량을 일정하게 맞춤 (-18 LUFS)
subprocess.run(
    ["ffmpeg", "-y", "-v", "error", "-i", str(tmp), "-af", "loudnorm=I=-18:TP=-2:LRA=11", "-ar", str(SR), "-b:a", "256k", str(out / "bgm.mp3")],
    check=True,
)
tmp.unlink()
print(f"public/music/bgm.mp3 작성 완료 ({DURATION:.1f}초)")
