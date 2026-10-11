# script2video

[English](README.md) | [한국어](README.ko.md) | **日本語**

Markdown で台本を書くと、ナレーション付きの解説動画ができます。韓国語・英語・日本語に対応し、音声はローカルで動くオープンソースの TTS で合成します。話すタイミングに合わせて、自分で撮ったスクリーンショットを拡大・強調できます。同じ台本と同じ環境なら同じ動画になります。1 つの台本から YouTube（16:9）と Shorts（9:16）を作れます。

> **ステータス:** 正式公開前（v0.1.0）。1.0 までは台本の形式が変わる可能性があります。

**サンプル**（素材はすべてこのプロジェクト用に作った CC0）: `videos/sample-ko`（韓国語の進行役 + 会話 1 行）、
`videos/sample-dialogue-ko`（キャラクター 2 人、リアクション、効果音）、`videos/sample-en`（英語、ダークテーマ、チャートと比較）。

## ライセンスについて（業務で使う前にお読みください）

- script2video 自体は **MIT** です。
- レンダリングに使う **[Remotion](https://www.remotion.dev/)** は独自のライセンスです。個人と 3 人以下の組織は無料で、**それより大きい営利組織には Remotion Company License が必要です。** [remotion.dev/license](https://www.remotion.dev/docs/license) を確認してください。
- 音声: **Qwen3-TTS**（Apache-2.0）、**Supertonic-3**（コード MIT、重み OpenRAIL-M）。Supertonic-3 で作った音声を公開するときは、ライセンスにより機械生成コンテンツであることを明示する必要があります。
- 一部の依存関係はコピーレフトです。利用者のマシンにインストールされるだけで、このプロジェクトは再配布しません。
  - `soynlp`（GPL-3.0）: aligner 環境の `qwen-asr` が必要とする
  - PyAV の wheel に同梱された FFmpeg ライブラリ（LGPL）: aligner 環境
  - `elkjs`（EPL-2.0）: `:::diagram` で使う mermaid が依存
  - システムの ffmpeg と SoX（ビルドにより LGPL / GPL）

## 動作環境

- macOS（Apple Silicon）または Linux
- Node.js 22+、Yarn 4、[uv](https://docs.astral.sh/uv/)、ffmpeg
- モデル用のディスク約 15 GB

## クイックスタート

```sh
yarn install
yarn build

# Python 環境とバージョンを固定したモデル
(cd tts-server && uv sync) && (cd aligner && uv sync)
(cd tts-server && uv run python scripts/fetch_models.py \
  qwen3-tts-1.7b-customvoice supertonic-3 qwen3-asr-0.6b qwen3-forcedaligner-0.6b)

# サンプルのレンダリング
node packages/cli/dist/main.js doctor                              # 環境チェック
node packages/cli/dist/main.js lint videos/sample-ko/script.ko.md   # 静的チェック
node packages/cli/dist/main.js check videos/sample-ko/script.ko.md  # 字幕のはみ出し（実際のレイアウト）
node packages/cli/dist/main.js render videos/sample-ko/script.ko.md --output youtube
node packages/cli/dist/main.js render videos/sample-ko/script.ko.md --output shorts
# → out/sample-ko/youtube.ko.mp4 (+ .srt, .vtt, .chapters.txt, .description.md, .thumbnail.png)
#   out/sample-ko/shorts.ko.mp4
```

## コマンド

| コマンド                                                     | 内容                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `doctor`                                                     | Node、ffmpeg、uv、Python 環境、モデル、フォントをチェック    |
| `new <dir> [--lang ko]`                                      | 最初の台本が入った新しい動画フォルダを作る                   |
| `lint <script>`                                              | 静的チェック: 文法、素材、読み、字幕の分量、長さ             |
| `check <script>`                                             | すべての字幕を実際のレンダラーで配置し、はみ出しを確認       |
| `sentences <script>`                                         | 文の id 一覧（`tts --retry` 用）                             |
| `say "<text>" --script <script>`                             | 1 文を合成して再生（読みの確認）                             |
| `tts <script> [--retry id]`                                  | オーディオロックに合成（変わった部分だけ）                   |
| `render <script> --output <name> [--draft] [--frozen-audio]` | 動画 + `.srt` `.vtt` チャプター、概要欄の下書き、サムネイル  |
| `snapshot <script> --output <name>`                          | シーンごとの静止画を並べて数秒で確認                         |
| `dev <script> [--video]`                                     | 編集ループ: 保存のたびに lint → tts → snapshot               |
| `pick <image>`                                               | スクリーンショットをクリック / ドラッグして cue の座標を得る |
| `voice create / pick`                                        | ペルソナ音声を設計し、候補から選ぶ                           |
| `audio prune <script>`                                       | 台本で使わなくなった音声を削除                               |
| `export-script <script>`                                     | ナレーションを自分で録音するための読み原稿を作る             |
| `import-recording <script> <take.wav> [--write]`             | 通しで録音したファイルを段落ごとに分ける（`:audio`）         |
| `tts-server start`                                           | コマンドの間も TTS サーバーを起動したままにする              |

`node packages/cli/dist/main.js <command> …` の形で実行します。`S2V_TTS=mock` を付けると、モデルなしで
合成した仮の音声で全体を動かせるので、レイアウト作業や CI に便利です。

## 台本の書き方

文法の全体は [`.claude/skills/write-script/reference.md`](.claude/skills/write-script/reference.md) にあります。
このリポジトリで [Claude Code](https://claude.com/claude-code) を使うと、`write-script` スキルがブログ記事や
ドキュメントを台本にし、台本を翻訳し、Shorts 用のシーンを選び、1 人語り ↔ 会話形式を変換します。
同じリファレンスに従い、結果に `lint` / `check` を実行します。

ビジュアル: `::title`、`::image`（拡大、circle / box / highlight / spotlight / arrow の表示、画像の切り替え、
ゆっくりした Ken Burns の動き）、`:::bullets`、`:::code`（行の強調）、`:::table`（行の強調）、`:::chart`（棒グラフ）、
`:::compare`（2–3 列）、`:::gallery`、`:::quote`、`:::markdown`、`:::split`（画像 + テキスト）、
`:::diagram`（mermaid）、`::video`。
音: 話している間は自動で小さくなる BGM、合成した効果音（`sfx: auto`）、シーンのフェード。
見た目: `theme: light | dark`、隅のロゴ、`subtitleStyle`（サイズ、位置、色、フォント）。

## 会話とペルソナ音声

話者の数に制限はありません。`cast:` で定義し、段落を `name:` で始めます。
`layout: dialogue` では、話者が 2–4 人ならアバターが表示され（話している人を強調）、すべての字幕に色付きの
名前タグが付きます。5 人以上なら名前タグだけを表示します。

ペルソナは説明文から設計した音声で、プリセットの話者以外に話者を増やすときに使います。

```sh
# voices/minsu.yaml  （台本の隣、または複数の動画で共有するならリポジトリのルートまでの親フォルダのどこかに）
#   description: 30대 남성, 차분하고 약간 낮은 목소리, 또렷한 발음, 친근한 말투
node packages/cli/dist/main.js voice create voices/minsu.yaml --lang ko --candidates 4
# → 音の高さ / 速さ / 読み間違いの目安付きの候補と試聴ページ。その中から 1 つ選びます:
node packages/cli/dist/main.js voice pick voices/minsu.yaml 2 --lang ko
```

その後、`cast:` で `voice: "persona:minsu"` を使います。すべての文が選んだ音声を複製して合成するので、
声が一定に保たれます。設計した音声は実在の人物をまねていません。

### キャラクター

話者にキャラクターの絵を与えると、画面の左下か右下に立ちます。片側に立つのは一度に 1 人だけで
（同じ側の話者は交代で登場）、画面には最大 2 人です。話しているキャラクターは明るく表示され、口は声に
合わせて動き、待機中のキャラクターはまばたきし、字幕はしっぽ付きで話者の隣に移ります。キャラクターの
絵がなければ字幕は中央のままです。

```yaml
cast:
  mina: { voice: 'qwen:Sohee', character: characters/mina, side: left }
  joon: { voice: 'persona:joon', character: { dir: characters/joon, facing: right } }
```

キャラクターのフォルダには、**同じキャンバス**（同じサイズ、同じ体の位置）に描いた透過 PNG を表情ごとに入れます。

| ファイル                                                  |                                            |
| --------------------------------------------------------- | ------------------------------------------ |
| `neutral.png`                                             | 口を閉じる（必須、デフォルトの表情）       |
| `neutral-talk.png`                                        | 口を開ける（このファイルがあると口が動く） |
| `neutral-half.png`                                        | 口を半分開ける（任意、より滑らかに）       |
| `neutral-blink.png`                                       | 目を閉じる（任意）                         |
| `happy.png`, `sad.png`, `surprised.png`, … (+ `-talk`, …) | ほかの表情                                 |

表情は段落ごとに選びます: `mina{face=happy}: 정말요?`。表情が変わると短い動きも付きます
（surprised → jump、happy → bounce、angry → shake、sad → sink）。`motion=nod` で動きを選ぶ
（jump、shake、nod、bounce、shiver、sink、lean）、`motion=none` で外す、または出演者に `motion: off` を
指定できます。聞き手は特定の単語からリアクションさせられます:
`mina: :react{joon=surprised}와, 정말요?`（段落の終わりまで続く）。リアクションするキャラクターは
同じ側でも舞台に上がります。同じ側に複数いる場合は、リアクションの間だけ小さくなって並びます
（`:react{joon=surprised yuna=surprised}`）。`facing` は絵が向いている方向（`left` / `right` / `front`）で、
画面の外側を向いた絵は中央を向くように左右反転されます。

## 再現可能なレンダリング（Docker）

TTS はホストで動かします（モデルが必要で、macOS では MPS を使います）。結果は台本の隣の
`audio/<lang>/` にロックされ、イメージはそのロックからネットワークなしでレンダリングします。

```sh
docker build -t script2video-render .
docker run --rm --network none -v "$PWD/videos:/videos" -v "$PWD/out:/app/out" \
  script2video-render render /videos/sample-ko/script.ko.md --output youtube
```

同じイメージと同じオーディオロックなら、バイト単位で同じ結果になります。macOS と Docker の結果は
異なる（フォントのラスタライズと ffmpeg のビルドの違い）ため、同じ環境の中で比較してください。
イメージはローカル用です。Debian の GPL ライセンスの ffmpeg が含まれるので、公開配布しないでください。

## 台本の形式（さわり）

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

- `# 見出し {#id}` でシーン（と YouTube のチャプター）が始まり、`::image` / `::title` / `:::bullets` がビジュアルを決めます。
- `:cue[フレーズ]{...}` は、そのフレーズを話す瞬間に拡大や表示をします。
- 段落の先頭の `name:` で話者を選びます。エンジンの違う音声を混ぜても構いません。
- 詳しくは [リファレンス](.claude/skills/write-script/reference.md)。
