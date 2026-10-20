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

| コマンド                                                                                                                                                 | 内容                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`                                                                                                                                                 | Node、ffmpeg、uv、Python 環境、モデル、フォントをチェック                                                                                       |
| `--version [--json]`                                                                                                                                     | 固定するバージョン: semver とコードのハッシュ（ツールは `--json`）                                                                              |
| `new <dir> [--lang ko]`                                                                                                                                  | 最初の台本が入った新しい動画フォルダを作る                                                                                                      |
| `lint <script>`                                                                                                                                          | 静的チェック: 文法、素材（画像はバイト列で PNG/JPEG、`::video` は mp4/webm/mov/m4v）、読み、字幕の分量、長さ                                    |
| `check <script>`                                                                                                                                         | すべての字幕を実際のレンダラーで配置し、はみ出しを確認                                                                                          |
| `sentences <script> [--json]`                                                                                                                            | 文の id 一覧（`tts --retry` 用）。`--json`: 文ごとの lock キー、演技の属性、選んだテイク、lock の状態（ASR が聞いたか）                         |
| `say "<text>" --script <script>`                                                                                                                         | 1 文を合成して再生（読みの確認）                                                                                                                |
| `tts <script> [--retry id]`                                                                                                                              | オーディオロックに合成（変わった部分だけ）                                                                                                      |
| `render <script> --output <name> [--draft] [--frozen-audio] [--idle on\|off] [--rhythm on\|off] [--out-dir <dir>] [--watermark proxy] [--scenes <id,…>]` | 動画 + `.srt` `.vtt` チャプター、概要欄の下書き、サムネイル                                                                                     |
| `snapshot <script> --output <name> [--rhythm on\|off] [--out-dir <dir>] [--frozen-audio] [--frames]`                                                     | シーンごとの静止画を並べて数秒で確認。`--frames`: 画面が変わるたびの静止画と `index.json`                                                       |
| `capture <url> --out <png> [--text <json>] [--assets-dir <dir>] [--selector <css>] [--allow-host <host>]…`                                               | Web ページの画面（1280×800 または要素ひとつ）と、`--text` でその内容を JSON に                                                                  |
| `direct <script> [--output <name>] [--rhythm on\|off] [--no-open] [--out-dir <dir>] [--json]`                                                            | 演出計画と演出ノートのページ（`out/<video>/direct/`）、音声なしでも可；`--json`: ツール向けにノートすべて、ページなし                           |
| `dev <script> [--video]`                                                                                                                                 | 編集ループ: 保存のたびに lint → tts → snapshot                                                                                                  |
| `takes <script> [--all] [--id id] [--no-open] [--out-dir <dir>]`                                                                                         | 試聴ページ（`out/<動画>/takes/<lang>/`）: 文ごとのすべてのテイクを単独・前後の文とつなげて聞き、ラジオで `takes pick` / `unpick` コマンドを作る |
| `takes <script> --list [--id id]`                                                                                                                        | 文ごとのテイク: wav のパス、合否、音の高さ、速さ                                                                                                |
| `takes pick <script> <id>=<n> …` / `takes unpick <script> <id> …`                                                                                        | テイクを自分で選ぶ（`pick <image>` とは別）                                                                                                     |
| `pick <image>`                                                                                                                                           | スクリーンショットをクリック / ドラッグして cue の座標を得る                                                                                    |
| `voice create / pick`                                                                                                                                    | ペルソナ音声を設計し、候補から選ぶ                                                                                                              |
| `voice check <voices/id.yaml>`                                                                                                                           | ペルソナの参照音声を判定（雑音・間・語尾の途切れ・音の高さ）                                                                                    |
| `voice train <voices/id.yaml> [--lang ko] [--min-emotion N]`                                                                                             | ペルソナの話者を学習して感情を演じさせる（約 3 時間、再開できる）                                                                               |
| `voice refs <script> [--refresh]`                                                                                                                        | 文を比べる基準音声                                                                                                                              |
| `audio prune <script>`                                                                                                                                   | 台本で使わなくなった音声を削除                                                                                                                  |
| `inspect <script> --json`                                                                                                                                | 台本の構成と、変更の種類ごとのハッシュ（ツール向け）                                                                                            |
| `export-script <script>`                                                                                                                                 | ナレーションを自分で録音するための読み原稿を作る                                                                                                |
| `import-recording <script> <take.wav> [--write]`                                                                                                         | 通しで録音したファイルを段落ごとに分ける（`:audio`）                                                                                            |
| `tts-server start`                                                                                                                                       | コマンドの間も TTS サーバーを起動したままにする                                                                                                 |
| `services status [--json]`                                                                                                                               | マシンのロック、常駐 TTS サーバー、どのコマンドも持っていないサーバー(止め方)                                                                   |
| `character import / setup / create / pick / build / review / approve / redo / missing`                                                                   | キャラクターの絵: YMM4 の取り込みと生成（下記）；ツール向けの `--json`（`build --dry-run`、`review`、`missing`）                                |

`node packages/cli/dist/main.js <command> …` の形で実行します。`S2V_TTS=mock` を付けると、モデルなしで
合成した仮の音声で全体を動かせるので、レイアウト作業や CI に便利です。

各コマンドは自分のフラグだけを受け取り、知らないフラグと知らない `--output` はエラーです（exit 2）。`say` の文が `-` で
始まるときは `--` の後に書きます。`--version --json` は `id`（semver + s2v が実行するコードと固定データの
ハッシュ、未コミットの変更を含む）を出します。ツールは `id` を固定し、変わったら止まります。`stale_build` は
どれかのパッケージの `dist` がソースより古いという意味です（`yarn build`）。`inspect` の `s2v_version` も
同じ `id` です。

成果物は `out/<台本フォルダ>/` にできます（render、snapshot、`direct`・`takes` のページ）。`--out-dir <dir>` を
指定すると同じ名前で `<dir>` の下に書きます。render は `<output>.<lang>[.draft].{mp4,srt,vtt,description.md}` と、作ったときだけ `.chapters.txt`・`.thumbnail.png` を書き、作らなかったほうは前回のファイルを消します（ほかの出力、draft とそうでないほう、snapshot のファイルには触れません）。0 以外のコードで終わった
ときは成果物の組は保証されません。名前が同じ台本フォルダ二つは、それぞれ `--out-dir` を指定しなければ
`out/<名前>/` を共有します。同じ台本・出力・言語の render と snapshot は作業フォルダを共有するので、一つずつ
実行してください。`.s2v-cache/` はいつ消してもかまいません。その中の `render/`・`draft-audio/`・`check/` は
`<台本フォルダ>-<ハッシュ>` で分かれ、ハッシュのないフォルダは以前のバージョンのものです。成果物フォルダの
`*.tmp.*` は中断した実行が残したものです。`dev` は台本フォルダを監視するので、`--out-dir` はその外に置いてください。

**重い処理はマシンで一つずつ。** TTS・アライメントサーバー、音声の学習、画像モデルはそれぞれ数十 GB を使うので、
s2v はこのマシンで一度に一つだけ動かします。合成するコマンド(`tts`、`say`、`voice create/check/refs`、
`import-recording`、`--frozen-audio` なしの `render`・`snapshot`)はサーバーが最初に必要になったときに
マシンのロックを取り(合成するものがない `tts` は取りません)、`voice train` と `audio prune` は始めるときに取り、`character setup`・`create`・
`build` のラウンドは画像生成のために取ります。ほかの処理が持っていればすぐに exit 73 で止まり、stderr の
1 行目に理由 `busy (lock|breaking|resident|orphan|changed): …` を出します。誰が何を持っているかは
`s2v services status` が示します。`dev` はセッションの間ずっと、`character setup` はダウンロードを含む
セットアップの間ずっとロックを持ちます: その間 TTS のコマンドは終わるまで待つ必要があります。
`--frozen-audio` のレンダー・スナップショットはロックを取りません(音声ロックの wav を読むので、その間は
`audio prune` を実行しないでください)。`tts-server start` で起動したサーバーは TTS コマンドが一つずつ
再利用します。起動している間だけロックを持ち、その横では画像生成が始まらず(その端末で Ctrl-C で止めて
ください)、Ctrl-C のときに TTS コマンドがまだ使っていれば警告します(exit 130)。生成キャラクターを書く
コマンド(`create`、`pick`、`build`、検査をやり直す `review`、`approve`、`redo`、`missing --apply`)は
そのキャラクターの作業ロックを取り、一つのキャラクターを同時に変えません(exit 74)。
`build --dry-run --json`、`review --json --no-check`、`missing --json` は作業中のコマンドを `running` に
出します。強制終了されたコマンドはサーバーを残すことがあります(普通は一緒に終わります):
`services status [--json]` は TTS・aligner のポート(今の `S2V_TTS_PORT` / `S2V_ALIGNER_PORT`)に応答する
のに後ろにコマンドがいないサーバーと、その止め方を示します。s2v の外で手で起動したサーバーや Python は
ロックからは見えません。

ツール向け(Studio の `lock.py` と同じ形式): ロックは `~/.s2v/heavy.lock.d/`(または絶対パスの
`$S2V_STATE_DIR`。s2v とツールが同じ場所を見ること)で、`owner.json` は
`{kind: "tts"|"gen", pid, pid_start, holder, token}` です。非公開の `heavy.lock.d.new.<rand>/` に
`owner.json` を書き、そのフォルダーを `heavy.lock.d` へ rename して取ります(空のフォルダーへの rename は
成功するので、`mkdir` で取って後から owner を書く方式と混ぜないでください)。
`LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` が `pid_start` と合わない持ち主(Linux では 2 秒以内なら同じ —
起動時刻が時計の調整で動くため。大きな時計のずれは生きている持ち主を死んだように見せることがあります)は
`heavy.lock.d.break` ミューテックスの中で壊します。持ち主の `token` と同じ `S2V_HEAVY_LOCK_TOKEN` を
受け取った子プロセスはそのロックの下で動きます(同じ `kind` のみ。そうした子は一つずつ順に)。
`<character>/.work/op.lock.d` が作業ロックで(`{pid, pid_start, cmd, token}`、`S2V_ACTOR_LOCK_TOKEN` で
再入)、s2v はキャラクターの `.gitignore` に `.work/` がなければ追記します。`resident.json` は常駐サーバー
(`pid`、`pid_start`、`port`、`server_pgid`)を記録します。

音声 lock の各文は ASR が聞いたか（`asr`）を記録し、聞いていなければ（`--no-asr`、mock 音声、録音）`cer` は `null` です。ASR を有効にした `tts` は、まだ聞いていない lock の文をその場で聞きます。音声はそのままで、落ちたら選び直します（選んだテイクは警告だけで残します）。このときは整列サーバーだけを起動します（選び直す文があれば TTS サーバーも）。

`render --watermark proxy` は動画とサムネイルに赤い PROXY の帯を入れ、成果物の名前を `<output>.<lang>[.draft].proxy.*` にして、印のない成果物を上書きしません（人が承認していないレンダーにツールが印を付けるとき）。帯はロゴと反対側の上の隅に置きます（字幕が上にあるときは下）。動画をもう一度エンコードするので（長い 1080p 動画では数分）時間が延び、シーンのキャッシュは印のないレンダーと共有するので同時に実行しないでください。テキストファイルは印のないものと同じです。キャラクターがいて字幕が上にあるときは、下の隅の帯がキャラクターの足元を隠すことがあります。

`render --scenes <id,…>` は出力のシーンの一部を、その出力の frontmatter `scenes` に書いたのと同じようにレンダーし、台本を直さずに短いクリップを作ります（台本の順。出力に `scenes` があればその中の id だけ）。成果物は `<output>.<lang>[.draft].scenes-<a+b>[.proxy]` の `.mp4` `.srt` `.vtt` で（リストが長いと `scenes@<n>-<ハッシュ>`）、チャプター・概要欄・サムネイルは作らず、全体動画のファイルには触れません。切り出したシーンは、外したシーンから受け継いでいた `::shot` のフレーミングと左右を失います。キャラクターの位置やフレーミングが全体動画と違えば警告し、そのせいで描けなければ合成の前に止まります（exit 1）。合成は台本全体のままなので、`tts` の後に `--frozen-audio` でレンダーしてください。シーンの組ごとにキャッシュに作業フォルダができ（クリップごとに増えます）、クリップとその台本の他のレンダーがすべて `--frozen-audio` のときだけ並べて実行できます（一つの作業フォルダでは今も一度に一つ）。`-` で始まる id は `--scenes=-x` で渡します。大文字小文字だけが違う二つのシーン id は、大文字小文字を区別しないディスク（macOS の既定）で同じファイル名になります。

`capture` は render が使うヘッドレスブラウザ（初回に約 100MB をダウンロード）で Web ページを開き、
公開ホストにだけ接続します。URL のホストと `--allow-host`（正確な名前）はそれぞれ公開アドレスにだけ
解決されなければなりません。それ以外のホスト、すべての IP アドレス、ほかのスキームはブロックします。ページ自身が要求したものは
JSON の `blocked` に記します（WebSocket は `websockets` に。ワーカー自身の要求は漏れることがあります）。公開アドレスにありこの端末にだけ開いている社内ネットワークは防げない
ので、公開ページだけを渡してください。実行ごとに新しいプロファイル（保存された Cookie なし）で、ポップアップ・ダウンロードはなく、WebRTC はオフです。
`--text` はページのタイトル、言語、見えている文をブロック単位で（見出し、段落、リスト項目…；ルビは
組で）、画像とその位置・バイトの sha256（`--assets-dir` がバイトを保存）、読めないもの（ほかのサイトの
フレーム、canvas）、そしてページが述べる内容のハッシュ `contentHash`（位置は含めない）を書きます。
`--selector`、ほかのサイズ、または `--timeout`（実行全体の秒数、既定 30。その後の段階ごとに数秒の猶予が付きます）内にページが落ち着かないと
`contentHash` は `null` です（そのときページはその状態で撮り、警告付きで exit 0）。開けない、または
2xx 以外を返すページは exit 1：画像はなく、JSON には分かっていることだけを記します。Linux では
ブラウザにサンドボックス（ユーザー名前空間）が必要です。それを用意できないコンテナでは
`S2V_CAPTURE_NO_SANDBOX=1` でサンドボックスなしで実行します。

`snapshot --frames` は並べた一枚の隣に `<output>.<lang>.frames/` を書きます。画面が変わる時点（最初の画が落ち着いた後、画と cue ごと、キャラクターの表情と既定の表情に戻るとき、舞台の入れ替え、保たれる動き）ごとに原寸の静止画をシーンあたり最大 12 枚、動画全体の通し番号で、そして静止画ごとのシーン・フレーム・秒・理由と s2v id、台本の sha256 を記した `index.json` を書きます。静止画のキャラクターは休んだ姿勢です（呼吸・まばたき・うなずきなし）。実行は前回の並べた一枚と静止画を先に消します。`--frames` なしで実行すると静止画フォルダはそのままです。`--frozen-audio` は音声 lock をそのまま使い、音声のない文があれば失敗します。`script_sha256` は台本だけを見て、素材とキャラクターの絵は見ません。中断した実行は `<…>.frames.tmp/` を残すことがあります。

`inspect --json` は動画を検収するツール向けです。出力、シーン、画面の文字、声、ファイルの一覧と、変更の
種類ごとのハッシュ（`content`、`voice`、`audio`、出力ごとの `presentation`、`engine` の構成要素）を出すので、
変わった部分だけを検収し直せます。形式にないもの（綴りを誤った属性、文字として表示される位置の指示）が
ある台本は拒否します。計算できないハッシュは理由付きで `null` です。`engine` は構成要素ごとに比べてください。
`defaults_*` に新しいキーが増えたのは s2v に新しい項目が加わったためで、台本のハッシュには影響しません。
キャラクターを描く出力の `presentation` には、その出力が見せるすべての face の絵（合成が読むファイルの
sha256）が入り、絵がない face があると `null` になります。1 枚絵（classic）のキャラクターは framing に
関係なく同じ絵です。

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

**感情を演じるペルソナ。** 複製したペルソナは感情の指示に従えません。`s2v voice train
voices/minsu.yaml --lang ko` はペルソナの声で Qwen3-TTS CustomVoice モデルの話者の行を 1 つ学習します（約
3 時間：学習用の音声を自分で作って判定し、学習します。もう一度実行すると続きから再開し、キャラクター画像の生成中は
実行しないでください）。`voices/minsu/ko.speaker.json` と基準音声を書き出すのでコミットし、cast に
`personaModel: trained` を書いてください。学習した話者はプリセット話者のように `emo`・`say`・`style` に従い、
強い文は "Sound very …" で話します。サンプルの guest では `happy`・`excited` は通常より `power=strong` のほうが嬉しそうに
聞こえることが多く、`excited` の文が怒って聞こえることもありました — テイクページで聞いて `power=strong` や `emo` なしも試してください。感情の音声が 150 個
未満しか通らなければ 2 回目の学習の前に止まります（`--min-emotion` で変更）。今は韓国語のみ。

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

| 属性                |                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emo=`              | 感情                                                                                                                                                                                        |
| `power=weak/strong` | 強さ（感情のある Qwen のプリセット話者と学習したペルソナは最も弱い / 強いテイク、学習したペルソナの強い文は "Sound very …" で話す。複製したペルソナ・Supertonic の声は少し小さく / 大きく） |
| `say="…"`           | このセリフだけの自由な指示（Qwen のプリセット話者のみ）                                                                                                                                     |
| `volume=soft/loud`  | ミックスで −6 / +3 dB                                                                                                                                                                       |
| `speed=0.8–1.25`    | cast の `speed` と掛け合わせる                                                                                                                                                              |

感情は、言葉自体に感情がこもったセリフに書いてください。指示だけで平凡な文を楽しそうにはできません。
複製した persona・Supertonic の声は感情を演じられません（表情とモーションは変わります）。学習した
persona は演じます。韓国語の感情セリフの新しい
テイクは息・ため息・長い間・不自然な長さを検査し、引っかかれば作り直します。これらの属性がないセリフの
音は変わりません。

**感情セリフのテイク。** Qwen のプリセット話者の感情セリフは、`tts` がテイクを 3 つ作り、2 つ通るまで
さらに作ります（最大 6 つ）。happy・excited・playful・angry・moved のセリフは、語尾が下がりすぎない
テイクが出るまでも作ります。演技の強さで 1 つを選びます: 真ん中あたり、calm・sad・serious・moved は
最も弱いもの、または `power` のとおり。同じ段落の直前の文と感情・`power`・速さ・`say` が同じなら、音の
高さと速さが直前の文に最も近いほうに寄せます。すでにオーディオ lock にある文はテイクが変わりません。
`tts --retry <id>` はこれまでのテイクの後に新しいテイクを 3 つ作り、通るものがなければ lock のテイクを
そのまま残します。`tts` は最初に予想時間を表示します。

**テイクを自分で選ぶ。** `s2v takes <script>` は試聴ページを開きます。感情セリフと自分で選んだセリフ（`--all` ならすべてのセリフ）の
すべてのテイクを単独で、または前後の文とつなげて動画と同じ音量で聞け、ラジオで選んだものがコピーできる
`s2v takes pick …`（と `unpick`）コマンドになります。サーバーは起動しません。`s2v takes <script> --list` は同じテイクを
wav のパスとともにテキストで表示します。`s2v takes pick <script> 1:0:2=3 1:2:0=1` は `1:0:2` のテイク 3 と `1:2:0`
のテイク 1 を選び、次の `tts` がそれをオーディオ lock に入れます。選んだものは lock の隣の
`audio/<lang>/picks.json` に保存されるので、コミットしてください。速さ（Qwen・persona の声。Supertonic では速さも声の一部）・間・後処理だけが変わっても残り、
セリフ・声・演技・`power` が変わると適用されません（`tts` が前後のセリフを並べて知らせます）。
`tts --retry <id>` の選択も pick として保存されます。シーン全体を retry すると、自分で選んだ文は
飛ばします。`s2v takes unpick <script> <id>` で自動の選択に戻り、`audio prune` は使われない pick を
消します。

**演出ノート。** `s2v direct <script> [--output youtube]` は出力ひとつの演出計画をページ
（`out/<video>/direct/<output>.<lang>.html`）にします。段落ごとに時刻、話者、感情、表情とモーション、
視線と反応、前の間（リズムの規則つき）を示します。音声がなくても使えます。今の台本で合成済みの文は実際の
長さを、残りは推定の長さ（`~` 印）を使います。上のノートは、動画が単調に見えそうな所で試すことを
知らせます：長い会話に感情がひとつもない、同じ感情が何段落も続く、ひとりが何段落も続けて話す、
30 秒間聞き手の反応がない（キャラクターがあり待機動作を切ったときだけ）、学習した persona の happy・excited のセリフ。
エラーではなく助言です。
`--json` はページの代わりにノートすべて（種類ごとに 5 件で切らない）を出します。ノートごとに `code`、`cast`、
`paragraph`（`scene:block`、その段落の文 id の先頭）と `line`、範囲の最後の段落（`toParagraph`、`toLine`）、
反応しない `listener`、`emo` があり、`audio` は実際の音声がある文の数を示します。順序に意味はなく、
`message` は人向けです。lint が失敗すると JSON を出して exit 1 で終わります。

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

`:look{mina=viewer}` でキャラクターの視線を選びます: `partner`（基本の姿勢、相手のほうへ少し向く）、
`viewer`（視聴者を見る、`front-<face>` の画像）、`glance`（体は視聴者へ、頭だけ相手へ、`glance-<face>` —
`viewer` と組で使う）。話し手自身の `:look` は文の頭ならその文から（文の途中なら次の文から）、聞き手の
`:look` はその単語から段落の終わりまで、または次の `:look` までです（`partner` で戻す）。生成キャラクター
（`preset: standard@1`）にはこれらの画像があり、classic フォルダは `front-happy.png` などのファイルが必要で、
なければ表情はそのままです（lint が知らせます）。顔のアップでも視線は変わります: 生成
キャラクターは体が映らないので `partner` と `glance` が同じ画像（頭を相手のほうへ向ける）で、`viewer` は
視聴者を見ます。classic フォルダは全身と同じく `front-<face>.png`、`glance-<face>.png` を使います。

キャラクターは舞台に出入りできます: シーンの最初の段落の前に `::enter{joon}` を置くと、シーンの始まりに
joon が自分の側から滑り込み（joon がシーンの最初のセリフを話すなら入ってから始まる）、`::exit{joon}` を
置くとそのシーンのセリフ・反応と表情の保持が終わった後に滑って出ていきます（見えるようにシーンが少し
延びる）。名前は一度に複数書けます（`::enter{joon yuna}`）。そのシーンで
入ってくるキャラクターが自分の側で最初に話す必要があり、そうでなければ登場は無視されます。出た後その側は次の話し手まで空いています。その出力で
話すか反応するキャラクターだけ、キャラクター画像があるときだけ出入りします。シーンを選ぶ出力で順序が
崩れると（出たキャラクターがまた話す）lint が警告し、いつものように現れます。

```md
::enter{joon}
joon: 遅れてすみません。
```

キャラクターは自分でも少し動きます: 呼吸し、2〜6 秒ごと（と表情が変わるとき）にまばたきし、聞き手は
相手の文の終わりにときどきうなずきます（質問の後やすぐ答えるときは除く）。止めるには frontmatter に
`acting: { idle: false }` と書き（まばたきは 4 秒に 1 回になります）、`s2v render … --idle on|off` で
どちらも試せます。スナップショットとサムネイルでは目を閉じません。

段落の間隔は内容に合わせて変わります（リズム）: 相手の質問への答えは早く（×0.6、質問は `?` で終わる
行）、前の段落と感情が違う段落の前にはひと息（×1.3）、悲しい・感動した・真剣な段落の後には余韻（×1.4）を
置き、これらの間隔は少しずつ揺れます（±12%）。自分で書いた間隔（`gap=`）、ポーズ、シーン間、文と文の
間隔はそのままで、シーンをまたいでは効かず（シーン最後の段落が悲しくてもシーン間はそのまま）、音声も
変わりません。段落の感情はその段落の `emo`（または段落の先頭の `:emo`）です。リズムは既定でオンで、
`acting: { rhythm: false }` ですべての間隔を以前のように均等にできます（以前の動画をそのまま作り直すとき）。
オブジェクトで倍率を決められます: `acting: { rhythm: { answer: 0.8, emotion: 1.2, linger: 1.6, jitter: 0 } }`
（必要なものだけ）。出力ごとに `outputs.shorts.rhythm`（`false`、または台本の設定に上書きする倍率）で
決められ、`s2v render|snapshot|timeline … --rhythm on|off` で試せます（`timeline` は間隔ごとの規則を stderr
に表示）。

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
- 顔のアップのセット: 上のすべての face — 向きを変えた face と glance は頭を向け、ポーズはその表情で

`exclude: [angry, point]` で一部を外し、自分で書いた `faces:`、`expressions:`、`sets:` で preset に
追加したり置き換えたりします。セット全体は約 220 枚（15–16 時間、1 回だけ）で、その後キャラクターは
ライブラリになります。台本にライブラリにない face が必要になったら:

```sh
node packages/cli/dist/main.js character missing videos/demo/script.ko.md [--apply]
# → 定義されていないもの、フレーミングのセットにないもの（--apply が追加）、まだ承認されていないもの
```

`provenance.json` のない生成キャラクターのフォルダー（`character build` が作っていない）は「(c) unknown」で、
`missing` は失敗します。キャラクターのフォルダーがない、または読めないときも同じです。

ツール向けの JSON の形があります（stdout は JSON、メッセージは stderr）。読むだけなのは三つです:
`build --dry-run --json`、`review --json --no-check`、`--apply` なしの `missing --json`。
`--no-check` なしの `review --json` はもう一度チェックしてページを書き、`missing --apply` は
`character.yaml` を直し、`build --layers-only` はレイヤーを作り直します:

```sh
node packages/cli/dist/main.js character build characters/mina --dry-run --json   # 状態、ラウンド、次のラウンド、見積もり
node packages/cli/dist/main.js character review characters/mina --json --no-check # 項目、view、face、レイヤーファイル
node packages/cli/dist/main.js character missing videos/demo/script.ko.md --json  # cast ごとに (a)–(d)、unknown
node packages/cli/dist/main.js character build characters/mina --layers-only      # レイヤーだけ作り直し、生成なし
```

- `build --dry-run --json`: `state` は `pick`（front 参照なし: `front` が `never-picked` か `deleted`）、
  `generate`、`review`、`blocked`、`derive`（画像はすべて承認済み、一部のレイヤーが古い: `--layers-only`）、
  `complete`。ほかに `rounds`、`next`（枚数と分）、`staleParts`、`remainingImages` / `remainingMinutes`
  （上限の見積もり）、書き込む `@flip` twin。
- `review --json`: 項目ごと（`status`、生成画像の `sha`、`workMatches`、`approvedSha`、`srcSha`、`checks`、
  `onPage`）、view ごとのレイヤー部分と失敗した合成チェック、face ごとの `key`（`framing:face`。face 名に
  `:` は使えない）と `ready`、`pending`、`staleParts`、`warnings`、レイヤーファイルごとの `state`（`same`、
  `edited`、`untracked`、`gone`）。`--no-check` がなければ待機中の画像をもう一度チェックし、先にページを
  書きます（`--no-open` なら開かない）。`--no-check` は読むだけです。
- `missing --json`: キャラクターのある cast ごとに `checked`（でなければ `reason`: `no-folder`、`invalid`、
  `not-parts`、`not-generated`）、`notDefined`、`notInSet`、`notReady`（項目と `staleParts`）、`impossible`、
  `optional`、`--apply` が加えた `added`、`count` — (a) は face の数、(b)–(d) は項目の数で、テキストの行数では
  ありません。
- レイヤーが最新かは部分ごとです（view の参照、ポーズの body ごと、表情グループごと — 目は別のグループの
  blink から来ることがあるので、その view の承認済み blink すべてを合わせて見ます）。blink を新しく承認したり
  作り直したりすると、同じ view のほかのグループも古くなります。0.11.0 より前に作ったキャラクターと、
  `imagegen/character.py` の `DERIVE_VERSION` が上がった後は `character build <dir> --layers-only` を一度実行します。
  `build --no-open` はラウンドのページを書きますが開きません。

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
