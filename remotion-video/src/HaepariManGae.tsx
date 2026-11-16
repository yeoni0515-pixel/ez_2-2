import { Audio, Video } from "@remotion/media";
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";
import {
  AbsoluteFill,
  CalculateMetadataFunction,
  Composition,
  interpolate,
  staticFile,
} from "remotion";
import timingJson from "./narration-timing.json";

type NarrationLine = {
  id: number;
  voice: string;
  text: string;
  start: number;
  end: number;
  file: string;
  duration: number;
  speed: number;
};

// scripts/generate-narration.mjs가 작성
const timing = timingJson as NarrationLine[];

const FPS = 30;
// 원본 영상: public/haepari.mp4 (해파리만개_전체_v3.mp4를 이 이름으로 복사)
const SOURCE = "haepari.mp4";
const SOURCE_VOLUME = 1; // 원본 소리 유지 100%
const NARRATION_VOLUME = 1; // 나레이션 100%
// 배경 음악: public/music/bgm.mp3 (scripts/generate-music.py로 생성)
const MUSIC = "music/bgm.mp3";
const MUSIC_VOLUME = 0.3; // 평소 30%
const MUSIC_DUCKED_VOLUME = 0.12; // 나레이션 중 12%
const DUCK_ATTACK = 0.3; // 나레이션 시작 0.3초 전부터 줄임
const DUCK_RELEASE = 0.6; // 나레이션 끝나고 0.6초에 걸쳐 되돌림

type Props = Record<string, unknown>;

// 0 = 음악 그대로, 1 = 완전히 줄임
const duckAmount = (t: number) => {
  let amount = 0;
  for (const line of timing) {
    const end = line.start + line.duration;
    const a = interpolate(
      t,
      [line.start - DUCK_ATTACK, line.start, end, end + DUCK_RELEASE],
      [0, 1, 1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
    amount = Math.max(amount, a);
  }
  return amount;
};

const musicVolume = (frame: number) =>
  MUSIC_VOLUME - (MUSIC_VOLUME - MUSIC_DUCKED_VOLUME) * duckAmount(frame / FPS);

const calculateMetadata: CalculateMetadataFunction<Props> = async () => {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(staticFile(SOURCE)),
  });
  const [seconds, track] = await Promise.all([
    input.computeDuration(),
    input.getPrimaryVideoTrack(),
  ]);
  if (!track) throw new Error(`${SOURCE}에 영상 트랙이 없습니다`);
  return {
    durationInFrames: Math.ceil(seconds * FPS),
    width: track.displayWidth,
    height: track.displayHeight,
  };
};

export const HaepariManGae: React.FC<Props> = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Video src={staticFile(SOURCE)} volume={SOURCE_VOLUME} />
      <Audio src={staticFile(MUSIC)} volume={musicVolume} />
      {timing.map((line) => (
        <Audio
          key={line.id}
          src={staticFile(line.file)}
          from={Math.round(line.start * FPS)}
          volume={NARRATION_VOLUME}
        />
      ))}
    </AbsoluteFill>
  );
};

export const HaepariManGaeComposition: React.FC = () => (
  <Composition
    id="HaepariManGae"
    component={HaepariManGae}
    fps={FPS}
    durationInFrames={1}
    width={1920}
    height={1080}
    calculateMetadata={calculateMetadata}
  />
);
