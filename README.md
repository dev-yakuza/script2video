# script2video

**English** | [한국어](README.ko.md) | [日本語](README.ja.md)

Write a Markdown script, get a narrated explainer video — in Korean, English or Japanese, with local open-source TTS. Zoom and highlight your own screenshots as you talk. Reproducible: same script + same environment → same video. YouTube 16:9, Shorts 9:16 from one source.

> **Status:** pre-release (v0.1.0). The script format may still change before 1.0.

**Samples** (all assets CC0, made for this project): `videos/sample-ko` (Korean presenter +
dialogue line), `videos/sample-dialogue-ko` (two characters, reactions, sound effects),
`videos/sample-en` (English, dark theme, chart and comparison).

## License notes (read before using at work)

- script2video itself is **MIT**.
- Rendering uses **[Remotion](https://www.remotion.dev/)**, which has its own license: free for individuals and organizations of up to 3 people; **larger for-profit organizations need a Remotion Company License**. See [remotion.dev/license](https://www.remotion.dev/docs/license).
- Character generation (optional): **Qwen-Image-Edit-2511** and its Lightning LoRA (Apache-2.0), run with mflux / MLX (MIT). The yaml from `create` records the model and its license.
- Voices: **Qwen3-TTS** (Apache-2.0) and **Supertonic-3** (code MIT, weights OpenRAIL-M). If you publish audio made with Supertonic-3, its license requires disclosing that the content is machine-generated.
- Some dependencies are copyleft. They are installed on your machine and not redistributed by this project:
  - `soynlp` (GPL-3.0), required by `qwen-asr` in the aligner environment
  - FFmpeg libraries bundled in the PyAV wheel (LGPL), aligner environment
  - `elkjs` (EPL-2.0), pulled in by mermaid for `:::diagram`
  - ffmpeg and SoX on your system (LGPL / GPL depending on the build)

## Requirements

- macOS (Apple Silicon) or Linux
- Node.js 22+, Yarn 4, [uv](https://docs.astral.sh/uv/), ffmpeg
- ~15 GB of disk for models
- Optional, for generating characters: Apple silicon with 48 GB+ of memory and ~85 GB more disk

## Quick start

```sh
yarn install
yarn build

# Python environments and pinned models
(cd tts-server && uv sync) && (cd aligner && uv sync)
(cd tts-server && uv run python scripts/fetch_models.py \
  qwen3-tts-1.7b-customvoice supertonic-3 qwen3-asr-0.6b qwen3-forcedaligner-0.6b)

# Render the sample
node packages/cli/dist/main.js doctor                              # environment check
node packages/cli/dist/main.js lint videos/sample-ko/script.ko.md   # static checks
node packages/cli/dist/main.js check videos/sample-ko/script.ko.md  # subtitle overflow (real layout)
node packages/cli/dist/main.js render videos/sample-ko/script.ko.md --output youtube
node packages/cli/dist/main.js render videos/sample-ko/script.ko.md --output shorts
# → out/sample-ko/youtube.ko.mp4 (+ .srt, .vtt, .chapters.txt, .description.md, .thumbnail.png)
#   out/sample-ko/shorts.ko.mp4
```

## Commands

| command                                                                                                                                | what it does                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`                                                                                                                               | checks Node, ffmpeg, uv, Python environments, models, fonts                                                                                                    |
| `--version [--json]`                                                                                                                   | the version to pin: semver plus a hash of the code (`--json` for tools)                                                                                        |
| `new <dir> [--lang ko]`                                                                                                                | a new video folder with a starter script                                                                                                                       |
| `lint <script>`                                                                                                                        | static checks: syntax, assets (pictures PNG/JPEG by their bytes, `::video` mp4/webm/mov/m4v), pronunciation, subtitle budget, length                           |
| `check <script>`                                                                                                                       | lays every subtitle out in the real renderer and reports overflow                                                                                              |
| `sentences <script>`                                                                                                                   | sentence ids (for `tts --retry`)                                                                                                                               |
| `say "<text>" --script <script>`                                                                                                       | synthesize and play one sentence (pronunciation check)                                                                                                         |
| `tts <script> [--retry id]`                                                                                                            | synthesize into the audio lock (only what changed)                                                                                                             |
| `render <script> --output <name> [--draft] [--frozen-audio] [--idle on\|off] [--rhythm on\|off] [--out-dir <dir>] [--watermark proxy]` | video + `.srt` `.vtt` chapters, description draft, thumbnail                                                                                                   |
| `snapshot <script> --output <name> [--rhythm on\|off] [--out-dir <dir>] [--frozen-audio] [--frames]`                                   | one still per scene, tiled, in seconds; `--frames`: every change of picture as its own still, with an `index.json`                                             |
| `direct <script> [--output <name>] [--rhythm on\|off] [--no-open] [--out-dir <dir>]`                                                   | direction plan and director notes as a page (`out/<video>/direct/`); no audio needed                                                                           |
| `dev <script> [--video]`                                                                                                               | edit loop: lint → tts → snapshot on every save                                                                                                                 |
| `takes <script> [--all] [--id id] [--no-open] [--out-dir <dir>]`                                                                       | a listening page (`out/<video>/takes/<lang>/`): every take of each line, alone or between its neighbours; the radios write the `takes pick` / `unpick` command |
| `takes <script> --list [--id id]`                                                                                                      | the takes of each line: take wav, pass/fail, pitch, pace                                                                                                       |
| `takes pick <script> <id>=<n> …` / `takes unpick <script> <id> …`                                                                      | choose a take yourself (not `pick <image>`)                                                                                                                    |
| `pick <image>`                                                                                                                         | click / drag on a screenshot to get cue coordinates                                                                                                            |
| `voice create / pick`                                                                                                                  | design a persona voice and pick a candidate                                                                                                                    |
| `voice check <voices/id.yaml>`                                                                                                         | judge a persona's reference clip (noise, pauses, cut ending, pitch)                                                                                            |
| `voice train <voices/id.yaml> [--lang ko] [--min-emotion N]`                                                                           | train a persona's speaker so it acts emotions (about 3 hours, resumable)                                                                                       |
| `voice refs <script> [--refresh]`                                                                                                      | reference voices the sentences are checked against                                                                                                             |
| `audio prune <script>`                                                                                                                 | remove audio the script no longer uses                                                                                                                         |
| `inspect <script> --json`                                                                                                              | what a script is made of, with one hash per kind of change (tooling)                                                                                           |
| `export-script <script>`                                                                                                               | a reading script for recording the narration yourself                                                                                                          |
| `import-recording <script> <take.wav> [--write]`                                                                                       | split one recorded take into paragraphs (`:audio`)                                                                                                             |
| `tts-server start`                                                                                                                     | keep the TTS server running between commands                                                                                                                   |
| `character import / setup / create / pick / build / review / approve / redo / missing`                                                 | character art: YMM4 import and generation (see below)                                                                                                          |

Run them as `node packages/cli/dist/main.js <command> …`. `S2V_TTS=mock` runs everything with
synthetic audio (no models), useful for layout work and CI.

Each command takes only its own flags; an unknown one is an error (exit 2). A sentence for `say`
that starts with `-` goes after `--`. `--version --json` gives `id` (semver + a hash of the code
and fixed data s2v runs, uncommitted changes included): tools pin `id` and stop when it changes.
`stale_build` says a package's `dist` is older than its source (run `yarn build`). `inspect`'s
`s2v_version` is the same `id`.

Results go to `out/<script folder>/` (render, snapshot, the `direct` and `takes` pages).
`--out-dir <dir>` puts them in `<dir>` instead, with the same names below it: a render writes
exactly `<output>.<lang>[.draft].{mp4,srt,vtt,description.md}` plus `.chapters.txt` and
`.thumbnail.png` when it makes them, and removes those two when it does not (files of other outputs,
of the draft or not, and snapshots are left alone); when it exits non-zero, the set is
undefined. Two script folders with the same name share `out/<name>/` unless given their own
`--out-dir`. Run one render or snapshot of the same script, output and language at a time (they
share a work folder). `.s2v-cache/` can be deleted at any time; its `render/`, `draft-audio/` and
`check/` folders are keyed `<script folder>-<hash>`, and folders without the hash are from older
versions. `*.tmp.*` files in a results folder are left by an interrupted run. `dev` watches the script
folder: keep `--out-dir` outside it.

`render --watermark proxy` puts a red PROXY band on the video and the thumbnail and names the
results `<output>.<lang>[.draft].proxy.*`, so they never replace unmarked ones (tools mark a render
no person has approved). The band sits in the top corner away from the logo (the bottom one when
subtitles are on top). It re-encodes the video once more (minutes for a long 1080p video); the
scene cache is shared with unmarked renders, so run one of the two at a time. The text files are
the same as the unmarked ones. With characters and subtitles on top, the band in the bottom corner
may cover a character's feet.

`snapshot --frames` writes `<output>.<lang>.frames/` beside the sheet: a full-size still at every
point the picture changes (the first visual settled, each visual and cue, a character's face and
its return to the default, stage switches, held motions), at most 12 a scene, numbered over the
video, and `index.json` with each still's scene, frame, second and reasons plus the s2v id and the
script's sha256. Stills show characters at rest: no breathing, blinking or nodding. A run removes
last run's sheet and stills first; without `--frames` the stills folder is left as it is.
`--frozen-audio` uses the audio lock as it is and fails if a line has none. `script_sha256` covers
the script only, not its assets or character art; an interrupted run may leave `<…>.frames.tmp/`.

`inspect --json` is for tools that review videos: it lists outputs, scenes, screen text, voices
and files, and gives one hash per kind of change (`content`, `voice`, `audio`, one
`presentation` per output, and the `engine` parts), so a reviewer re-checks only what changed. It
refuses scripts with anything the format does not know (a misspelled attribute, a directive
where it would be shown as text). A hash it cannot compute is `null` with a reason. Compare
`engine` part by part; a new key in `defaults_*` comes from a new s2v field and changes no
script hash.

## Writing scripts

The full syntax is in [`.claude/skills/write-script/reference.md`](.claude/skills/write-script/reference.md).
With [Claude Code](https://claude.com/claude-code) in this repository, the `write-script` skill
turns a blog post or document into a script, translates scripts, cuts Shorts and converts solo ↔
dialogue; it follows the same reference and runs `lint` / `check` on the result.

Visuals: `::title`, `::image` (zoom, circle / box / highlight / spotlight / arrow marks, image
switches, slow Ken Burns drift), `:::bullets`, `:::code` (line highlight), `:::table` (row
highlight), `:::chart` (bars), `:::compare` (2–3 columns), `:::gallery`, `:::quote`, `:::markdown`, `:::split` (image + text), `:::diagram` (mermaid), `::video`.
Sound: background music ducked under speech, synthesized sound effects (`sfx: auto`), scene
fades. Look: `theme: light | dark`, corner logo, `subtitleStyle` (size, position, colors, font).

## Dialogue and persona voices

Any number of speakers: define them under `cast:` and start a paragraph with `name:`.
With `layout: dialogue`, 2–4 speakers get avatars (the speaker is highlighted) and every subtitle
gets a colored name tag; with 5 or more, only name tags are shown.

A persona is a voice designed from a description, for extra speakers beyond the preset ones:

```sh
# voices/minsu.yaml  (next to the script, or in any folder above it up to the repository root to share it)
#   description: 30대 남성, 차분하고 약간 낮은 목소리, 또렷한 발음, 친근한 말투
node packages/cli/dist/main.js voice create voices/minsu.yaml --lang ko --candidates 4
# → candidates checked and listed passing first, with a listening page; then pick one:
node packages/cli/dist/main.js voice pick voices/minsu.yaml 2 --lang ko
```

Then use `voice: "persona:minsu"` in `cast:`. Every sentence clones the picked clip, so the voice
stays the same. Designed voices imitate no real person.

A clone copies the clip's noise, rhythm and ending, so candidates are checked: read without
mistakes, a pitch that fits the described gender (`남성`/`male`/`男性` or `여성`/`female`/`女性`), a
quiet noise floor, pauses between the sentences and an ending that is not cut. Breaths are kept.
`voice check voices/minsu.yaml` runs the same checks on a clip you already use (on a finished clip
whose raw output is gone, noise and ending are not judged).

**A persona that acts.** A cloned persona cannot follow emotion instructions. `s2v voice train
voices/minsu.yaml --lang ko` trains one speaker row of the Qwen3-TTS CustomVoice model from the
persona's voice (about 3 hours: it makes and checks its own training clips, then trains; run it
again to resume, and never while characters are being generated). It writes
`voices/minsu/ko.speaker.json` and its voice reference: commit them, then set `personaModel: trained`
on the cast. The trained speaker takes `emo`, `say` and `style` like a preset speaker, and a strong
line says "Sound very …". On the sample guest, `power=strong` sounded happy more often than the plain
emotion for `happy` and `excited`, and an `excited` line sometimes sounded angry — listen on the takes
page and try `power=strong` or no `emo` there. If fewer than 150 emotion clips pass
its checks, it stops before the second training (`--min-emotion` sets the bar). Korean only for now.

**Same voice in every sentence.** Each voice (a persona, a preset speaker with its `style`, a
Supertonic voice) has a reference: 20 takes of fixed sentences, measured once and committed
(`voices/<id>/<lang>.f0.json`, `voices/_qwen/…`, `voices/_supertonic/…`). `tts` makes a missing
one (a few minutes; the check loads the Base model next to the voice's model, about 4 GB more) and checks every new take against it: its pitch and its voice similarity
(the speaker encoder of the Qwen3-TTS Base model). A take that drifts is made again with another
seed, up to 6 takes. Sentences already in the audio lock are not checked again unless you run
`tts --recheck`. `voice refs <script>` shows the references and, after `--refresh`, lists the locked
sentences that would now fail.

### Acting a line

Give a line an emotion in the speaker prefix: `mina{emo=sad}: 그럴 줄 알았어.` Emotions:
`neutral happy sad angry surprised anxious excited calm serious puzzled moved playful`, or your own
under `acting.emotions` in the frontmatter (`sleepy: { voice: "Sound drowsy and slow.", face: calm,
speed: 0.8, maxPause: 1.5 }`). An emotion picks the voice (Qwen preset speakers follow an instruction
for it), the character's face of that name when the character has one (else the default face; `s2v
character missing` lists the faces to make) and a motion. Change it from a sentence on with
`:emo{emo=sad}`, between sentences: `mina{emo=calm}: 괜찮았어요. :emo{emo=sad}그런데요.`

| attribute           |                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `emo=`              | the emotion                                                                                                                                                                                                                    |
| `power=weak/strong` | how strong (Qwen preset speakers and trained personas with an emotion: the weakest / strongest take, and a trained persona's strong line says "Sound very …"; cloned persona and Supertonic voices: a little quieter / louder) |
| `say="…"`           | a free direction for this line (Qwen preset speakers only)                                                                                                                                                                     |
| `volume=soft/loud`  | −6 / +3 dB in the mix                                                                                                                                                                                                          |
| `speed=0.8–1.25`    | multiplied with the cast `speed`                                                                                                                                                                                               |

Write emotions on lines whose words already carry them: an instruction cannot make a neutral
sentence sound happy. Cloned persona and Supertonic voices cannot act an emotion (the face and motion
still change); a trained persona can. New takes of emotion lines in Korean are checked for breaths, sighs, long pauses and an
unnatural length, and made again when they fail. Lines without these attributes sound as before.

**Takes of an emotion line.** For an emotion line of a Qwen preset speaker, `tts` makes 3 takes,
and more (up to 6) until two pass — for happy, excited, playful, angry and moved lines also until
one ends without its voice falling. It keeps one by how strongly it acts: around the middle, the
weakest for calm, sad, serious and moved, or as `power` asks. When the sentence right before in the
paragraph has the same emotion, power, speed and `say`, it leans toward the take closest to it in
pitch and pace. A sentence already in the audio lock keeps its take; `tts --retry <id>` makes 3 new
takes after all earlier ones and keeps the locked take when none passes. `tts` prints an estimate of
the time first.

**Choosing a take yourself.** `s2v takes <script>` opens a listening page: every take of each
emotion line and of each line you picked (`--all`: every line) plays alone or between the lines around it, at the level the
video will have, and the radios you set become the `s2v takes pick …` (and `unpick`) command to copy. It starts no
server. `s2v takes <script> --list` prints the same takes as text with the path of each wav; `s2v takes pick <script> 1:0:2=3 1:2:0=1` keeps
take 3 of `1:0:2` and take 1 of `1:2:0`, and the next `tts` puts them into the audio lock. Picks
are saved in `audio/<lang>/picks.json` next to the lock: commit it. A pick stays when only speed (Qwen and
persona voices; for Supertonic speed is part of the voice),
pauses or post-processing change, and stops applying when the line's text, voice, acting or `power`
changes (`tts` says which line, with the old and the new text). `tts --retry <id>` writes its choice
as a pick too; a retry of a whole scene leaves the lines you picked alone. `s2v takes unpick
<script> <id>` goes back to the automatic choice, and `audio prune` removes picks no line uses.

**Director notes.** `s2v direct <script> [--output youtube]` writes a page
(`out/<video>/direct/<output>.<lang>.html`) with the plan of one output: each paragraph's time,
speaker, emotions, face and motion, looks and reactions, and the gap before it (with the rhythm
rules). It needs no audio: lines already synthesized for the current script use their real length,
the rest are estimated (marked `~`). Notes at the top say what to try where a video is likely to
look flat — no emotion at all in a long dialogue, the same emotion many paragraphs in a row, one
speaker talking for many paragraphs, half a minute without a listener reacting (only with characters and idle
motion off), and happy or excited lines of a trained persona. They are advice, not errors.

### Characters

Give a speaker character art and it stands in the bottom-left or bottom-right corner. One
character stands on each side at a time (speakers of a side take turns), so at most two are on
screen. The speaker is lit, the mouth follows the voice, idle characters blink, and the subtitle moves next
to the speaker with a tail. Without character art, subtitles stay centered.

```yaml
cast:
  mina: { voice: 'qwen:Sohee', character: characters/mina, side: left }
  joon: { voice: 'persona:joon', character: { dir: characters/joon, facing: right } }
```

Pick a face per paragraph: `mina{face=happy}: 정말요?`. A face change also plays a short
motion (surprised → jump, happy → bounce, angry → shake, sad → sink); choose one with
`motion=nod` (jump, shake, nod, bounce, shiver, sink, lean), skip it with `motion=none`, or set
`motion: off` on the cast member. Make listeners react from a word on:
`mina: :react{joon=surprised}와, 정말요?` (held to the end of the paragraph). Reacting
characters come on stage even when they share a side: several of a side stand together, smaller,
for as long as the reaction lasts (`:react{joon=surprised yuna=surprised}`).

Choose where a character looks with `:look{mina=viewer}`: `partner` (the default stance, turned a
little toward the other speaker), `viewer` (facing the audience, the `front-<face>` image) or
`glance` (body to the audience, head toward the partner, `glance-<face>` — pairs with `viewer`). The
speaker's own `:look` at a sentence's start changes that sentence (inside a sentence, the next one);
a listener's lasts from that word to the end of the paragraph, or until its next `:look`
(`partner` turns back). Generated characters (`preset: standard@1`) have these images; a classic
folder needs `front-happy.png` and so on, otherwise the face stays as it is (lint says so). Looks
work in the head close-up too: a generated character's `partner` and `glance` are the same picture
there (the head turned toward the partner, no body shows) and `viewer` faces the audience; a classic
folder uses its `front-<face>.png` and `glance-<face>.png` as in the full framing.

A character can walk on and off: `::enter{joon}` before a scene's first paragraph slides joon in
from its side as the scene starts (when joon has the scene's first line, the line waits for the
slide), and `::exit{joon}` slides joon out once everything in the scene and its face hold are over
(the scene is lengthened to show it); that side then stays empty until its next speaker. Several
names go in one directive (`::enter{joon yuna}`). The entering character must be the first of its
side to speak in that scene, otherwise the entrance is ignored. Only characters that speak or
react in the output can enter or exit, and only with character images. An output that leaves scenes
out may break the order (an exited character speaks again): lint warns and the character steps in
as usual.

```md
::enter{joon}
joon: Sorry I'm late.
```

Characters also move a little on their own: they breathe, blink every 2–6 seconds (and when their
face changes), and a listener sometimes nods at the end of the other side's sentence (not after a
question, nor right before answering). Set `acting: { idle: false }` in the frontmatter to turn this
off (blinks then come once every 4 seconds), or try either way with `s2v render … --idle on|off`. Snapshots and thumbnails never blink.

Gaps between paragraphs follow the content (rhythm): an answer to another speaker's question comes
sooner (×0.6, a question is a line ending in `?`), a paragraph whose emotion differs from the one
before takes a breath (×1.3), a sad, moved or serious paragraph is followed by a pause (×1.4), and
each of these gaps varies a little (±12%). Gaps you write (`gap=`), pauses, scene gaps and gaps
between sentences stay as they are, nothing carries over a scene boundary (a sad last paragraph
keeps the usual scene gap), and the audio does not change. A paragraph's emotion is its `emo` (or
an `:emo` at its very start). Rhythm is on by default; `acting: { rhythm: false }` keeps every gap
even (as before — use it to render an older video again exactly), and an object sets the factors:
`acting: { rhythm: { answer: 0.8, emotion: 1.2, linger: 1.6, jitter: 0 } }` (any of them). Set it
per output with `outputs.shorts.rhythm` (`false`, or factors over the script's), or try it with
`s2v render|snapshot|timeline … --rhythm on|off` (`timeline` then lists each gap and its rules on
stderr).

A character folder comes in one of two forms.

**Whole images.** Transparent PNGs on **one shared canvas** (same size, same body position), per
face. `facing` is the way the art looks (`left` / `right` / `front`); art facing the frame edge is
mirrored to face the center.

| file                                                      |                                                  |
| --------------------------------------------------------- | ------------------------------------------------ |
| `neutral.png`                                             | mouth closed (required; the default face)        |
| `neutral-talk.png`                                        | mouth open (the mouth moves only if this exists) |
| `neutral-half.png`                                        | mouth half open (optional, smoother)             |
| `neutral-blink.png`                                       | eyes closed (optional)                           |
| `happy.png`, `sad.png`, `surprised.png`, … (+ `-talk`, …) | other faces                                      |

**Layered parts** (a `character.yaml` in the folder). A body, a head and mouth / eye parts,
composed at render time. A face is a combination you name in the yaml: a view (body angle), an
optional pose, an optional head turn and an expression. The head moves on its own
(`head-nod`, `head-tilt`), so listening and thinking look alive. Generated and hand-drawn
characters use this form. YMM4 material also gets a `character.yaml`, where a face picks one
image per part folder; it is drawn full-length and without head motions:

```sh
# YMM4 "動く立ち絵" material (a folder or a zip); the files are copied with their terms of use
node packages/cli/dist/main.js character import ~/Downloads/zundamon.zip --out characters/zunda
# → characters/zunda/character.yaml (a draft; parts.html shows every part to build faces from)
```

**Framing.** A generated or hand-drawn layered character can be drawn full-length (`full`, the
default), from the waist up (`upper`) or as a head close-up (`head`), chosen per scene. Put
`::shot` before the scene's first paragraph; characters not named keep the previous scene's
framing:

```markdown
# Close-up {#how}

::shot{mina=head joon=upper}
```

`::shot{mina=full}` goes back. `shot: full` on an output (`outputs.shorts.shot: full`) ignores
`::shot` there. Each framing needs its own images (a `sets.upper` / `sets.head` set in the yaml);
`lint` reports a face a scene uses that its framing does not have.

### Generating a character (optional, Apple silicon)

script2video can draw an original layered character with a local image-editing model
(Qwen-Image-Edit-2511 with an 8-step Lightning LoRA, both Apache-2.0, run with MLX). Everything
is made from **one front image you choose**, as edits of it, so the character stays the same. You
approve each round before the next one starts.

Needs a Mac with Apple silicon, **48 GB of memory or more** (64 GB recommended: preparing the
model peaks near 32 GB, generating near 22 GB) and **about 85 GB of disk** (`S2V_MODELS_DIR`
moves the models to another disk). About 4 minutes per image.

```sh
node packages/cli/dist/main.js character setup        # environment, download, 4-bit model (once)

# 1. a folder with character.yaml: describe the design in `kind`
node packages/cli/dist/main.js character create characters/mina --candidates 4
#    → four front images to choose from (a review page opens)
node packages/cli/dist/main.js character pick characters/mina 2

# 2. the rest, round by round: references → body → poses → expressions → mouth and eye frames
node packages/cli/dist/main.js character build characters/mina --dry-run   # what the next round makes
node packages/cli/dist/main.js character build characters/mina
#    → a review page: every image with its checks and a lip-sync preview
node packages/cli/dist/main.js character approve characters/mina --all     # passed checks only
node packages/cli/dist/main.js character redo characters/mina front/base/happy   # another seed
```

`preset: standard@1` (in the yaml from `create`) is a ready set of faces:

- `neutral`, `happy`, `sad`, `angry`, `surprised`, `anxious`, `excited`, `calm`, `serious`,
  `puzzled`, `moved`, `playful`: turned a little toward the other speaker (the usual stance in a
  dialogue)
- `front-<expression>`: facing the viewer (talking to the audience)
- `glance-neutral`, `glance-surprised`, `glance-happy`, `glance-puzzled`: only the head turns
- `wave`, `point`, `akimbo`, `cheer`, `arms-crossed`, `hands-together`: poses
- a head close-up set with every face above: turned faces and glances turn the head, poses show
  their expression

`exclude: [angry, point]` leaves parts out; your own `faces:`, `expressions:` and `sets:` add to
or replace the preset's. Generating the whole set takes about 220 images (15–16 hours, once); the
character is then a library. When a script needs a face the library lacks:

```sh
node packages/cli/dist/main.js character missing videos/demo/script.ko.md [--apply]
# → what is not defined, not in a framing's set (--apply adds it) or not approved yet
```

Only what changed is made again: images are recorded with the definition they were made for
(`provenance.json`), so a stopped round resumes and an edited prompt remakes only its images.
Generation refuses to start while the TTS or aligner server is running (each needs tens of GB),
and a watchdog stops it before memory runs out.

## Reproducible renders (Docker)

TTS runs on the host (it needs the models, and MPS on macOS). Its result is locked in
`audio/<lang>/` next to the script, and the image renders from that lock with no network:

```sh
docker build -t script2video-render .
docker run --rm --network none -v "$PWD/videos:/videos" -v "$PWD/out:/app/out" \
  script2video-render render /videos/sample-ko/script.ko.md --output youtube
```

The same image and audio lock give byte-identical output. Output from macOS and from Docker
differs (font rasterization and the ffmpeg build), so compare renders within one environment.
The image is for local use. Do not publish it, because it contains GPL-licensed ffmpeg from Debian.

## Script format (a taste)

```markdown
---
lang: ko
cast:
  host: { voice: 'qwen:Sohee', style: '차분하고 친근하게' }
  mina: { voice: 'supertonic:F1' }
outputs:
  youtube: { aspect: '16:9', layout: presenter }
  shorts: { aspect: '9:16', layout: shorts, scenes: [settings] }
pronounce:
  CLI: 씨엘아이
---

# Settings {#settings}

::image{src=assets/settings.png}

오른쪽 위의 :cue[설정 버튼]{x=0.957 y=0.025 zoom=3 mark=circle}을 누르면 :pause[0.4]
새 프로젝트를 만들 수 있습니다.

mina: 정말 대본만 쓰면 되나요?
```

- `# heading {#id}` starts a scene (and a YouTube chapter); `::image` / `::title` / `:::bullets` set the visual.
- `:cue[phrase]{...}` zooms / marks the moment that phrase is spoken.
- `name:` at the start of a paragraph picks the speaker; voices can mix engines.
- More: [reference](.claude/skills/write-script/reference.md).
