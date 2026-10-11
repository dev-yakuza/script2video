# script2video

[English](README.md) | **한국어** | [日本語](README.ja.md)

Markdown 대본을 쓰면 내레이션이 들어간 설명 영상이 만들어집니다. 한국어·영어·일본어를 지원하고, 음성은 로컬에서 돌아가는 오픈소스 TTS로 합성합니다. 말하는 타이밍에 맞춰 직접 찍은 스크린샷을 확대하고 강조할 수 있습니다. 같은 대본과 같은 환경이면 같은 영상이 나옵니다. 하나의 대본에서 YouTube(16:9)와 Shorts(9:16)를 함께 만듭니다.

> **상태:** 정식 공개 전(v0.1.0). 1.0 전까지 대본 형식이 바뀔 수 있습니다.

**샘플** (모든 에셋은 이 프로젝트용으로 만든 CC0): `videos/sample-ko`(한국어 진행자 + 대화 한 줄),
`videos/sample-dialogue-ko`(캐릭터 두 명, 반응, 효과음), `videos/sample-en`(영어, 다크 테마, 차트와 비교).

## 라이선스 안내 (업무에 쓰기 전에 읽어 주세요)

- script2video 자체는 **MIT**입니다.
- 렌더링에 쓰는 **[Remotion](https://www.remotion.dev/)** 은 별도 라이선스입니다. 개인과 3명 이하 조직은 무료이고, **그보다 큰 영리 조직은 Remotion Company License가 필요합니다.** [remotion.dev/license](https://www.remotion.dev/docs/license)를 확인하세요.
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

| 명령어                                                       | 하는 일                                         |
| ------------------------------------------------------------ | ----------------------------------------------- |
| `doctor`                                                     | Node, ffmpeg, uv, Python 환경, 모델, 폰트 점검  |
| `new <dir> [--lang ko]`                                      | 시작용 대본이 든 새 영상 폴더 만들기            |
| `lint <script>`                                              | 정적 검사: 문법, 에셋, 발음, 자막 분량, 길이    |
| `check <script>`                                             | 모든 자막을 실제 렌더러로 배치해 넘침 확인      |
| `sentences <script>`                                         | 문장 id 목록(`tts --retry`용)                   |
| `say "<text>" --script <script>`                             | 한 문장을 합성해 재생(발음 확인)                |
| `tts <script> [--retry id]`                                  | 오디오 잠금에 합성(바뀐 부분만)                 |
| `render <script> --output <name> [--draft] [--frozen-audio]` | 영상 + `.srt` `.vtt` 챕터, 설명문 초안, 썸네일  |
| `snapshot <script> --output <name>`                          | 장면마다 정지 화면 한 장을 모아 몇 초 만에 확인 |
| `dev <script> [--video]`                                     | 편집 루프: 저장할 때마다 lint → tts → snapshot  |
| `pick <image>`                                               | 스크린샷을 클릭 / 드래그해 cue 좌표 얻기        |
| `voice create / pick`                                        | 페르소나 목소리를 설계하고 후보 중에서 고르기   |
| `audio prune <script>`                                       | 대본에서 더 이상 쓰지 않는 음성 삭제            |
| `export-script <script>`                                     | 내레이션을 직접 녹음할 때 읽을 대본 만들기      |
| `import-recording <script> <take.wav> [--write]`             | 한 번에 녹음한 파일을 문단별로 나누기(`:audio`) |
| `tts-server start`                                           | 명령어 사이에 TTS 서버를 계속 띄워 두기         |

`node packages/cli/dist/main.js <command> …` 형태로 실행합니다. `S2V_TTS=mock`을 붙이면 모델 없이
합성 음성으로 전체를 돌려 볼 수 있어 레이아웃 작업과 CI에 편리합니다.

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
# voices/minsu.yaml  (대본 옆, 또는 여러 영상이 함께 쓰도록 상위 폴더에)
#   description: 30대 남성, 차분하고 약간 낮은 목소리, 또렷한 발음, 친근한 말투
node packages/cli/dist/main.js voice create voices/minsu.yaml --lang ko --candidates 4
# → 음높이 / 속도 / 오독 표시가 붙은 후보와 청취 페이지. 그중 하나를 고릅니다:
node packages/cli/dist/main.js voice pick voices/minsu.yaml 2 --lang ko
```

그다음 `cast:`에서 `voice: "persona:minsu"`를 씁니다. 모든 문장이 고른 음성을 복제해 합성하므로
목소리가 일정하게 유지됩니다. 설계한 목소리는 실존 인물을 흉내 내지 않습니다.

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

캐릭터 폴더에는 **같은 캔버스**(같은 크기, 같은 몸 위치)에 그린 투명 PNG를 표정마다 넣습니다.

| 파일                                                      |                                       |
| --------------------------------------------------------- | ------------------------------------- |
| `neutral.png`                                             | 입 닫음(필수, 기본 표정)              |
| `neutral-talk.png`                                        | 입 벌림(이 파일이 있어야 입이 움직임) |
| `neutral-half.png`                                        | 입 반쯤 벌림(선택, 더 부드러워짐)     |
| `neutral-blink.png`                                       | 눈 감음(선택)                         |
| `happy.png`, `sad.png`, `surprised.png`, … (+ `-talk`, …) | 다른 표정                             |

표정은 문단마다 고릅니다: `mina{face=happy}: 정말요?`. 표정이 바뀌면 짧은 동작도 함께 나옵니다
(surprised → jump, happy → bounce, angry → shake, sad → sink). `motion=nod`로 동작을 고르거나
(jump, shake, nod, bounce, shiver, sink, lean), `motion=none`으로 빼거나, 출연자에 `motion: off`를
지정할 수 있습니다. 듣는 사람은 특정 단어부터 반응하게 할 수 있습니다:
`mina: :react{joon=surprised}와, 정말요?`(문단 끝까지 유지). 반응하는 캐릭터는 같은 쪽이어도
무대에 오릅니다. 같은 쪽에 여러 명이면 반응하는 동안 작아져서 나란히 섭니다
(`:react{joon=surprised yuna=surprised}`). `facing`은 그림이 바라보는 방향(`left` / `right` /
`front`)이고, 화면 바깥쪽을 보는 그림은 가운데를 보도록 좌우 반전됩니다.

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
