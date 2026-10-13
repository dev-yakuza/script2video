import type { TimelineCue, TimelineSubtitle } from '@script2video/core';
import type React from 'react';
import {
  AbsoluteFill,
  Composition,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from 'remotion';
import { AreaContext } from './area';
import { customFont, fontFor, withFallback } from './fonts';
import {
  assignSides,
  dialogueGeometry,
  dialogueShape,
  maxGroup,
  type DialogueShape,
} from '../shared';
import { CastStrip, CharacterStage } from './Dialogue';
import { ImageVisual } from './ImageVisual';
import { measureSubtitles, type ProbeItem, type ProbeResult } from './probe';
import { ThemeContext, resolveTheme, useTheme } from './theme';
import { dims, type SceneProps } from './types';
import {
  BulletsVisual,
  ChartVisual,
  CodeVisual,
  CompareVisual,
  DiagramVisual,
  MarkdownVisual,
  SplitVisual,
  GalleryVisual,
  VideoVisual,
  DEFAULT_LOOK,
  QuoteVisual,
  SubtitleLookContext,
  Subtitles,
  type SubtitleLook,
  TableVisual,
  TitleVisual,
} from './visuals';

const FADE_FRAMES = 9;

/**
 * Dip to the background color over the first and last frames of a scene. Each scene is its own
 * chunk, so a transition that needs both scenes' pixels (crossfade, slide) is not used.
 */
const FadeEdges: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  const background = useTheme().background;
  const opacity = Math.max(
    interpolate(frame, [0, FADE_FRAMES], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
    interpolate(frame, [duration - FADE_FRAMES, duration - 1], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  return opacity > 0 ? <AbsoluteFill style={{ background, opacity }} /> : null;
};

/** Corner logo, a fixed fraction of the frame width, kept clear of the frame edge. */
const Logo: React.FC<NonNullable<SceneProps['logo']>> = ({ src, position, size, opacity }) => {
  const { width } = useVideoConfig();
  const [v, h] = position.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const margin = Math.round(width * 0.025);
  return (
    <Img
      src={staticFile(src)}
      style={{
        position: 'absolute',
        [v]: margin,
        [h]: margin,
        width: width * size,
        height: 'auto',
        opacity,
      }}
    />
  );
};

/** One scene, scene-local frames (frame 0 = scene start). */
const SceneComp: React.FC<SceneProps> = ({
  scene,
  lang,
  fps,
  aspect,
  subtitleMode,
  imageSizes,
  assetPaths,
  layout,
  cast,
  mouths,
  stage,
  subtitleStyle,
  transition,
  theme: themeProp,
  logo,
}) => {
  const theme = resolveTheme(themeProp);
  const fontFamily = fontFor(lang);
  const portrait = aspect === '9:16';
  // Subtitle metrics use portrait sizes for every frame narrower than 1500 px (9:16 and 1:1).
  const narrowFrame = aspect !== '16:9';
  const sides = assignSides(cast);
  const style = subtitleStyle ?? {};
  const g = dialogueGeometry({ ...dialogueShape(layout, cast), portrait: narrowFrame }, style);
  const look: SubtitleLook = {
    color: style.color ?? DEFAULT_LOOK.color,
    background: style.background ?? DEFAULT_LOOK.background,
    highlight: style.highlight ?? DEFAULT_LOOK.highlight,
    ...(style.font ? { fontFamily: withFallback(customFont(style.font).family, lang) } : {}),
  };
  const m = g.subtitle;
  // Space kept free of visuals: speakers and subtitles (dialogue), subtitles (portrait).
  const area =
    g.mode !== 'none' ? g.visual : { left: 0, right: 0, bottom: portrait ? m.bottom + 260 : 0 };
  const speakers =
    cast.length >= 2 && g.mode !== 'character'
      ? Object.fromEntries(cast.map((c) => [c.key, { name: c.name, color: c.color }]))
      : undefined;
  // Box size for one subtitle: the largest group on each side while it is shown, so the text
  // never rewraps mid-subtitle when a group steps in.
  const metricsFor = (s: TimelineSubtitle) =>
    dialogueGeometry(
      {
        mode: 'character',
        left: Math.max(stage.left.length ? 1 : 0, maxGroup(stage.left, s.startFrame, s.endFrame)),
        right: Math.max(
          stage.right.length ? 1 : 0,
          maxGroup(stage.right, s.startFrame, s.endFrame),
        ),
        portrait: narrowFrame,
      },
      style,
    ).subtitle;
  const sideOf =
    g.mode === 'character'
      ? Object.fromEntries([
          ...sides.left.map((c) => [c.key, 'left'] as const),
          ...sides.right.map((c) => [c.key, 'right'] as const),
        ])
      : undefined;
  // Visual i is shown from its start (the first one from frame 0) until the next visual starts.
  const visuals = scene.visuals.map((v, i) => {
    const from = i === 0 ? 0 : v.startFrame;
    const to = scene.visuals[i + 1]?.startFrame ?? scene.durationFrames;
    return { ...v, from, to };
  });
  const cuesIn = (from: number, to: number): TimelineCue[] =>
    scene.cues
      .filter((c) => c.frame >= from && c.frame < to)
      .map((c) => ({ ...c, frame: c.frame - from }));

  return (
    <ThemeContext.Provider value={theme}>
      <AreaContext.Provider value={area}>
        <SubtitleLookContext.Provider value={look}>
          <AbsoluteFill style={{ background: theme.background }}>
            {visuals.map(({ visual, from, to }, i) => (
              <Sequence key={i} from={from} durationInFrames={Math.max(1, to - from)} layout="none">
                <AbsoluteFill
                  style={
                    g.mode !== 'none' && visual.type !== 'image'
                      ? { ...area, width: 'auto', height: 'auto' }
                      : {}
                  }
                >
                  {visual.type === 'title' ? (
                    <TitleVisual label={visual.label ?? ''} fontFamily={fontFamily} />
                  ) : visual.type === 'image' && visual.attrs.src ? (
                    <ImageVisual
                      src={assetPaths[visual.attrs.src] ?? visual.attrs.src}
                      size={imageSizes[visual.attrs.src] ?? [1920, 1080]}
                      cues={cuesIn(from, to)}
                      area={area}
                      shows={Object.fromEntries(
                        cuesIn(from, to)
                          .map((c) => c.attrs.show)
                          .filter((x): x is string => !!x && !!assetPaths[x])
                          .map((x) => [
                            x,
                            { src: assetPaths[x]!, size: imageSizes[x] ?? [1920, 1080] },
                          ]),
                      )}
                      duration={to - from}
                      kenBurns={visual.attrs.kenburns !== 'off'}
                    />
                  ) : visual.type === 'bullets' ? (
                    <BulletsVisual
                      items={visual.items ?? []}
                      cues={cuesIn(from, to)}
                      fontFamily={fontFamily}
                    />
                  ) : visual.type === 'code' ? (
                    <CodeVisual code={visual.body ?? ''} cues={cuesIn(from, to)} />
                  ) : visual.type === 'table' ? (
                    <TableVisual
                      rows={visual.rows ?? []}
                      cues={cuesIn(from, to)}
                      fontFamily={fontFamily}
                    />
                  ) : visual.type === 'split' && visual.images?.[0] ? (
                    <SplitVisual
                      image={{
                        ...visual.images[0],
                        src: assetPaths[visual.images[0].src] ?? visual.images[0].src,
                      }}
                      md={visual.md ?? []}
                      cues={cuesIn(from, to)}
                      imageRight={visual.attrs.side === 'right'}
                      fontFamily={fontFamily}
                    />
                  ) : visual.type === 'markdown' ? (
                    <MarkdownVisual
                      md={visual.md ?? []}
                      cues={cuesIn(from, to)}
                      fontFamily={fontFamily}
                    />
                  ) : visual.type === 'diagram' ? (
                    <DiagramVisual
                      code={visual.body ?? ''}
                      cues={cuesIn(from, to)}
                      fontFamily={fontFamily}
                    />
                  ) : visual.type === 'compare' ? (
                    <CompareVisual
                      columns={visual.columns ?? []}
                      cues={cuesIn(from, to)}
                      fontFamily={fontFamily}
                    />
                  ) : visual.type === 'gallery' ? (
                    <GalleryVisual
                      images={(visual.images ?? []).map((im) => ({
                        ...im,
                        src: assetPaths[im.src] ?? im.src,
                      }))}
                      cues={cuesIn(from, to)}
                      fontFamily={fontFamily}
                    />
                  ) : visual.type === 'chart' ? (
                    <ChartVisual
                      rows={visual.rows ?? []}
                      cues={cuesIn(from, to)}
                      {...(visual.attrs.unit ? { unit: visual.attrs.unit } : {})}
                      fontFamily={fontFamily}
                    />
                  ) : visual.type === 'video' && visual.attrs.src ? (
                    <VideoVisual
                      src={assetPaths[visual.attrs.src] ?? visual.attrs.src}
                      start={Number(visual.attrs.start ?? 0)}
                    />
                  ) : visual.type === 'quote' ? (
                    <QuoteVisual
                      items={visual.items ?? []}
                      {...(visual.attrs.by ? { by: visual.attrs.by } : {})}
                      fontFamily={fontFamily}
                    />
                  ) : null}
                </AbsoluteFill>
              </Sequence>
            ))}
            {g.mode === 'character' ? (
              <CharacterStage
                cast={cast}
                audio={scene.audio}
                reactions={scene.reactions}
                motions={scene.motions ?? []}
                mouths={mouths}
                geometry={g}
                stage={stage}
                fps={fps}
                framing={scene.framing ?? {}}
              />
            ) : g.mode === 'avatar' ? (
              <CastStrip
                cast={cast}
                audio={scene.audio}
                geometry={g}
                portrait={narrowFrame}
                fontFamily={fontFamily}
              />
            ) : null}
            <Subtitles
              subtitles={scene.subtitles}
              lang={lang}
              fontFamily={fontFamily}
              mode={subtitleMode}
              metrics={m}
              portrait={narrowFrame}
              {...(speakers ? { speakers } : {})}
              {...(sideOf ? { sideOf, metricsFor } : {})}
            />
            {logo ? <Logo {...logo} /> : null}
            {transition === 'fade' ? <FadeEdges duration={scene.durationFrames} /> : null}
          </AbsoluteFill>
        </SubtitleLookContext.Provider>
      </AreaContext.Provider>
    </ThemeContext.Provider>
  );
};

const sceneMeta: CalculateMetadataFunction<SceneProps> = ({ props }) => ({
  durationInFrames: Math.max(1, props.scene.durationFrames),
  fps: props.fps,
  ...dims(props.aspect),
});

const placeholder: SceneProps = {
  scene: {
    id: 'empty',
    title: '',
    startFrame: 0,
    durationFrames: 1,
    visuals: [],
    audio: [],
    cues: [],
    subtitles: [],
    reactions: [],
    motions: [],
    framing: {},
  },
  lang: 'ko',
  fps: 30,
  aspect: '16:9',
  subtitleMode: 'sentence',
  imageSizes: {},
  assetPaths: {},
  layout: 'presenter',
  cast: [],
  mouths: {},
  stage: { left: [], right: [] },
};

type ProbeProps = {
  lang: string;
  shape: DialogueShape;
  style?: { size?: number; position?: 'bottom' | 'middle' | 'top'; font?: string };
  items: ProbeItem[];
  results: ProbeResult[];
};

// Never rendered: `s2v check` reads the measured lines from the resolved props.
const probeMeta: CalculateMetadataFunction<ProbeProps> = async ({ props }) => ({
  props: {
    ...props,
    results: await measureSubtitles(props.items, props.lang, props.shape, props.style ?? {}),
  },
  durationInFrames: 1,
});

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="S2VScene"
      component={SceneComp}
      defaultProps={placeholder}
      calculateMetadata={sceneMeta}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="S2VProbe"
      component={() => <AbsoluteFill />}
      defaultProps={
        {
          lang: 'ko',
          shape: { mode: 'none', left: 0, right: 0, portrait: false },
          items: [],
          results: [],
        } as ProbeProps
      }
      calculateMetadata={probeMeta}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);
