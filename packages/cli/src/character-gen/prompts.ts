/**
 * Edit instructions for character generation (plan P1, P4, P5, 4.2). Every still is a
 * first-generation edit of the approved front reference, every frame an edit of its approved
 * still, with fixed templates:
 *
 *   still:  <view preset> <head preset> <expression>, mouth closed. <KEEP>
 *   frame:  <the one change, nothing else>. <KEEP>
 *
 * Frames share the group's seed and edit the group's approved still, which already shows the
 * pose and the expression: they name only the change. Restating the expression contradicted it
 * ("eyes wide open …, eyes gently closed" left surprised eyes open, test sora r6). A mouth frame
 * names the expression only, to keep the mouth's mood: without it a smile opened into a round
 * surprised mouth, with "a smiling mouth opens in a smile" alone a surprised one smiled (pilot,
 * experiments/m5-imagegen/blink). Directions
 * are screen terms ("the viewer's right"). Wording that changes the pictures belongs to a new
 * preset version once one is published (none is yet).
 */

import type { Facing, Framing } from '@script2video/renderer-remotion';

export const LINE_ART =
  'crisp sharp clean dark line art with uniform thick outlines, no blur, flat colors with minimal shading';
/**
 * The resting face. "Neutral calm expression" came out slightly sulky on turned views and
 * glances (test r6); a soft smile reads as neutral in a dialogue. Keep it the
 * same everywhere the resting face is drawn: candidates, close-ups and neutral groups.
 */
export const NEUTRAL = 'Calm, relaxed and friendly expression with a soft gentle smile';
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
  // "About 30 degrees ... still mostly facing the viewer" came out almost frontal (test r6).
  'turn-slight': (s) =>
    `The character turns the head and body about 45 degrees toward the viewer's ${s} side of the image, a three-quarter view, as if talking to someone standing there. Both eyes stay visible; the far side of the face looks a little narrower.`,
  back: () =>
    'Show the character from behind (back view), so we see the back of the head and body, not the face.',
};
export const HEAD_PRESETS: Record<string, (s: string) => string> = {
  // "Only the head slightly, about 20 degrees" barely turned it: with a smiling resting face the
  // glance was the front reference again (change 0.08 %, test r6). "The nose points to that
  // side" drew a big pointed nose (sora), but without it the head barely turned or turned the
  // other way (sora head set): the nose keeps pointing, as a tiny mark.
  glance: (s) =>
    `The character turns the head about 30 degrees toward the viewer's ${s} side of the image, looking at someone standing there: the face is clearly turned and the nose points to that side, while the shoulders and body keep facing the viewer. Both eyes stay visible. The nose is a tiny simple mark, as in the input image.`,
};

export type Frame =
  'half' | 'open' | 'blink' | 'gaze-screen-left' | 'gaze-screen-right' | 'gaze-up' | 'gaze-down';
export const MOUTH_FRAMES: Frame[] = ['half', 'open', 'blink'];

const ONLY_MOUTH =
  'Change only the mouth: the eyes, eyebrows and the rest of the face stay exactly as they are.';
/** The mouth's mood stays the expression's (`word`: the expression's name). */
const MOOD = (word: string) =>
  `keeping the same ${word} expression: the mouth keeps its mood (only a smiling mouth opens in a smile)`;
const ONLY_PUPILS =
  'Move only the pupils: the eyelids, eyebrows, mouth and the rest of the face stay exactly as they are.';
/** A frame's one change (the still's expression is in the edited image, not in the words). */
const FRAME_CHANGE: Record<Frame, (word: string) => string> = {
  half: (w) =>
    `Open the character's mouth a little, as if in the middle of a word, ${MOOD(w)}. ${ONLY_MOUTH}`,
  open: (w) => `Open the character's mouth wide, as if speaking, ${MOOD(w)}. ${ONLY_MOUTH}`,
  blink: () =>
    "Close both of the character's eyes, as in a blink: each eye becomes a closed eyelid line, with no white of the eye, iris or pupil showing. Change only the eyes: the eyebrows, mouth and the rest of the face stay exactly as they are.",
  'gaze-screen-left': () => `The character's eyes look toward the viewer's left. ${ONLY_PUPILS}`,
  'gaze-screen-right': () => `The character's eyes look toward the viewer's right. ${ONLY_PUPILS}`,
  'gaze-up': () => `The character's eyes look up. ${ONLY_PUPILS}`,
  'gaze-down': () => `The character's eyes look down. ${ONLY_PUPILS}`,
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
  if (name === 'neutral' && !prompt) return NEUTRAL;
  const word = name.replace(/-/g, ' ');
  return `Make the character look ${word}: ${prompt ?? `${word} expression`}`;
}

/** The P5 template of a group's still. */
export function groupPrompt(framing: Framing, pose: Pose, expression: string): string {
  const pre = posePrefix(pose);
  return `${pre ? `${pre} ` : ''}${expression}, mouth closed. ${KEEP[framing]}`;
}

/** A frame: an edit of its group's approved still that makes the one change. */
export function framePrompt(framing: Framing, frame: Frame, expression: string): string {
  return `${FRAME_CHANGE[frame](expression.replace(/-/g, ' '))} ${KEEP[framing]}`;
}

export function candidatePrompt(kind: string, style: string | undefined): string {
  const s = style ? (STYLES[style] ?? style) : STYLES.chibi!;
  return (
    `Draw ${kind}. ${s}, ${LINE_ART}, 2D standing illustration for a video, full body, facing the viewer, ` +
    `standing straight, arms at the sides. ${NEUTRAL}, mouth closed, eyes open. ${BACKGROUND}`
  );
}

/** Close-up of the approved full front reference: the front reference of an upper / head set. */
export function closeupPrompt(framing: 'upper' | 'head'): string {
  const same =
    'Exactly the same character design, face, hair, colors, outfit and line art style; plain light gray background, no shadow, no other objects.';
  return framing === 'upper'
    ? `Zoom in: show the same character from the waist up, larger, cut off by the bottom edge of the image, facing the viewer. ${NEUTRAL}, mouth closed. ${same}`
    : `Zoom in close: show only the same character's head and the top of the shoulders, large but with clear empty space on the left and right of the hair (the hair never touches the sides or the top of the image), cut off at the shoulders by the bottom edge, facing the viewer. ${NEUTRAL}, mouth closed. ${same}`;
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
