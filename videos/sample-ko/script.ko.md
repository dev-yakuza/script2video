---
title: script2video 샘플
lang: ko
cast:
  host: { voice: "qwen:Sohee", style: "차분하고 친근하게" }
  mina: { voice: "supertonic:F1" }
outputs:
  youtube: { aspect: "16:9", layout: presenter }
  shorts: { aspect: "9:16", layout: shorts, scenes: [settings] }
pronounce:
  CLI: 씨엘아이
---

# 코드로 영상 만들기 {#intro}

::title[대본 하나로 영상 만들기]

안녕하세요. 오늘은 CLI 하나로 해설 영상을 만들어 보겠습니다.

mina: 정말 대본만 쓰면 되나요?

# 설정 화면 {#settings}

::image{src=assets/settings.png bg=blur}

오른쪽 위의 :cue[설정 버튼]{x=0.957 y=0.025 zoom=3 mark=circle}을 누르면 :pause[0.4]
새 :cue[프로젝트]{x=0.258 y=0.285 zoom=2 mark=box}를 만들 수 있습니다.

:only{youtube} 영상이 도움이 됐다면 구독 부탁드려요.
