// 나레이션 음성 생성 + 구간 맞춤 스크립트
//
//   node scripts/generate-narration.mjs                음성 생성 (바뀐 줄만 API 호출)
//   node scripts/generate-narration.mjs --list-voices  쓸 수 있는 한국어 음성 목록
//   node scripts/generate-narration.mjs --add <public_owner_id> <voice_id> <이름>
//                                                      공유 음성을 내 라이브러리에 추가
//
// 필요: ffmpeg/ffprobe, 그리고 voices.json의 provider에 따라
//   "edge"       → 무료 Edge 음성: pip install edge-tts  (키 필요 없음)
//   "elevenlabs" → ELEVENLABS_API_KEY 환경 변수
//
// 1. narration/script.json의 각 줄을 narration/voices.json의 음성으로 생성
//    (narration/cache/에 저장, 대사·음성·설정이 같으면 다시 호출하지 않음)
// 2. 앞뒤 무음을 잘라 내고, 구간(start~end)보다 길면 음높이를 유지한 채 빠르게
//    (최대 maxSpeedUp배; 그래도 길면 다음 대사 시작 0.2초 전까지만 넘기고 더 빠르게)
// 3. public/narration/<id>.mp3 와 src/narration-timing.json 작성

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const p = (...s) => path.join(root, ...s);
const API = "https://api.elevenlabs.io";
// 클라우드 환경에서는 네트워크 프록시가 실제 키를 넣어 주므로 자리표시 값이어도 됨
const KEY = process.env.ELEVENLABS_API_KEY || "proxy-injected";

const api = async (method, url, body) => {
  const res = await fetch(API + url, {
    method,
    headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  }
  return res;
};

const args = process.argv.slice(2);

if (args[0] === "--list-voices") {
  const mine = await (await api("GET", "/v1/voices")).json();
  console.log("\n[내 라이브러리]");
  for (const v of mine.voices) {
    console.log(`  ${v.voice_id}  ${v.name}  ${JSON.stringify(v.labels ?? {})}`);
  }
  for (const gender of ["male", "female"]) {
    const shared = await (
      await api("GET", `/v1/shared-voices?language=ko&gender=${gender}&page_size=30`)
    ).json();
    console.log(`\n[공유 라이브러리 · 한국어 · ${gender}]  (사용 전 --add 필요)`);
    for (const v of shared.voices) {
      console.log(
        `  ${v.public_owner_id} ${v.voice_id}  ${v.name} · ${v.age ?? ""} · ${v.descriptive ?? ""} · ${v.use_case ?? ""}`,
      );
    }
  }
  process.exit(0);
}

if (args[0] === "--add") {
  const [, owner, voiceId, name] = args;
  const r = await (
    await api("POST", `/v1/voices/add/${owner}/${voiceId}`, { new_name: name })
  ).json();
  console.log(`추가됨: ${r.voice_id}  → narration/voices.json의 voiceId에 넣으세요`);
  process.exit(0);
}

const script = JSON.parse(readFileSync(p("narration/script.json"), "utf8"));
const cfg = JSON.parse(readFileSync(p("narration/voices.json"), "utf8"));
const gap = script.minGapSeconds;
const lines = [...script.lines].sort((a, b) => a.start - b.start);

const provider = cfg.provider;
for (const [name, v] of Object.entries(cfg.voices)) {
  if (provider === "elevenlabs" && !v.elevenlabs.voiceId && lines.some((l) => l.voice === name)) {
    console.error(`narration/voices.json의 "${name}" voiceId가 비어 있습니다. --list-voices로 고르세요.`);
    process.exit(1);
  }
}

mkdirSync(p("narration/cache"), { recursive: true });
mkdirSync(p("public/narration"), { recursive: true });

const duration = (file) =>
  Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
      .toString()
      .trim(),
  );

const ffmpeg = (input, output, filter) =>
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-af", filter, "-ar", "44100", "-b:a", "192k", output]);

const TRIM =
  "silenceremove=start_periods=1:start_threshold=-45dB," +
  "areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse";

const timing = [];
const report = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const voice = cfg.voices[line.voice][provider];
  const style = line.style ? cfg.styles[line.style][provider] : {};
  let request;
  if (provider === "edge") {
    request = { text: line.text, ...voice, ...style };
  } else {
    request = {
      voiceId: voice.voiceId,
      text: line.text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { ...voice.settings, ...style },
      previous_text: lines[i - 1]?.voice === line.voice ? lines[i - 1].text : undefined,
      next_text: lines[i + 1]?.voice === line.voice ? lines[i + 1].text : undefined,
    };
  }
  const hash = createHash("sha1").update(JSON.stringify([provider, request])).digest("hex").slice(0, 10);
  const raw = p("narration/cache", `${String(line.id).padStart(2, "0")}-${hash}.mp3`);

  if (!existsSync(raw) || statSync(raw).size === 0) {
    const tmp = raw + ".part";
    process.stdout.write(`#${line.id} 생성 중… `);
    if (provider === "edge") {
      const edgeArgs = ["--voice", request.voice, "--text", request.text, "--write-media", tmp];
      for (const k of ["rate", "pitch", "volume"]) {
        if (request[k]) edgeArgs.push(`--${k}=${request[k]}`);
      }
      // 프록시 뒤(회사·클라우드)에서는 edge-tts가 환경 변수를 안 읽으므로 직접 넘김
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      if (proxy) edgeArgs.push("--proxy", proxy);
      execFileSync(process.env.EDGE_TTS ?? "edge-tts", edgeArgs, { stdio: ["ignore", "ignore", "pipe"] });
    } else {
      const { voiceId, ...body } = request;
      const res = await api("POST", `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, body);
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    }
    if (statSync(tmp).size === 0) throw new Error(`#${line.id} 음성이 비어 있습니다`);
    renameSync(tmp, raw);
    console.log("완료");
  }

  const trimmed = p("narration/cache", `trim-${line.id}.mp3`);
  ffmpeg(raw, trimmed, TRIM);
  const natural = duration(trimmed);

  const slot = line.end - line.start;
  const next = lines[i + 1]?.start ?? Infinity;
  const hardLimit = next - gap - line.start;
  let speed = 1;
  if (natural > slot) speed = Math.min(natural / slot, cfg.maxSpeedUp);
  if (natural / speed > hardLimit) speed = natural / hardLimit;

  const out = `narration/${line.id}.mp3`;
  ffmpeg(trimmed, p("public", out), speed > 1.001 ? `atempo=${speed.toFixed(4)}` : "anull");
  const final = duration(p("public", out));

  timing.push({ id: line.id, voice: line.voice, text: line.text, start: line.start, end: line.end, file: out, duration: final, speed });
  report.push({
    "#": line.id,
    음성: line.voice,
    구간: `${line.start}~${line.end}s`,
    "원래 길이": `${natural.toFixed(2)}s`,
    배속: speed > 1.001 ? `${speed.toFixed(2)}x` : "-",
    "최종 끝": `${(line.start + final).toFixed(2)}s`,
    메모:
      speed > cfg.maxSpeedUp + 0.001
        ? "⚠ 너무 빠름: 대사를 줄이거나 시간을 늘려 주세요"
        : line.start + final > line.end + 0.05
          ? "끝 시간을 넘김(다음 대사와는 안 겹침)"
          : "",
  });
}

writeFileSync(p("src/narration-timing.json"), JSON.stringify(timing, null, 2) + "\n");
console.table(report);
console.log("src/narration-timing.json 작성 완료");
