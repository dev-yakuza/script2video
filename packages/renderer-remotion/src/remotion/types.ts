import type { Lang, TimelineScene } from '@script2video/core';

export type Aspect = '16:9' | '9:16' | '1:1';

/** Public-dir paths of one face: mouth closed (base), open (talk), half open, eyes closed. */
export type CharacterFace = { base: string; talk?: string; half?: string; blink?: string };

/** One face of a parts character: body (+ front) layers and the head in its 4 mouth/eye states. */
export type PartsFace = {
  body?: string;
  front?: string;
  head: CharacterFace;
  /** Head transform origin [x, y] in canvas px; null: no head motions (they fall back). */
  pivot: [number, number] | null;
};

/** A framing's faces; `canvas` is the widened canvas, `baseWidth` the art's own width (size rule). */
export type PartsSet = {
  canvas: [number, number];
  baseWidth: number;
  baseHeight: number;
  faces: Record<string, PartsFace>;
};

export type CastInfo = {
  key: string;
  name: string;
  color: string;
  /** Default face (paragraphs can set another). */
  face: string;
  /** Public-dir path of the avatar image. */
  avatar?: string;
  character?: {
    faces: Record<string, CharacterFace>;
    facing: 'left' | 'right' | 'front';
    /** Parts characters (character.yaml): layers per framing and face, already flipped for this side. */
    parts?: Record<string, PartsSet>;
    /** Imported material: its art size (scaled like parts art). */
    size?: [number, number];
  };
  side?: 'left' | 'right';
};

// A type alias (not an interface) so it satisfies Remotion's Record<string, unknown> props bound.
export type SceneProps = {
  scene: TimelineScene;
  lang: Lang;
  fps: number;
  aspect: Aspect;
  /** `word`: highlight the word being spoken (Shorts style). */
  subtitleMode: 'sentence' | 'word';
  /** Pixel size of every image referenced by the scene, keyed by the src used in the script. */
  imageSizes: Record<string, [number, number]>;
  /** Public-dir path of each referenced asset, keyed by the src used in the script. */
  assetPaths: Record<string, string>;
  layout: 'presenter' | 'dialogue' | 'fullscreen' | 'shorts';
  /** Speakers of the whole output in cast order (stable across scenes). */
  cast: CastInfo[];
  /** Mouth openness per frame of each sentence ('0' closed, '1' half, '2' open). */
  mouths: Record<string, string>;
  /** Subtitle style (font: public-dir path of a custom font file). */
  subtitleStyle?: {
    size?: number;
    position?: 'bottom' | 'middle' | 'top';
    color?: string;
    background?: string;
    highlight?: string;
    font?: string;
  };
  theme?: { base: 'light' | 'dark'; background?: string; text?: string; accent?: string };
  /** Corner logo (src: public-dir path). */
  logo?: {
    src: string;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    size: number;
    opacity: number;
  };
  /** Scene boundaries: `fade` dips to the background color at both ends of the scene. */
  transition?: 'none' | 'fade';
  /** Character mode: who stands on each side, as switches in scene-local frames. */
  stage: Record<'left' | 'right', { frame: number; keys: string[] }[]>;
  /** Idle motion (acting stage 5a); off: the old blink only. */
  idle: boolean;
  /** Output name: part of the idle motion seeds. */
  output: string;
  /** A single still (snapshot, thumbnail): no blinks, nods or breathing. */
  still: boolean;
};

export const dims = (aspect: Aspect): { width: number; height: number } =>
  aspect === '9:16'
    ? { width: 1080, height: 1920 }
    : aspect === '1:1'
      ? { width: 1080, height: 1080 }
      : { width: 1920, height: 1080 };
