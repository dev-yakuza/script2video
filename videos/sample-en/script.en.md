---
title: script2video English sample
lang: en
cast:
  host: { voice: "qwen:Ryan", style: "calm, friendly explainer" }
outputs:
  youtube: { aspect: "16:9", layout: presenter }
  shorts: { aspect: "9:16", layout: shorts, scenes: [numbers] }
theme: dark
sfx: auto
---

# From script to video {#intro}

::title[From a script to a narrated video]

Hi. This whole video was made from one Markdown file.
The narration, subtitles and visuals all come from the script.

# The numbers {#numbers}

:::chart{unit=s}
| step | time |
| --- | --- |
| Synthesis | 61 |
| Rendering | 19 |
| Re-render | 2 |
:::

Synthesizing the voice is the slowest part, at :cue[about a minute]{row=1}.
Rendering takes :cue[under twenty seconds]{row=2}, and :cue[a re-render]{row=3} reuses every finished scene.

# Compare {#compare}

:::compare
### Video editor
- Record and cut by hand
- Redo everything for a fix
### script2video
- Write a script
- Fix one sentence, render again
:::

With :cue[a video editor]{highlight=0}, a small fix means another session.
With :cue[a script]{highlight=1}, you change a sentence and render again.
