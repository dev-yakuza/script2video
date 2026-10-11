/** `s2v new <dir> [--lang ko]`: a video folder with a script that passes lint and renders. */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Lang } from '@script2video/core';

const VOICE: Record<Lang, string> = { ko: 'qwen:Sohee', ja: 'qwen:Ono_Anna', en: 'qwen:Ryan' };

const BODY: Record<Lang, (title: string) => string> = {
  ko: (t) => `# ${t} {#intro}

::title[${t}]

안녕하세요. 오늘은 ${t}에 대해 알아보겠습니다.

# 본문 {#main}

:::bullets
- 첫 번째 요점
- 두 번째 요점
:::

:cue[첫 번째 요점]{highlight=0}을 먼저 설명합니다.
그다음 :cue[두 번째 요점]{highlight=1}을 살펴봅니다.

# 정리 {#outro}

::title[정리]

오늘 내용을 정리했습니다. 시청해 주셔서 감사합니다.
`,
  ja: (t) => `# ${t} {#intro}

::title[${t}]

こんにちは。今日は${t}について説明します。

# 本題 {#main}

:::bullets
- 一つ目のポイント
- 二つ目のポイント
:::

まず:cue[一つ目のポイント]{highlight=0}を説明します。
次に:cue[二つ目のポイント]{highlight=1}を見ていきます。

# まとめ {#outro}

::title[まとめ]

以上です。ご視聴ありがとうございました。
`,
  en: (t) => `# ${t} {#intro}

::title[${t}]

Hi. Today we'll look at ${t}.

# Main points {#main}

:::bullets
- The first point
- The second point
:::

Let's start with :cue[the first point]{highlight=0}.
Then we'll look at :cue[the second point]{highlight=1}.

# Wrap-up {#outro}

::title[Wrap-up]

That's all for today. Thanks for watching.
`,
};

export function scaffold(dir: string, lang: Lang): string {
  const script = join(dir, `script.${lang}.md`);
  if (existsSync(script)) throw new Error(`${script} already exists`);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  // A placeholder in the script's language (a folder name in English would be read as English).
  const title =
    lang === 'en'
      ? basename(dir).replace(/[-_]+/g, ' ')
      : lang === 'ja'
        ? '動画のタイトル'
        : '영상 제목';
  writeFileSync(
    script,
    `---
title: ${title}
lang: ${lang}
cast:
  host: { voice: "${VOICE[lang]}" }
outputs:
  youtube: { aspect: "16:9", layout: presenter }
  shorts: { aspect: "9:16", layout: shorts, scenes: [main], maxDuration: 60 }
pronounce: {}
---

${BODY[lang](title)}`,
  );
  return script;
}
