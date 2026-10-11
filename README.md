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

| command                                                      | what it does                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `doctor`                                                     | checks Node, ffmpeg, uv, Python environments, models, fonts           |
| `new <dir> [--lang ko]`                                      | a new video folder with a starter script                              |
| `lint <script>`                                              | static checks: syntax, assets, pronunciation, subtitle budget, length |
| `check <script>`                                             | lays every subtitle out in the real renderer and reports overflow     |
| `sentences <script>`                                         | sentence ids (for `tts --retry`)                                      |
| `say "<text>" --script <script>`                             | synthesize and play one sentence (pronunciation check)                |
| `tts <script> [--retry id]`                                  | synthesize into the audio lock (only what changed)                    |
| `render <script> --output <name> [--draft] [--frozen-audio]` | video + `.srt` `.vtt` chapters, description draft, thumbnail          |
| `snapshot <script> --output <name>`                          | one still per scene, tiled, in seconds                                |
| `dev <script> [--video]`                                     | edit loop: lint → tts → snapshot on every save                        |
| `pick <image>`                                               | click / drag on a screenshot to get cue coordinates                   |
| `voice create / pick`                                        | design a persona voice and pick a candidate                           |
| `audio prune <script>`                                       | remove audio the script no longer uses                                |
| `export-script <script>`                                     | a reading script for recording the narration yourself                 |
| `import-recording <script> <take.wav> [--write]`             | split one recorded take into paragraphs (`:audio`)                    |
| `tts-server start`                                           | keep the TTS server running between commands                          |

Run them as `node packages/cli/dist/main.js <command> …`. `S2V_TTS=mock` runs everything with
synthetic audio (no models), useful for layout work and CI.

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
# → candidates with pitch / speed / misread hints and a listening page; then pick one:
node packages/cli/dist/main.js voice pick voices/minsu.yaml 2 --lang ko
```

Then use `voice: "persona:minsu"` in `cast:`. Every sentence clones the picked clip, so the voice
stays the same. Designed voices imitate no real person.

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

A character folder holds transparent PNGs on **one shared canvas** (same size, same body
position), per face:

| file                                                      |                                                  |
| --------------------------------------------------------- | ------------------------------------------------ |
| `neutral.png`                                             | mouth closed (required; the default face)        |
| `neutral-talk.png`                                        | mouth open (the mouth moves only if this exists) |
| `neutral-half.png`                                        | mouth half open (optional, smoother)             |
| `neutral-blink.png`                                       | eyes closed (optional)                           |
| `happy.png`, `sad.png`, `surprised.png`, … (+ `-talk`, …) | other faces                                      |

Pick a face per paragraph: `mina{face=happy}: 정말요?`. A face change also plays a short
motion (surprised → jump, happy → bounce, angry → shake, sad → sink); choose one with
`motion=nod` (jump, shake, nod, bounce, shiver, sink, lean), skip it with `motion=none`, or set
`motion: off` on the cast member. Make listeners react from a word on:
`mina: :react{joon=surprised}와, 정말요?` (held to the end of the paragraph). Reacting
characters come on stage even when they share a side: several of a side stand together, smaller,
for as long as the reaction lasts (`:react{joon=surprised yuna=surprised}`). `facing` is the way the art looks
(`left` / `right` / `front`); art facing the frame edge is mirrored to face the center.

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
