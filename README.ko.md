# script2video

[English](README.md) | **한국어** | [日本語](README.ja.md)

Markdown 대본을 쓰면 내레이션이 들어간 설명 영상이 만들어집니다. 한국어·영어·일본어를 지원하고, 음성은 로컬에서 돌아가는 오픈소스 TTS로 합성합니다. 말하는 타이밍에 맞춰 직접 찍은 스크린샷을 확대하고 강조할 수 있습니다. 같은 대본과 같은 환경이면 같은 영상이 나옵니다. 하나의 대본에서 YouTube(16:9)와 Shorts(9:16)를 함께 만듭니다.

> **상태:** 정식 공개 전(v0.1.0). 1.0 전까지 대본 형식이 바뀔 수 있습니다.

**샘플** (모든 에셋은 이 프로젝트용으로 만든 CC0): `videos/sample-ko`(한국어 진행자 + 대화 한 줄),
`videos/sample-dialogue-ko`(캐릭터 두 명, 반응, 효과음), `videos/sample-en`(영어, 다크 테마, 차트와 비교).

## 라이선스 안내 (업무에 쓰기 전에 읽어 주세요)

- script2video 자체는 **MIT**입니다.
- 렌더링에 쓰는 **[Remotion](https://www.remotion.dev/)** 은 별도 라이선스입니다. 개인과 3명 이하 조직은 무료이고, **그보다 큰 영리 조직은 Remotion Company License가 필요합니다.** [remotion.dev/license](https://www.remotion.dev/docs/license)를 확인하세요.
- 캐릭터 생성(선택): **Qwen-Image-Edit-2511**과 Lightning LoRA(Apache-2.0), mflux / MLX(MIT)로 실행합니다. `create`가 만드는 yaml에 모델과 라이선스가 기록됩니다.
- 음성: **Qwen3-TTS**(Apache-2.0), **Supertonic-3**(코드 MIT, 가중치 OpenRAIL-M). Supertonic-3로 만든 음성을 공개할 때는 라이선스에 따라 기계 생성 콘텐츠임을 밝혀야 합니다.
- 일부 의존성은 카피레프트입니다. 사용자의 컴퓨터에 설치될 뿐이고, 이 프로젝트가 재배포하지 않습니다.
  - `soynlp`(GPL-3.0): aligner 환경의 `qwen-asr`가 필요로 함
  - PyAV 휠에 들어 있는 FFmpeg 라이브러리(LGPL): aligner 환경
  - `elkjs`(EPL-2.0): `:::diagram`에 쓰는 mermaid가 가져옴
  - 시스템의 ffmpeg와 SoX(빌드에 따라 LGPL / GPL)

## 필요한 환경

- macOS(Apple Silicon) 또는 Linux
- Node.js 22+, Yarn 4, [uv](https://docs.astral.sh/uv/), ffmpeg
- 모델용 디스크 약 15GB
- 선택, 캐릭터 생성용: 메모리 48GB 이상의 Apple Silicon과 추가 디스크 약 85GB

## 빠른 시작

```sh
yarn install
yarn build

# Python 환경과 버전을 고정한 모델
(cd tts-server && uv sync) && (cd aligner && uv sync)
(cd tts-server && uv run python scripts/fetch_models.py \
  qwen3-tts-1.7b-customvoice supertonic-3 qwen3-asr-0.6b qwen3-forcedaligner-0.6b)

# 샘플 렌더링
node packages/cli/dist/main.js doctor                              # 환경 점검
node packages/cli/dist/main.js lint videos/sample-ko/script.ko.md   # 정적 검사
node packages/cli/dist/main.js check videos/sample-ko/script.ko.md  # 자막 넘침 검사(실제 레이아웃)
node packages/cli/dist/main.js render videos/sample-ko/script.ko.md --output youtube
node packages/cli/dist/main.js render videos/sample-ko/script.ko.md --output shorts
# → out/sample-ko/youtube.ko.mp4 (+ .srt, .vtt, .chapters.txt, .description.md, .thumbnail.png)
#   out/sample-ko/shorts.ko.mp4
```

## 명령어

| 명령어                                                                                                             | 하는 일                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`                                                                                                           | Node, ffmpeg, uv, Python 환경, 모델, 폰트 점검                                                                                         |
| `--version [--json]`                                                                                               | 고정할 버전: semver와 코드 해시(도구는 `--json`)                                                                                       |
| `new <dir> [--lang ko]`                                                                                            | 시작용 대본이 든 새 영상 폴더 만들기                                                                                                   |
| `lint <script>`                                                                                                    | 정적 검사: 문법, 에셋(그림은 바이트로 PNG/JPEG, `::video`는 mp4/webm/mov/m4v), 발음, 자막 분량, 길이                                   |
| `check <script>`                                                                                                   | 모든 자막을 실제 렌더러로 배치해 넘침 확인                                                                                             |
| `sentences <script>`                                                                                               | 문장 id 목록(`tts --retry`용)                                                                                                          |
| `say "<text>" --script <script>`                                                                                   | 한 문장을 합성해 재생(발음 확인)                                                                                                       |
| `tts <script> [--retry id]`                                                                                        | 오디오 잠금에 합성(바뀐 부분만)                                                                                                        |
| `render <script> --output <name> [--draft] [--frozen-audio] [--idle on\|off] [--rhythm on\|off] [--out-dir <dir>]` | 영상 + `.srt` `.vtt` 챕터, 설명문 초안, 썸네일                                                                                         |
| `snapshot <script> --output <name> [--rhythm on\|off] [--out-dir <dir>] [--frozen-audio] [--frames]`               | 장면마다 정지 화면 한 장을 모아 몇 초 만에 확인. `--frames`: 화면이 바뀌는 시점마다 낱장과 `index.json`                                |
| `direct <script> [--output <name>] [--rhythm on\|off] [--no-open] [--out-dir <dir>]`                               | 연출 계획과 감독 노트 페이지(`out/<video>/direct/`), 음성 없이도 됨                                                                    |
| `dev <script> [--video]`                                                                                           | 편집 루프: 저장할 때마다 lint → tts → snapshot                                                                                         |
| `takes <script> [--all] [--id id] [--no-open] [--out-dir <dir>]`                                                   | 청취 페이지(`out/<영상>/takes/<lang>/`): 문장별 모든 테이크를 단독·앞뒤 문장과 이어 듣고, 라디오로 `takes pick` / `unpick` 명령을 만듦 |
| `takes <script> --list [--id id]`                                                                                  | 문장별 테이크: wav 경로, 통과 여부, 음높이, 빠르기                                                                                     |
| `takes pick <script> <id>=<n> …` / `takes unpick <script> <id> …`                                                  | 테이크를 직접 고르기(`pick <image>`와 다름)                                                                                            |
| `pick <image>`                                                                                                     | 스크린샷을 클릭 / 드래그해 cue 좌표 얻기                                                                                               |
| `voice create / pick`                                                                                              | 페르소나 목소리를 설계하고 후보 중에서 고르기                                                                                          |
| `voice check <voices/id.yaml>`                                                                                     | 페르소나 참조 음성 판정(잡음·쉼·끝 잘림·음높이)                                                                                        |
| `voice train <voices/id.yaml> [--lang ko] [--min-emotion N]`                                                       | 페르소나의 화자를 학습해 감정을 연기하게 함(약 3시간, 이어 하기 가능)                                                                  |
| `voice refs <script> [--refresh]`                                                                                  | 문장을 비교할 기준 음성                                                                                                                |
| `audio prune <script>`                                                                                             | 대본에서 더 이상 쓰지 않는 음성 삭제                                                                                                   |
| `inspect <script> --json`                                                                                          | 대본의 구성과 변경 종류별 해시(도구용)                                                                                                 |
| `export-script <script>`                                                                                           | 내레이션을 직접 녹음할 때 읽을 대본 만들기                                                                                             |
| `import-recording <script> <take.wav> [--write]`                                                                   | 한 번에 녹음한 파일을 문단별로 나누기(`:audio`)                                                                                        |
| `tts-server start`                                                                                                 | 명령어 사이에 TTS 서버를 계속 띄워 두기                                                                                                |
| `character import / setup / create / pick / build / review / approve / redo / missing`                             | 캐릭터 그림: YMM4 가져오기와 생성(아래 참조)                                                                                           |

`node packages/cli/dist/main.js <command> …` 형태로 실행합니다. `S2V_TTS=mock`을 붙이면 모델 없이
합성 음성으로 전체를 돌려 볼 수 있어 레이아웃 작업과 CI에 편리합니다.

각 명령은 자기 플래그만 받으며, 모르는 플래그는 오류입니다(exit 2). `say`의 문장이 `-`로 시작하면
`--` 뒤에 씁니다. `--version --json`은 `id`(semver + s2v가 실행하는 코드와 고정 데이터의 해시, 커밋하지
않은 변경 포함)를 냅니다. 도구는 `id`를 고정하고 바뀌면 멈춥니다. `stale_build`는 어떤 패키지의 `dist`가
소스보다 오래됐다는 뜻입니다(`yarn build`). `inspect`의 `s2v_version`도 같은 `id`입니다.

결과물은 `out/<대본 폴더>/`에 생깁니다(render, snapshot, `direct`·`takes` 페이지). `--out-dir <dir>`을 주면
같은 이름으로 `<dir>` 아래에 씁니다. render는 `<output>.<lang>[.draft].{mp4,srt,vtt,description.md}`와, 만들었을 때만 `.chapters.txt`·`.thumbnail.png`을 쓰고, 만들지 않은 쪽은 지난 파일을 지웁니다(다른 출력, draft와 draft 아닌 쪽, snapshot 파일은 건드리지 않습니다). 0이 아닌 코드로 끝나면 결과물
묶음은 보장되지 않습니다. 이름이 같은 대본 폴더 둘은 각자 `--out-dir`을 주지 않으면 `out/<이름>/`을
함께 씁니다. 같은 대본·출력·언어의 render와 snapshot은 작업 폴더를 함께 쓰므로 한 번에 하나씩 돌리세요.
`.s2v-cache/`는 언제든 지워도 됩니다. 그 안의 `render/`·`draft-audio/`·`check/`는 `<대본 폴더>-<해시>`로 나뉘며,
해시가 없는 폴더는 이전 버전의 것입니다. 결과물 폴더의 `*.tmp.*`는 중단된 실행이 남긴 것입니다. `dev`는 대본 폴더를 감시하므로 `--out-dir`은 그 밖에 두세요.

`snapshot --frames`는 모아 찍은 한 장 옆에 `<output>.<lang>.frames/`를 씁니다. 화면이 바뀌는 시점(첫 그림이 자리 잡은 뒤, 그림과 cue마다, 캐릭터의 얼굴과 기본 얼굴로 돌아갈 때, 무대 교체, 유지되는 동작)마다 원래 크기의 낱장을 장면당 최대 12장, 영상 전체 번호로, 그리고 낱장마다 장면·프레임·초·이유와 s2v id, 대본 sha256을 적은 `index.json`을 씁니다. 정지 화면의 캐릭터는 쉬는 자세입니다(숨쉬기·깜빡임·끄덕임 없음). 실행은 지난 정지 화면과 낱장을 먼저 지웁니다. `--frames` 없이 돌리면 낱장 폴더는 그대로입니다. `--frozen-audio`는 음성 lock을 그대로 쓰고, 음성이 없는 문장이 있으면 실패합니다. `script_sha256`은 대본만 보며 에셋과 캐릭터 그림은 보지 않습니다. 중단된 실행은 `<…>.frames.tmp/`를 남길 수 있습니다.

`inspect --json`은 영상을 검수하는 도구용입니다. 출력, 장면, 화면 글자, 목소리, 파일 목록과 함께 변경
종류별 해시(`content`, `voice`, `audio`, 출력마다 `presentation`, `engine`의 구성 요소)를 내므로, 바뀐
부분만 다시 검수할 수 있습니다. 형식에 없는 것(철자가 틀린 속성, 글자로 보일 자리의 지시문)이 있는
대본은 거부합니다. 계산할 수 없는 해시는 이유와 함께 `null`입니다. `engine`은 구성 요소별로 비교하세요.
`defaults_*`에 새 키가 생긴 것은 s2v에 새 필드가 생긴 것으로, 대본 해시에는 영향이 없습니다.

## 대본 쓰기

전체 문법은 [`.claude/skills/write-script/reference.md`](.claude/skills/write-script/reference.md)에 있습니다.
이 저장소에서 [Claude Code](https://claude.com/claude-code)를 쓰면 `write-script` 스킬이 블로그 글이나
문서를 대본으로 바꾸고, 대본을 번역하고, Shorts용 장면을 고르고, 1인 진행 ↔ 대화 형식을 바꿔 줍니다.
같은 레퍼런스를 따르며 결과에 `lint` / `check`를 실행합니다.

비주얼: `::title`, `::image`(확대, circle / box / highlight / spotlight / arrow 표시, 이미지 전환,
느린 Ken Burns 이동), `:::bullets`, `:::code`(줄 강조), `:::table`(행 강조), `:::chart`(막대),
`:::compare`(2–3열), `:::gallery`, `:::quote`, `:::markdown`, `:::split`(이미지 + 텍스트),
`:::diagram`(mermaid), `::video`.
소리: 말할 때 자동으로 작아지는 배경 음악, 합성 효과음(`sfx: auto`), 장면 페이드.
모양: `theme: light | dark`, 모서리 로고, `subtitleStyle`(크기, 위치, 색, 폰트).

## 대화와 페르소나 목소리

화자 수에는 제한이 없습니다. `cast:`에 정의하고 문단을 `name:`으로 시작하면 됩니다.
`layout: dialogue`에서는 화자가 2–4명이면 아바타가 나오고(말하는 사람 강조), 모든 자막에 색이 있는
이름 태그가 붙습니다. 5명 이상이면 이름 태그만 표시합니다.

페르소나는 설명문으로 설계한 목소리로, 기본 제공 화자 외에 화자를 더 늘릴 때 씁니다.

```sh
# voices/minsu.yaml  (대본 옆, 또는 여러 영상이 함께 쓰도록 레포 루트까지의 상위 폴더 어디든)
#   description: 30대 남성, 차분하고 약간 낮은 목소리, 또렷한 발음, 친근한 말투
node packages/cli/dist/main.js voice create voices/minsu.yaml --lang ko --candidates 4
# → 판정을 거쳐 통과한 후보부터 나열하고 청취 페이지를 만듭니다. 그중 하나를 고릅니다:
node packages/cli/dist/main.js voice pick voices/minsu.yaml 2 --lang ko
```

그다음 `cast:`에서 `voice: "persona:minsu"`를 씁니다. 모든 문장이 고른 음성을 복제해 합성하므로
목소리가 일정하게 유지됩니다. 설계한 목소리는 실존 인물을 흉내 내지 않습니다.

복제는 참조 음성의 잡음·리듬·끝맺음까지 따라 하므로 후보를 판정합니다: 틀리게 읽지 않았는지, 설명의
성별(`남성`/`male`/`男性` 또는 `여성`/`female`/`女性`)에 맞는 음높이인지, 잡음이 작은지, 문장 사이에 쉼이
있는지, 끝이 잘리지 않았는지. 숨소리는 지우지 않습니다. 이미 쓰는 음성은
`voice check voices/minsu.yaml`로 같은 판정을 해 볼 수 있습니다(원본 출력이 없는 마무리된 음성은 잡음과
끝맺음을 판정하지 않습니다).

**감정을 연기하는 페르소나.** 복제한 페르소나는 감정 지시를 따르지 못합니다. `s2v voice train
voices/minsu.yaml --lang ko`는 페르소나 목소리로 Qwen3-TTS CustomVoice 모델의 화자 줄 하나를 학습합니다(약
3시간: 학습 클립을 직접 만들고 판정한 뒤 학습. 다시 실행하면 이어서 하며, 캐릭터 이미지 생성 중에는 실행하지
마세요). `voices/minsu/ko.speaker.json`과 기준 음성을 쓰니 커밋하고, cast에 `personaModel: trained`를
적으세요. 학습한 화자는 기본 화자처럼 `emo`·`say`·`style`을 따르고, 강한 문장은 "Sound very …"로
말합니다. 예시 guest에서는 `happy`·`excited`가 기본보다 `power=strong`일 때 더 기쁘게 들리는 경우가 많았고,
`excited` 문장이 화나게 들리기도 했습니다 — 테이크 페이지에서 듣고 `power=strong`이나 `emo` 없이도 시도해 보세요. 감정 클립이 150개
미만으로 통과하면 두 번째 학습 전에 멈춥니다(`--min-emotion`으로 바꿈). 지금은 한국어만.

**모든 문장이 같은 목소리로.** 목소리마다(페르소나, `style`을 포함한 기본 화자, Supertonic 목소리) 기준
음성이 있습니다. 고정 문장 20테이크를 한 번 재서 커밋합니다(`voices/<id>/<lang>.f0.json`,
`voices/_qwen/…`, `voices/_supertonic/…`). `tts`는 없으면 만들고(몇 분, 판정에 Base 모델을 함께 올려 메모리를 약 4GB 더 씀), 새 테이크마다 음높이와
목소리 닮음(Qwen3-TTS Base 모델의 speaker encoder)을 기준과 비교합니다. 벗어난 테이크는 다른 시드로
다시 만듭니다(최대 6테이크). 이미 오디오 lock에 있는 문장은 `tts --recheck`를 실행할 때만 다시
판정합니다. `voice refs <script>`는 기준 음성을 보여 주고, `--refresh` 뒤에는 이제 실패하는 lock 문장을
알려 줍니다.

### 대사 연기

화자 접두에 감정을 적습니다: `mina{emo=sad}: 그럴 줄 알았어.` 감정은
`neutral happy sad angry surprised anxious excited calm serious puzzled moved playful`이고, frontmatter의
`acting.emotions`로 직접 만들 수도 있습니다(`sleepy: { voice: "Sound drowsy and slow.", face: calm,
speed: 0.8, maxPause: 1.5 }`). 감정은 목소리(Qwen 프리셋 화자는 감정 지시를 따름), 캐릭터의 같은 이름
표정(없으면 기본 표정, 만들 표정은 `s2v character missing`이 알려 줌), 모션을 정합니다. 문장 사이에
`:emo{emo=sad}`를 두면 다음 문장부터 바뀝니다: `mina{emo=calm}: 괜찮았어요. :emo{emo=sad}그런데요.`

| 속성                |                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emo=`              | 감정                                                                                                                                                                                      |
| `power=weak/strong` | 세기(감정이 있는 Qwen 프리셋 화자와 학습한 페르소나는 가장 약한 / 강한 테이크, 학습한 페르소나의 강한 문장은 "Sound very …"로 말함; 복제한 페르소나·Supertonic 목소리는 조금 작게 / 크게) |
| `say="…"`           | 이 대사만의 자유 지시(Qwen 프리셋 화자만)                                                                                                                                                 |
| `volume=soft/loud`  | 믹스에서 −6 / +3 dB                                                                                                                                                                       |
| `speed=0.8–1.25`    | cast의 `speed`와 곱함                                                                                                                                                                     |

감정은 말 자체에 감정이 실린 대사에 적으세요. 지시만으로 평범한 문장을 기쁘게 만들 수는 없습니다.
복제한 persona·Supertonic 목소리는 감정을 연기하지 못합니다(표정과 모션은 바뀜). 학습한 persona는
연기합니다. 한국어 감정 대사의 새
테이크는 숨소리·한숨·긴 쉼·부자연스러운 길이를 검사하고, 걸리면 다시 만듭니다. 이 속성이 없는 대사의
소리는 그대로입니다.

**감정 대사의 테이크.** Qwen 프리셋 화자의 감정 대사는 `tts`가 테이크를 3개 만들고, 둘이 통과할
때까지 더 만듭니다(최대 6개). happy·excited·playful·angry·moved 대사는 말끝이 처지지 않는 테이크가
나올 때까지도 만듭니다. 연기의 세기로 하나를 고릅니다: 가운데쯤, calm·sad·serious·moved는 가장 약한
것, 또는 `power`대로. 같은 문단의 바로 앞 문장과 감정·`power`·속도·`say`가 같으면 음높이와 빠르기가
앞 문장에 가장 가까운 쪽으로 기웁니다. 이미 오디오 lock에 있는 문장은 테이크가 바뀌지 않습니다.
`tts --retry <id>`는 지금까지 만든 테이크 뒤로 새 테이크 3개를 만들고, 통과한 것이 없으면 lock의
테이크를 그대로 둡니다. `tts`는 먼저 예상 시간을 알려 줍니다.

**테이크 직접 고르기.** `s2v takes <script>`는 청취 페이지를 엽니다. 감정 대사와 직접 고른 대사(`--all`이면 모든 대사)의
모든 테이크를 단독으로, 또는 앞뒤 문장과 이어서 영상과 같은 음량으로 들을 수 있고, 라디오로 고른 것이
복사할 `s2v takes pick …`(과 `unpick`) 명령이 됩니다. 서버는 띄우지 않습니다. `s2v takes <script> --list`는 같은
테이크를 wav 경로와 함께 텍스트로 보여 줍니다. `s2v takes pick <script> 1:0:2=3 1:2:0=1`은 `1:0:2`의 테이크 3과
`1:2:0`의 테이크 1을 고르고, 다음 `tts`가 그 테이크를 오디오 lock에 넣습니다. 고른 것은 lock 옆
`audio/<lang>/picks.json`에 저장되니 커밋하세요. 속도(Qwen·persona 목소리 — Supertonic은 속도가 목소리의 일부)·쉼·후처리만 바뀌면 그대로 남고, 대사·목소리·연기·
`power`가 바뀌면 적용되지 않습니다(`tts`가 옛 대사와 새 대사를 나란히 알려 줌). `tts --retry <id>`의
선택도 pick으로 저장됩니다. 장면 전체를 retry하면 직접 고른 문장은 건너뜁니다. `s2v takes unpick
<script> <id>`로 자동 선택으로 돌아가고, `audio prune`은 쓰이지 않는 pick을 지웁니다.

**감독 노트.** `s2v direct <script> [--output youtube]`는 출력 하나의 연출 계획을 페이지
(`out/<video>/direct/<output>.<lang>.html`)로 만듭니다. 문단마다 시각, 화자, 감정, 얼굴과 모션, 시선과 반응,
앞 간격(리듬 규칙 포함)을 보여 줍니다. 음성이 없어도 됩니다. 지금 대본으로 합성된 문장은 실제 길이를,
나머지는 추정 길이(`~` 표시)를 씁니다. 위쪽의 노트는 영상이 단조로워 보일 만한 곳에서 해 볼 것을
알려 줍니다: 긴 대화에 감정이 하나도 없음, 같은 감정이 여러 문단 연속, 한 사람이 여러 문단 연속으로 말함,
30초 동안 청자 반응 없음(캐릭터가 있고 대기 동작을 끈 경우만), 학습한 persona의 happy·excited 대사. 오류가 아니라 조언입니다.

### 캐릭터

화자에게 캐릭터 그림을 주면 화면 왼쪽 아래나 오른쪽 아래에 섭니다. 한쪽에는 한 번에 한 캐릭터만
서고(같은 쪽 화자는 번갈아 등장), 화면에는 최대 두 명이 나옵니다. 말하는 캐릭터는 밝게 표시되고,
입은 목소리에 맞춰 움직이며, 쉬는 캐릭터는 눈을 깜빡이고, 자막은 꼬리가 달린 채 화자 옆으로 옮겨
갑니다. 캐릭터 그림이 없으면 자막은 가운데에 있습니다.

```yaml
cast:
  mina: { voice: 'qwen:Sohee', character: characters/mina, side: left }
  joon: { voice: 'persona:joon', character: { dir: characters/joon, facing: right } }
```

표정은 문단마다 고릅니다: `mina{face=happy}: 정말요?`. 표정이 바뀌면 짧은 동작도 함께 나옵니다
(surprised → jump, happy → bounce, angry → shake, sad → sink). `motion=nod`로 동작을 고르거나
(jump, shake, nod, bounce, shiver, sink, lean), `motion=none`으로 빼거나, 출연자에 `motion: off`를
지정할 수 있습니다. 듣는 사람은 특정 단어부터 반응하게 할 수 있습니다:
`mina: :react{joon=surprised}와, 정말요?`(문단 끝까지 유지). 반응하는 캐릭터는 같은 쪽이어도
무대에 오릅니다. 같은 쪽에 여러 명이면 반응하는 동안 작아져서 나란히 섭니다
(`:react{joon=surprised yuna=surprised}`).

`:look{mina=viewer}`로 캐릭터가 어디를 볼지 고릅니다: `partner`(기본 자세, 상대 쪽으로 조금 돌아섬),
`viewer`(시청자를 봄, `front-<face>` 그림), `glance`(몸은 시청자 쪽, 머리만 상대 쪽, `glance-<face>` —
`viewer`와 짝으로 씀). 말하는 사람 자신의 `:look`은 문장 맨 앞이면 그 문장부터(문장 가운데면 다음
문장부터), 듣는 사람의 `:look`은 그 단어부터 문단 끝까지 또는 다음 `:look`까지입니다(`partner`로 되돌림).
생성 캐릭터(`preset: standard@1`)에는 이 그림들이 있고, classic 폴더는 `front-happy.png` 같은 파일이
있어야 하며 없으면 표정이 그대로입니다(lint가 알려 줌). 얼굴 클로즈업에서도 시선이 바뀝니다: 생성
캐릭터는 몸이 보이지 않으므로 `partner`와 `glance`가 같은 그림(머리를 상대 쪽으로 돌림)이고 `viewer`는
시청자를 봅니다. classic 폴더는 전신과 같이 `front-<face>.png`, `glance-<face>.png`를 씁니다.

캐릭터가 무대에 들어오고 나갈 수 있습니다: 장면의 첫 문단 앞에 `::enter{joon}`을 두면 장면이 시작될 때
joon이 자기 쪽 옆에서 미끄러져 들어오고(joon이 장면의 첫 대사를 하면 들어온 뒤에 시작),
`::exit{joon}`을 두면 그 장면의 대사·반응과 표정 유지가 끝난 뒤 미끄러져 나갑니다(보이도록 장면이 조금
길어짐). 이름 여러 개를 한 번에 쓸 수 있습니다(`::enter{joon yuna}`). 그 장면에서
들어오는 캐릭터가 자기 쪽에서 가장 먼저 말해야 하며, 아니면 등장은 무시됩니다. 나간 뒤 그쪽은 다음 화자가 말할 때까지 비어
있습니다. 그 출력에서 말하거나 반응하는 캐릭터만, 캐릭터 그림이 있을 때만 들어오고 나갑니다. 장면을
골라 쓰는 출력에서 순서가 어긋나면(나간 캐릭터가 다시 말함) lint가 경고하고 평소처럼 올라옵니다.

```md
::enter{joon}
joon: 늦어서 죄송해요.
```

캐릭터는 스스로도 조금씩 움직입니다: 숨을 쉬고, 2–6초마다(그리고 표정이 바뀔 때) 눈을 깜빡이며,
듣는 캐릭터는 상대 문장이 끝날 때 가끔 끄덕입니다(질문 뒤나 바로 대답할 때는 아님). 끄려면
frontmatter에 `acting: { idle: false }`를 적고(그러면 깜빡임은 4초에 한 번), `s2v render … --idle on|off`로
어느 쪽이든 시험해 볼 수 있습니다. 스냅숏과 썸네일에서는 눈을 감지 않습니다.

문단 사이 간격은 내용을 따릅니다(리듬): 다른 사람의 질문에 대한 대답은 더 빨리(×0.6, 질문은 `?`로
끝나는 줄), 앞 문단과 감정이 다른 문단 앞에는 숨을 한 번(×1.3), 슬프거나 감동하거나 진지한 문단
뒤에는 여운을(×1.4) 두고, 이 간격들은 조금씩 달라집니다(±12%). 직접 쓴 간격(`gap=`), 쉼, 장면 사이
간격, 문장 사이 간격은 그대로이고, 장면을 넘어서는 적용되지 않으며(장면 마지막 문단이 슬퍼도 장면 사이
간격은 그대로) 소리도 바뀌지 않습니다. 문단의 감정은 그 문단의 `emo`(또는 문단 맨 앞의 `:emo`)입니다.
리듬은 기본으로 켜져 있고, `acting: { rhythm: false }`로 모든 간격을 예전처럼 고르게 할 수 있습니다(예전
영상을 똑같이 다시 만들 때). 객체로 배수를 정할 수 있습니다:
`acting: { rhythm: { answer: 0.8, emotion: 1.2, linger: 1.6, jitter: 0 } }`(필요한 것만). 출력마다
`outputs.shorts.rhythm`(`false`, 또는 대본 설정 위에 덮어쓸 배수)으로 정할 수 있고,
`s2v render|snapshot|timeline … --rhythm on|off`로 시험해 볼 수 있습니다(`timeline`은 간격마다 적용된
규칙을 stderr에 보여 줌).

캐릭터 폴더는 두 가지 형식 중 하나입니다.

**전체 그림.** **같은 캔버스**(같은 크기, 같은 몸 위치)에 그린 투명 PNG를 표정마다 넣습니다.
`facing`은 그림이 바라보는 방향(`left` / `right` / `front`)이고, 화면 바깥쪽을 보는 그림은
가운데를 보도록 좌우 반전됩니다.

| 파일                                                      |                                       |
| --------------------------------------------------------- | ------------------------------------- |
| `neutral.png`                                             | 입 닫음(필수, 기본 표정)              |
| `neutral-talk.png`                                        | 입 벌림(이 파일이 있어야 입이 움직임) |
| `neutral-half.png`                                        | 입 반쯤 벌림(선택, 더 부드러워짐)     |
| `neutral-blink.png`                                       | 눈 감음(선택)                         |
| `happy.png`, `sad.png`, `surprised.png`, … (+ `-talk`, …) | 다른 표정                             |

**레이어 부품**(폴더에 `character.yaml`이 있는 경우). 몸, 머리, 입·눈 부품을 렌더할 때 합성합니다.
face는 yaml에서 이름을 붙인 조합입니다: view(몸 각도), 선택적인 포즈, 선택적인 머리 돌림, 표정.
머리가 따로 움직이므로(`head-nod`, `head-tilt`) 듣거나 생각하는 모습이 살아납니다. 생성한 캐릭터와
손으로 그린 캐릭터가 이 형식입니다. YMM4 소재도 `character.yaml`을 가지며, face가 부품 폴더마다
이미지 하나를 고릅니다. 전신(full)으로만 그리고 머리 모션은 없습니다:

```sh
# YMM4 「動く立ち絵」 소재(폴더 또는 zip). 이용 약관 파일도 함께 복사합니다
node packages/cli/dist/main.js character import ~/Downloads/zundamon.zip --out characters/zunda
# → characters/zunda/character.yaml(초안. parts.html에서 모든 부품을 보며 face를 만듭니다)
```

**framing.** 생성하거나 손으로 그린 레이어 캐릭터는 전신(`full`, 기본), 허리 위(`upper`), 얼굴
클로즈업(`head`)으로 그릴 수 있고, 장면마다 고릅니다. 장면의 첫 문단 앞에 `::shot`을 둡니다.
이름을 적지 않은 캐릭터는 직전 장면의 framing을 이어받습니다:

```markdown
# 클로즈업 {#how}

::shot{mina=head joon=upper}
```

`::shot{mina=full}`로 되돌립니다. 출력에 `shot: full`을 주면(`outputs.shorts.shot: full`) 그
출력에서는 `::shot`을 무시합니다. framing마다 이미지가 따로 필요합니다(yaml의 `sets.upper` /
`sets.head` 세트). 장면이 쓰는 face를 그 framing이 갖고 있지 않으면 `lint`가 알려 줍니다.

### 캐릭터 생성 (선택, Apple Silicon)

script2video는 로컬 이미지 편집 모델(Qwen-Image-Edit-2511과 8단계 Lightning LoRA, 둘 다
Apache-2.0, MLX로 실행)로 오리지널 레이어 캐릭터를 그릴 수 있습니다. 모든 이미지는 **직접 고른 정면
이미지 하나**를 편집해서 만들기 때문에 캐릭터가 바뀌지 않습니다. 라운드마다 확인하고 승인해야 다음
라운드가 시작됩니다.

Apple Silicon Mac, **메모리 48GB 이상**(권장 64GB: 모델 준비 때 약 32GB, 생성 때 약 22GB까지
씁니다), **디스크 약 85GB**가 필요합니다(`S2V_MODELS_DIR`로 모델을 다른 디스크에 둘 수 있습니다).
이미지 한 장에 약 4분 걸립니다.

```sh
node packages/cli/dist/main.js character setup        # 환경, 다운로드, 4비트 모델(한 번만)

# 1. character.yaml이 있는 폴더: `kind`에 디자인을 적습니다
node packages/cli/dist/main.js character create characters/mina --candidates 4
#    → 고를 정면 이미지 4장(확인 페이지가 열립니다)
node packages/cli/dist/main.js character pick characters/mina 2

# 2. 나머지는 라운드별로: 기준 → 몸 → 포즈 → 표정 → 입·눈 프레임
node packages/cli/dist/main.js character build characters/mina --dry-run   # 다음 라운드에 만들 것
node packages/cli/dist/main.js character build characters/mina
#    → 확인 페이지: 이미지마다 검사 결과와 입 모양 미리보기
node packages/cli/dist/main.js character approve characters/mina --all     # 검사를 통과한 것만
node packages/cli/dist/main.js character redo characters/mina front/base/happy   # 다른 시드로
```

`preset: standard@1`(`create`가 만드는 yaml에 들어 있음)은 미리 준비된 face 세트입니다:

- `neutral`, `happy`, `sad`, `angry`, `surprised`, `anxious`, `excited`, `calm`, `serious`,
  `puzzled`, `moved`, `playful`: 상대 화자 쪽으로 살짝 돌린 자세(대화의 기본 자세)
- `front-<표정>`: 시청자를 바라봄(시청자에게 말할 때)
- `glance-neutral`, `glance-surprised`, `glance-happy`, `glance-puzzled`: 머리만 돌림
- `wave`, `point`, `akimbo`, `cheer`, `arms-crossed`, `hands-together`: 포즈
- 얼굴 클로즈업 세트: 위의 모든 face — 돌아선 face와 glance는 머리를 돌리고, 포즈는 그 표정으로

`exclude: [angry, point]`로 일부를 빼고, 직접 쓴 `faces:`, `expressions:`, `sets:`로 preset에
더하거나 바꿉니다. 세트 전체는 약 220장(15–16시간, 한 번만)이고, 그 뒤로 캐릭터는 라이브러리가
됩니다. 대본에 라이브러리에 없는 face가 필요하면:

```sh
node packages/cli/dist/main.js character missing videos/demo/script.ko.md [--apply]
# → 정의되지 않은 것, framing 세트에 없는 것(--apply가 추가), 아직 승인되지 않은 것
```

바뀐 것만 다시 만듭니다. 이미지마다 만들 때의 정의를 기록하므로(`provenance.json`) 멈춘 라운드는
이어서 하고, 프롬프트를 고치면 그 이미지만 다시 만듭니다. TTS 서버나 정렬 서버가 떠 있으면 생성을
시작하지 않고(각각 수십 GB를 씁니다), 메모리가 바닥나기 전에 감시자가 멈춥니다.

## 재현 가능한 렌더링 (Docker)

TTS는 호스트에서 실행합니다(모델이 필요하고, macOS에서는 MPS를 씁니다). 결과는 대본 옆
`audio/<lang>/`에 잠기고, 이미지는 그 잠금에서 네트워크 없이 렌더링합니다.

```sh
docker build -t script2video-render .
docker run --rm --network none -v "$PWD/videos:/videos" -v "$PWD/out:/app/out" \
  script2video-render render /videos/sample-ko/script.ko.md --output youtube
```

같은 이미지와 같은 오디오 잠금이면 바이트 단위로 같은 결과가 나옵니다. macOS와 Docker의 결과는
다르므로(폰트 래스터화와 ffmpeg 빌드 차이), 같은 환경 안에서 비교하세요.
이미지는 로컬용입니다. Debian의 GPL 라이선스 ffmpeg가 들어 있으므로 공개 배포하지 마세요.

## 대본 형식 (맛보기)

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

- `# 제목 {#id}`로 장면(그리고 YouTube 챕터)이 시작되고, `::image` / `::title` / `:::bullets`가 비주얼을 정합니다.
- `:cue[문구]{...}`는 그 문구를 말하는 순간에 확대하거나 표시합니다.
- 문단 앞의 `name:`으로 화자를 고릅니다. 엔진이 다른 목소리를 섞어 써도 됩니다.
- 자세한 내용: [레퍼런스](.claude/skills/write-script/reference.md).
