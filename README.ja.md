# script2video

[English](README.md) | [한국어](README.ko.md) | **日本語**

Markdown で台本を書くと、ナレーション付きの解説動画ができます。韓国語・英語・日本語に対応し、音声はローカルで動くオープンソースの TTS で合成します。話すタイミングに合わせて、自分で撮ったスクリーンショットを拡大・強調できます。同じ台本と同じ環境なら同じ動画になります。1 つの台本から YouTube（16:9）と Shorts（9:16）を作れます。

> **ステータス:** 正式公開前（v0.1.0）。1.0 までは台本の形式が変わる可能性があります。

**サンプル**（素材はすべてこのプロジェクト用に作った CC0）: `videos/sample-ko`（韓国語の進行役 + 会話 1 行）、
`videos/sample-dialogue-ko`（キャラクター 2 人、リアクション、効果音）、`videos/sample-en`（英語、ダークテーマ、チャートと比較）。

## ライセンスについて（業務で使う前にお読みください）

- script2video 自体は **MIT** です。
- レンダリングに使う **[Remotion](https://www.remotion.dev/)** は独自のライセンスです。個人と 3 人以下の組織は無料で、**それより大きい営利組織には Remotion Company License が必要です。** [remotion.dev/license](https://www.remotion.dev/docs/license) を確認してください。
- キャラクター生成（任意）: **Qwen-Image-Edit-2511** と Lightning LoRA（Apache-2.0）を mflux / MLX（MIT）で実行します。`create` が作る yaml にモデルとライセンスが記録されます。
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
- 任意、キャラクター生成用: メモリ 48 GB 以上の Apple Silicon と追加のディスク約 85 GB

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

| コマンド                                                                               | 内容                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `doctor`                                                                               | Node、ffmpeg、uv、Python 環境、モデル、フォントをチェック    |
| `new <dir> [--lang ko]`                                                                | 最初の台本が入った新しい動画フォルダを作る                   |
| `lint <script>`                                                                        | 静的チェック: 文法、素材、読み、字幕の分量、長さ             |
| `check <script>`                                                                       | すべての字幕を実際のレンダラーで配置し、はみ出しを確認       |
| `sentences <script>`                                                                   | 文の id 一覧（`tts --retry` 用）                             |
| `say "<text>" --script <script>`                                                       | 1 文を合成して再生（読みの確認）                             |
| `tts <script> [--retry id]`                                                            | オーディオロックに合成（変わった部分だけ）                   |
| `render <script> --output <name> [--draft] [--frozen-audio]`                           | 動画 + `.srt` `.vtt` チャプター、概要欄の下書き、サムネイル  |
| `snapshot <script> --output <name>`                                                    | シーンごとの静止画を並べて数秒で確認                         |
| `dev <script> [--video]`                                                               | 編集ループ: 保存のたびに lint → tts → snapshot               |
| `pick <image>`                                                                         | スクリーンショットをクリック / ドラッグして cue の座標を得る |
| `voice create / pick`                                                                  | ペルソナ音声を設計し、候補から選ぶ                           |
| `voice check <voices/id.yaml>`                                                         | ペルソナの参照音声を判定（雑音・間・語尾の途切れ・音の高さ） |
| `voice refs <script> [--refresh]`                                                      | 文を比べる基準音声                                           |
| `audio prune <script>`                                                                 | 台本で使わなくなった音声を削除                               |
| `inspect <script> --json`                                                              | 台本の構成と、変更の種類ごとのハッシュ（ツール向け）         |
| `export-script <script>`                                                               | ナレーションを自分で録音するための読み原稿を作る             |
| `import-recording <script> <take.wav> [--write]`                                       | 通しで録音したファイルを段落ごとに分ける（`:audio`）         |
| `tts-server start`                                                                     | コマンドの間も TTS サーバーを起動したままにする              |
| `character import / setup / create / pick / build / review / approve / redo / missing` | キャラクターの絵: YMM4 の取り込みと生成（下記）              |

`node packages/cli/dist/main.js <command> …` の形で実行します。`S2V_TTS=mock` を付けると、モデルなしで
合成した仮の音声で全体を動かせるので、レイアウト作業や CI に便利です。

`inspect --json` は動画を検収するツール向けです。出力、シーン、画面の文字、声、ファイルの一覧と、変更の
種類ごとのハッシュ（`content`、`voice`、`audio`、出力ごとの `presentation`、`engine` の構成要素）を出すので、
変わった部分だけを検収し直せます。形式にないもの（綴りを誤った属性、文字として表示される位置の指示）が
ある台本は拒否します。計算できないハッシュは理由付きで `null` です。`engine` は構成要素ごとに比べてください。
`defaults_*` に新しいキーが増えたのは s2v に新しい項目が加わったためで、台本のハッシュには影響しません。

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
# → 判定を通った候補から順に並べ、試聴ページを作ります。その中から 1 つ選びます:
node packages/cli/dist/main.js voice pick voices/minsu.yaml 2 --lang ko
```

その後、`cast:` で `voice: "persona:minsu"` を使います。すべての文が選んだ音声を複製して合成するので、
声が一定に保たれます。設計した音声は実在の人物をまねていません。

複製は参照音声の雑音・リズム・語尾までまねるので、候補を判定します：読み間違いがないか、説明の性別
（`남성`/`male`/`男性` または `여성`/`female`/`女性`）に合う音の高さか、雑音が小さいか、文の間に間が
あるか、語尾が途切れていないか。息の音は消しません。すでに使っている音声は
`voice check voices/minsu.yaml` で同じ判定ができます（元の出力がない仕上げ済みの音声では、雑音と語尾は
判定しません）。

**すべての文を同じ声で。** 声ごと（ペルソナ、`style` を含むプリセット話者、Supertonic の声）に基準音声が
あります。固定文の 20 テイクを一度測ってコミットします（`voices/<id>/<lang>.f0.json`、
`voices/_qwen/…`、`voices/_supertonic/…`）。`tts` はなければ作り（数分。判定のため Base モデルも読み込み、メモリを約 4GB 多く使います）、新しいテイクごとに音の高さと
声の類似度（Qwen3-TTS Base モデルの speaker encoder）を基準と比べます。外れたテイクは別のシードで
作り直します（最大 6 テイク）。すでにオーディオ lock にある文は `tts --recheck` のときだけ判定し直します。
`voice refs <script>` は基準音声を表示し、`--refresh` の後は今は不合格になる lock の文を示します。

### セリフの演技

話者の接頭辞に感情を書きます: `mina{emo=sad}: そうだと思った。` 感情は
`neutral happy sad angry surprised anxious excited calm serious puzzled moved playful` で、frontmatter の
`acting.emotions` で自作もできます（`sleepy: { voice: "Sound drowsy and slow.", face: calm,
speed: 0.8, maxPause: 1.5 }`）。感情は声（Qwen のプリセット話者は感情の指示に従う）、キャラクターの同名の
表情（なければ既定の表情。作る表情は `s2v character missing` が示す）、モーションを決めます。文と文の間に
`:emo{emo=sad}` を置くと次の文から変わります: `mina{emo=calm}: 大丈夫でした。:emo{emo=sad}でも。`

| 属性                |                                                         |
| ------------------- | ------------------------------------------------------- |
| `emo=`              | 感情                                                    |
| `power=weak/strong` | 強さ（persona・Supertonic の声は少し小さく / 大きく）   |
| `say="…"`           | このセリフだけの自由な指示（Qwen のプリセット話者のみ） |
| `volume=soft/loud`  | ミックスで −6 / +3 dB                                   |
| `speed=0.8–1.25`    | cast の `speed` と掛け合わせる                          |

感情は、言葉自体に感情がこもったセリフに書いてください。指示だけで平凡な文を楽しそうにはできません。
persona・Supertonic の声は感情を演じられません（表情とモーションは変わります）。韓国語の感情セリフの新しい
テイクは息・ため息・長い間・不自然な長さを検査し、引っかかれば作り直します。これらの属性がないセリフの
音は変わりません。

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

表情は段落ごとに選びます: `mina{face=happy}: 정말요?`。表情が変わると短い動きも付きます
（surprised → jump、happy → bounce、angry → shake、sad → sink）。`motion=nod` で動きを選ぶ
（jump、shake、nod、bounce、shiver、sink、lean）、`motion=none` で外す、または出演者に `motion: off` を
指定できます。聞き手は特定の単語からリアクションさせられます:
`mina: :react{joon=surprised}와, 정말요?`（段落の終わりまで続く）。リアクションするキャラクターは
同じ側でも舞台に上がります。同じ側に複数いる場合は、リアクションの間だけ小さくなって並びます
（`:react{joon=surprised yuna=surprised}`）。

キャラクターのフォルダは次の 2 つの形式のどちらかです。

**一枚絵。** **同じキャンバス**（同じサイズ、同じ体の位置）に描いた透過 PNG を表情ごとに入れます。
`facing` は絵が向いている方向（`left` / `right` / `front`）で、画面の外側を向いた絵は中央を向くように
左右反転されます。

| ファイル                                                  |                                            |
| --------------------------------------------------------- | ------------------------------------------ |
| `neutral.png`                                             | 口を閉じる（必須、デフォルトの表情）       |
| `neutral-talk.png`                                        | 口を開ける（このファイルがあると口が動く） |
| `neutral-half.png`                                        | 口を半分開ける（任意、より滑らかに）       |
| `neutral-blink.png`                                       | 目を閉じる（任意）                         |
| `happy.png`, `sad.png`, `surprised.png`, … (+ `-talk`, …) | ほかの表情                                 |

**レイヤー部品**（フォルダに `character.yaml` がある場合）。体、頭、口・目の部品をレンダリング時に
合成します。face は yaml で名前を付けた組み合わせです: view（体の角度）、任意のポーズ、任意の頭の向き、
表情。頭が別に動くので（`head-nod`、`head-tilt`）、聞いている様子や考えている様子が生きてきます。
生成したキャラクターと手描きのキャラクターがこの形式です。YMM4 の素材も `character.yaml` を持ち、
face が部品フォルダごとに画像を 1 つ選びます。全身（full）だけで描かれ、頭のモーションはありません:

```sh
# YMM4 の「動く立ち絵」素材（フォルダまたは zip）。利用規約のファイルも一緒にコピーします
node packages/cli/dist/main.js character import ~/Downloads/zundamon.zip --out characters/zunda
# → characters/zunda/character.yaml（下書き。parts.html で全部品を見ながら face を作ります）
```

**フレーミング。** 生成または手描きのレイヤーキャラクターは、全身（`full`、デフォルト）、腰から上
（`upper`）、顔のアップ（`head`）で描け、シーンごとに選びます。シーンの最初の段落の前に `::shot` を
置きます。名前を書かなかったキャラクターは直前のシーンのフレーミングを引き継ぎます:

```markdown
# アップ {#how}

::shot{mina=head joon=upper}
```

`::shot{mina=full}` で戻します。出力に `shot: full` を指定すると（`outputs.shorts.shot: full`）、
その出力では `::shot` を無視します。フレーミングごとに画像が別に必要です（yaml の `sets.upper` /
`sets.head` セット）。シーンで使う face をそのフレーミングが持っていなければ `lint` が知らせます。

### キャラクターの生成（任意、Apple Silicon）

script2video はローカルの画像編集モデル（Qwen-Image-Edit-2511 と 8 ステップの Lightning LoRA、どちらも
Apache-2.0、MLX で実行）でオリジナルのレイヤーキャラクターを描けます。すべての画像は**自分で選んだ
正面画像 1 枚**を編集して作るので、キャラクターが変わりません。ラウンドごとに確認して承認すると、次の
ラウンドが始まります。

Apple Silicon の Mac、**メモリ 48 GB 以上**（推奨 64 GB: モデルの準備で約 32 GB、生成で約 22 GB まで
使います）、**ディスク約 85 GB** が必要です（`S2V_MODELS_DIR` でモデルを別のディスクに置けます）。
画像 1 枚に約 4 分かかります。

```sh
node packages/cli/dist/main.js character setup        # 環境、ダウンロード、4 ビットモデル（1 回だけ）

# 1. character.yaml のあるフォルダ: `kind` にデザインを書きます
node packages/cli/dist/main.js character create characters/mina --candidates 4
#    → 選ぶための正面画像 4 枚（確認ページが開きます）
node packages/cli/dist/main.js character pick characters/mina 2

# 2. 残りはラウンドごとに: 基準 → 体 → ポーズ → 表情 → 口・目のフレーム
node packages/cli/dist/main.js character build characters/mina --dry-run   # 次のラウンドで作るもの
node packages/cli/dist/main.js character build characters/mina
#    → 確認ページ: 画像ごとのチェック結果と口の動きのプレビュー
node packages/cli/dist/main.js character approve characters/mina --all     # チェックを通ったものだけ
node packages/cli/dist/main.js character redo characters/mina front/base/happy   # 別のシードで
```

`preset: standard@1`（`create` が作る yaml に入っています）は用意済みの face のセットです:

- `neutral`、`happy`、`sad`、`angry`、`surprised`、`anxious`、`excited`、`calm`、`serious`、
  `puzzled`、`moved`、`playful`: 相手の話者のほうへ少し向いた姿勢（会話の基本の姿勢）
- `front-<表情>`: 視聴者のほうを向く（視聴者に話しかけるとき）
- `glance-neutral`、`glance-surprised`、`glance-happy`、`glance-puzzled`: 頭だけ向ける
- `wave`、`point`、`akimbo`、`cheer`、`arms-crossed`、`hands-together`: ポーズ
- 顔のアップのセット: `neutral`、`happy`、`sad`、`surprised`、`moved`、`serious`

`exclude: [angry, point]` で一部を外し、自分で書いた `faces:`、`expressions:`、`sets:` で preset に
追加したり置き換えたりします。セット全体は約 150 枚（10–11 時間、1 回だけ）で、その後キャラクターは
ライブラリになります。台本にライブラリにない face が必要になったら:

```sh
node packages/cli/dist/main.js character missing videos/demo/script.ko.md [--apply]
# → 定義されていないもの、フレーミングのセットにないもの（--apply が追加）、まだ承認されていないもの
```

変わったものだけを作り直します。画像ごとに作ったときの定義を記録するので（`provenance.json`）、止まった
ラウンドは続きから進み、プロンプトを直せばその画像だけを作り直します。TTS サーバーや整列サーバーが
起動していると生成を始めず（それぞれ数十 GB を使います）、メモリが尽きる前に監視プロセスが止めます。

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
