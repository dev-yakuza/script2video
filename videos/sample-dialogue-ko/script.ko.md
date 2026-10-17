---
title: script2video 대화 샘플
lang: ko
cast:
  host: { voice: "qwen:Sohee", name: 소희, color: "#2563EB", style: "차분하고 친근한 설명 톤", character: characters/host }
  guest: { voice: "persona:guest", personaModel: trained, name: 민수, color: "#EA580C", character: { dir: characters/guest, facing: right } }
outputs:
  youtube: { aspect: "16:9", layout: dialogue }
  shorts: { aspect: "9:16", layout: dialogue, scenes: [how] }
pronounce:
  script2video: 스크립트 투 비디오
sfx: auto
transition: fade
---

# 소개 {#intro}

::title[대본으로 만드는 대화 영상]

host: 오늘은 script2video로 대화 영상을 만들어 볼게요.

guest{face=surprised}: 대본만 쓰면 영상이 나온다고요?

# 만드는 법 {#how}

::image{src=assets/settings.png}

host: 대본에 :cue[설정 버튼]{x=0.95 y=0.05 zoom=2 mark=circle}을 누른다고 쓰면, 그 단어에서 화면이 확대돼요.

guest: :react{host=happy}목소리와 표정도 대본에서 정하는 거죠?

host{face=happy}: 네, 캐릭터와 자막도 자동으로 맞춰져요.
