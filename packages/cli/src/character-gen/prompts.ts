/**
 * Edit instructions for character generation (plan P1, P4, P5, 4.2). Every part source is a
 * first-generation edit of the approved front reference with a fixed template:
 *
 *   <view preset> <head preset> <expression>, <mouth/eye clause>. <KEEP>
 *
 * Frames of a group differ only in the clause and share the group's seed; they edit the group's
 * approved still, so they have no pose prefix. Directions are screen terms ("the viewer's
 * right"). Wording that changes the pictures belongs to a new preset version.
 */

import type { Facing, Framing } from '@script2video/renderer-remotion';

export const LINE_ART =
  'crisp sharp clean dark line art with uniform thick outlines, no blur, flat colors with minimal shading';
const BACKGROUND =
  'Plain solid light gray background, no shadow at all, no text, no other objects.';

const KEEP: Record<Framing, string> = {
  full: 'Keep exactly the same character design, colors, outfit, line art and plain light gray background. No shadow.',
  upper:
    'Keep exactly the same character design, colors, outfit, line art, framing and plain light gray background. No shadow.',
  head: 'Change nothing else: same character, same head position and size, hair, clothes, colors, line art and plain light gray background. No shadow.',
};

const STYLES: Record<string, string> = {
  chibi:
    'Super-deformed chibi character, about two heads tall, big round head, large simple eyes, small body',
  mascot: 'Simple rounded mascot shapes, about two heads tall, short arms and legs',
};

/** The screen side a facing looks toward ("right" for facing: right). */
const side = (f: Facing | undefined) => (f === 'left' ? 'left' : 'right');

/** View presets (C9): `{side}` is the viewer's side the character turns toward. */
export const VIEW_PRESETS: Record<string, (s: string) => string> = {
  'turn-slight': (s) =>
    `The character turns the head and upper body slightly, about 30 degrees, toward the viewer's ${s} side of the image, as if listening to someone standing there. Both eyes stay clearly visible; still mostly facing the viewer.`,
  back: () =>
    'Show the character from behind (back view), so we see the back of the head and body, not the face.',
};
export const HEAD_PRESETS: Record<string, (s: string) => string> = {
  glance: (s) =>
    `The character turns only the head slightly, about 20 degrees, toward the viewer's ${s} side of the image. The body keeps facing the viewer. Both eyes stay clearly visible.`,
};

export type Frame =
  'half' | 'open' | 'blink' | 'gaze-screen-left' | 'gaze-screen-right' | 'gaze-up' | 'gaze-down';
export const MOUTH_FRAMES: Frame[] = ['half', 'open', 'blink'];

const CLAUSE: Record<'still' | Frame, string> = {
  still: 'mouth closed',
  half: 'mouth half open as if in the middle of a word',
  open: 'mouth wide open as if speaking',
  blink: 'mouth closed, eyes gently closed',
  'gaze-screen-left': "mouth closed, the eyes look toward the viewer's left",
  'gaze-screen-right': "mouth closed, the eyes look toward the viewer's right",
  'gaze-up': 'mouth closed, the eyes look up',
  'gaze-down': 'mouth closed, the eyes look down',
};

export interface Pose {
  view?: { preset?: string | undefined; facing: Facing };
  head?: { preset?: string | undefined; facing?: Facing | undefined };
}

function presetText(
  table: Record<string, (s: string) => string>,
  name: string | undefined,
  facing: Facing | undefined,
  what: string,
): string {
  if (!name) return '';
  const p = table[name];
  if (!p)
    throw new Error(`unknown ${what} preset "${name}" (known: ${Object.keys(table).join(', ')})`);
  return p(side(facing));
}

/** "<view preset> <head preset>" for a (view, head). Front views and the base head add nothing. */
export function posePrefix(pose: Pose): string {
  return [
    presetText(VIEW_PRESETS, pose.view?.preset, pose.view?.facing, 'view'),
    presetText(HEAD_PRESETS, pose.head?.preset, pose.head?.facing ?? pose.view?.facing, 'head'),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The expression part of the template. Other expressions are imperative and named ("Make the
 * character look happy: …"): a plain description ("Happy expression with smiling eyes") was
 * ignored on the front reference (change 0.12 %), the imperative form changed it (0.88 %, test r5).
 */
export function expressionText(name: string, prompt: string | undefined): string {
  if (name === 'neutral' && !prompt) return 'Neutral calm expression';
  const word = name.replace(/-/g, ' ');
  return `Make the character look ${word}: ${prompt ?? `${word} expression`}`;
}

/** The P5 template: a group's still (`still`) or one of its frames. */
export function groupPrompt(
  framing: Framing,
  pose: Pose,
  expression: string,
  part: 'still' | Frame,
): string {
  const pre = posePrefix(pose);
  return `${pre ? `${pre} ` : ''}${expression}, ${CLAUSE[part]}. ${KEEP[framing]}`;
}

export function candidatePrompt(kind: string, style: string | undefined): string {
  const s = style ? (STYLES[style] ?? style) : STYLES.chibi!;
  return (
    `Draw ${kind}. ${s}, ${LINE_ART}, 2D standing illustration for a video, full body, facing the viewer, ` +
    `standing straight, arms at the sides. Neutral calm expression, mouth closed, eyes open. ${BACKGROUND}`
  );
}

/** Close-up of the approved full front reference: the front reference of an upper / head set. */
export function closeupPrompt(framing: 'upper' | 'head'): string {
  const same =
    'Exactly the same character design, face, hair, colors, outfit and line art style; plain light gray background, no shadow, no other objects.';
  return framing === 'upper'
    ? `Zoom in: show the same character from the waist up, larger, cut off by the bottom edge of the image, facing the viewer. Neutral calm expression, mouth closed. ${same}`
    : `Zoom in close: show only the same character's head and the top of the shoulders, large and filling most of the image, cut off at the shoulders by the bottom edge, facing the viewer. Neutral calm expression, mouth closed. ${same}`;
}

/** Headless body (P1 exception: an edit of the view's closed reference). */
export const HEADLESS_PROMPT =
  "Remove the character's head completely, including the hair, ears and anything worn on the head. Keep the neck, body, clothes, arms and legs exactly the same and in the same place. Where the head was, there is only the plain light gray background. No shadow.";

/** A front-view pose (body); the head must stay where it is (checked: head shift ≤ 1 px). */
export function bodyPrompt(framing: Framing, pose: Pose, action: string): string {
  const pre = posePrefix(pose);
  return `${pre ? `${pre} ` : ''}The character ${action}. Keep the head, face, hair and expression exactly the same and in the same place. ${KEEP[framing]}`;
}

/** The `@flip` twin of a prompt: every "viewer's right/left" swapped (C10). */
export function flipPrompt(text: string): string {
  return text.replace(/viewer's (left|right)/g, (_, s: string) =>
    s === 'left' ? "viewer's right" : "viewer's left",
  );
}
