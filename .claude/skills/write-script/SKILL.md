---
name: write-script
description: Write or convert a script2video script (Markdown → narrated video). Use when the user wants a video script from a blog post, doc or notes; a translation of an existing script (ko/ja/en); a Shorts cut; or a solo script turned into a dialogue (or back). Produces script.<lang>.md that passes `s2v lint`.
---

# Writing a script2video script

A script is one Markdown file per language: `videos/<id>/script.<lang>.md` (or any folder; asset,
voice and character paths are relative to the script). The syntax is in
[reference.md](reference.md). Read it before writing.

## Workflow

1. **Read the source** (blog post, doc, notes) and the images it uses. Decide the video's one
   promise ("after this, you can …") and cut everything that does not serve it.
2. **Plan scenes** (`# Title {#id}`): one idea per scene, 20–90 s each. Scene titles become
   YouTube chapters, so keep them short and meaningful; aim for 3+ scenes of 10+ s.
3. **Pick a visual per scene**: a screenshot from the source (`::image`), code (`:::code`), a
   list (`:::bullets`), a table (`:::table`), a quote (`:::quote{by=...}`) or a title card
   (`::title`). Prefer the source's own screenshots: the
   narration points at them with `:cue`.
4. **Write the narration for the ear**, not the eye:
   - Short sentences (ko ≤ 40 chars, ja ≤ 45, en ≤ 20 words). One idea per sentence.
   - Spoken style: ko 해요체/합니다체 consistently; ja です・ます; en contractions are fine.
   - No URLs, file paths, long numbers or symbols read aloud; say what they mean instead and
     show the exact text on screen (code block, screenshot).
   - Spell out what the listener cannot see ("the second domain", not "this").
5. **Add cues** where the narration refers to something on screen:
   - Screenshots: `:cue[phrase]{x=… y=… zoom=… mark=circle|box}`. Coordinates are 0–1 of the
     image. Ask the user to run `s2v pick <image>` (click/drag, copies the attributes) rather
     than guessing coordinates; if you must guess, say so.
   - Code: `:cue[phrase]{line=3}` or `line=2-4`. Bullets: `:cue[phrase]{highlight=0}` (0-based).
6. **Pronunciation**: every English term, product name or abbreviation in a ko/ja script goes
   into `pronounce:` (lint lists the ones still missing as `unread-word`) with how it should be read (`Preload: 프리로드`, `CLI: 씨엘아이`). Numbers
   with units are fine as digits in Korean (they are read out). When unsure how a word will be
   read, suggest `s2v say "<sentence>" --script <script>` to listen.
7. **Outputs**: `youtube` (16:9) always; add `shorts` (9:16, `scenes: [...]`, `maxDuration: 60`)
   with the 1–2 scenes that stand alone (a hook or a result). Use `:only{youtube}` on paragraphs
   that make no sense in the Short.
8. **Check**: run `node packages/cli/dist/main.js lint <script>` and fix every error; then
   `… check <script>` (subtitle overflow). If the user gave a target length, set
   `targetDuration` (seconds): lint warns when the estimated length is off by more than 15 %.

## Translations

- Write `script.<lang>.md` next to the original with `translationOf: script.ko.md` in the
  frontmatter. Keep scene ids, visuals and the number and order of cues identical (lint
  compares them); translate the cue phrases so they match the words actually spoken.
- Translate for speech in the target language; do not mirror the source sentence structure.
- Voices: ko `qwen:Sohee`, ja `qwen:Ono_Anna`, en `qwen:Ryan` or `qwen:Aiden` (or a persona with
  a clip for that language: `s2v voice create voices/<id>.yaml --lang <lang>`).
- Rebuild `pronounce:` for the target language (ja: katakana readings).

## Dialogue (2+ speakers)

- Define each speaker under `cast:` with `name:` and `color:`; start paragraphs with `key:`.
- Give every line a reason to exist: question → answer → reaction. Keep turns short (1–3
  sentences); the expert explains, the other asks what the viewer would ask.
- Second and later voices: Korean and Japanese have one preset speaker each, so use personas
  (`voice: "persona:<id>"`, created with `s2v voice create` / `s2v voice pick`). `style:` only
  works with `qwen:` voices.
- With character art (`character:` folders), set faces where the emotion changes
  (`minsu{face=surprised}:`) and listener reactions at the word that triggers them
  (`:react{jiwoo=happy}`). Only use faces that exist as files in the character folder.
- Solo → dialogue: split explanations into an asker and an explainer; keep the cues on the line
  that says the cued words. Dialogue → solo: merge, remove the back-and-forth phrases.

## Don'ts

- Do not invent facts, numbers or screenshots that are not in the source; ask instead.
- Do not imitate a real person's voice or name a persona after a real person.
- Do not put directives the build does not implement (lint reports "not implemented"); use the
  ones in reference.md.
