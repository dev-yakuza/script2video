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

| command                                                                                | what it does                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `doctor`                                                                               | checks Node, ffmpeg, uv, Python environments, models, fonts           |
| `new <dir> [--lang ko]`                                                                | a new video folder with a starter script                              |
| `lint <script>`                                                                        | static checks: syntax, assets, pronunciation, subtitle budget, length |
| `check <script>`                                                                       | lays every subtitle out in the real renderer and reports overflow     |
| `sentences <script>`                                                                   | sentence ids (for `tts --retry`)                                      |
| `say "<text>" --script <script>`                                                       | synthesize and play one sentence (pronunciation check)                |
| `tts <script> [--retry id]`                                                            | synthesize into the audio lock (only what changed)                    |
| `render <script> --output <name> [--draft] [--frozen-audio]`                           | video + `.srt` `.vtt` chapters, description draft, thumbnail          |
| `snapshot <script> --output <name>`                                                    | one still per scene, tiled, in seconds                                |
| `dev <script> [--video]`                                                               | edit loop: lint → tts → snapshot on every save                        |
| `pick <image>`                                                                         | click / drag on a screenshot to get cue coordinates                   |
| `voice create / pick`                                                                  | design a persona voice and pick a candidate                           |
| `voice check <voices/id.yaml>`                                                         | judge a persona's reference clip (noise, pauses, cut ending, pitch)   |
| `voice refs <script> [--refresh]`                                                      | reference voices the sentences are checked against                    |
| `audio prune <script>`                                                                 | remove audio the script no longer uses                                |
| `inspect <script> --json`                                                              | what a script is made of, with one hash per kind of change (tooling)  |
| `export-script <script>`                                                               | a reading script for recording the narration yourself                 |
| `import-recording <script> <take.wav> [--write]`                                       | split one recorded take into paragraphs (`:audio`)                    |
| `tts-server start`                                                                     | keep the TTS server running between commands                          |
| `character import / setup / create / pick / build / review / approve / redo / missing` | character art: YMM4 import and generation (see below)                 |

Run them as `node packages/cli/dist/main.js <command> …`. `S2V_TTS=mock` runs everything with
synthetic audio (no models), useful for layout work and CI.

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

| attribute           |                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `emo=`              | the emotion                                                                                                                               |
| `power=weak/strong` | how strong (Qwen preset speakers with an emotion: the weakest / strongest take; persona and Supertonic voices: a little quieter / louder) |
| `say="…"`           | a free direction for this line (Qwen preset speakers only)                                                                                |
| `volume=soft/loud`  | −6 / +3 dB in the mix                                                                                                                     |
| `speed=0.8–1.25`    | multiplied with the cast `speed`                                                                                                          |

Write emotions on lines whose words already carry them: an instruction cannot make a neutral
sentence sound happy. Persona and Supertonic voices cannot act an emotion (the face and motion still
change). New takes of emotion lines in Korean are checked for breaths, sighs, long pauses and an
unnatural length, and made again when they fail. Lines without these attributes sound as before.

**Takes of an emotion line.** For an emotion line of a Qwen preset speaker, `tts` makes 3 takes,
and more (up to 6) until two pass — for happy, excited, playful, angry and moved lines also until
one ends without its voice falling. It keeps one by how strongly it acts: around the middle, the
weakest for calm, sad, serious and moved, or as `power` asks. When the sentence right before in the
paragraph has the same emotion, power, speed and `say`, it leans toward the take closest to it in
pitch and pace. A sentence already in the audio lock keeps its take; `tts --retry <id>` makes 3 new
takes after all earlier ones and keeps the locked take when none passes. `tts` prints an estimate of
the time first.

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
- a head close-up set with `neutral`, `happy`, `sad`, `surprised`, `moved`, `serious`

`exclude: [angry, point]` leaves parts out; your own `faces:`, `expressions:` and `sets:` add to
or replace the preset's. Generating the whole set takes about 150 images (10–11 hours, once); the
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
