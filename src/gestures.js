// Hand shape dictionary: sign language handshapes and alphabets, counting,
// greetings, rude gestures, sports signals and grips, as joint angles.
//
// Each entry is a static hand shape (one hand). Orientation and movement are
// not stored: signs that differ only by palm direction (ASL H/U, K/P, G/Q)
// share a shape, and moving signs (ASL J, Z) store their starting shape.
// Angles are authored from anatomy and common descriptions, so they are
// approximations; entries marked `verify` are the least certain.
//
// Angle layout (degrees, abduction positive toward the thumb, as in fit.js):
//   thumb:  [cmcFlex, cmcAbd, cmcRoll, mcpFlex, mcpAbd, mcpRoll, ipFlex]
//   finger: [mcpFlex, mcpAbd, mcpRoll, pipFlex, dipFlex]
// Thumb CMC flexion brings the thumb out in front of the palm (opposition),
// CMC abduction swings it out sideways in the palm plane (an L), negative
// abduction lays it against the index side.
import { localFrom } from './fit.js';

const KEYS = ['index', 'middle', 'ring', 'pinky'];

// Finger shapes: [mcpFlex, pipFlex, dipFlex].
const F = {
  E: [0, 0, 0], // straight
  C: [85, 100, 70], // curled into the palm (fist)
  B: [85, 5, 5], // bent at the knuckle only
  H: [5, 95, 70], // hooked: knuckle straight, the rest curled (claw)
  R: [35, 45, 30], // rounded, as around a ball (C shape)
  O: [50, 60, 40], // rounded until the tip meets the thumb
  X: [25, 95, 65], // hooked index (ASL X)
  h: [50, 55, 35], // half closed
  K: [20, 15, 10], // slightly bent (relaxed)
  T: [70, 90, 50], // tucked under the thumb (ASL E, M, N)
};

// Thumb shapes.
const T = {
  out: [0, 0, 0, 0, 0, 0, 0], // relaxed, out to the side
  L: [0, 40, 0, 0, 0, 0, 0], // swung wide (L, gun)
  side: [5, -30, 0, 5, 0, 0, 0], // against the side of the index (ASL A)
  up: [0, -15, 0, 0, 0, 0, 0], // raised along the hand (thumbs-up)
  across: [40, -30, 0, 40, 0, 0, 30], // folded across the palm (B, 4)
  wrap: [21, 0, -2, 41, -10, 0, 36], // over the curled index and middle (S, fist)
  tuck: [45, -30, 0, 55, 0, 0, 45], // under the curled fingertips (E)
  touchI: [35, -5, 0, 25, -10, 0, 20], // tip on the index tip (O, F, OK)
  touchM: [45, -15, 0, 30, -10, 0, 20], // on the middle tip
  touchR: [52, -22, 0, 35, -10, 0, 25], // on the ring tip
  touchP: [55, -30, 0, 40, -10, 0, 30], // on the little finger tip
  between: [30, -12, 0, 30, 0, 0, 5], // pushed between index and middle (fig, T)
  overIndex: [20, -20, 0, 15, -10, 0, 0], // pad across the bent index (finger heart)
  C: [25, 10, 0, 15, 0, 0, 15], // curved opposite the fingers (C)
  pinch: [30, 0, 0, 20, -8, 0, 15], // pad to pad with the index (pinch)
  key: [5, -25, 0, 25, 0, 0, 25], // pad on the side of the index (key grip)
  ext: [0, 20, 0, -10, 0, 0, -10], // stretched out (5, high five)
};

const SPREAD = { index: 10, middle: 0, ring: -8, pinky: -16 };

// [id, Korean name, category, thumb, fingers (index middle ring pinky), options]
// options: s (spread), abd {finger: deg}, region, note, verify
const RAW = [
  // --- 수어 기본 손모양 (handshapes shared by most sign languages) ---
  ['hs-A', 'A (엄지 옆 주먹)', 'handshape', 'side', 'CCCC'],
  ['hs-S', 'S (엄지 감싼 주먹)', 'handshape', 'wrap', 'CCCC'],
  ['hs-B', 'B (편 손, 엄지 접음)', 'handshape', 'across', 'EEEE'],
  ['hs-openB', '열린 B (엄지 편 손)', 'handshape', 'out', 'EEEE'],
  ['hs-bentB', '꺾인 B', 'handshape', 'across', 'BBBB'],
  ['hs-5', '5 (손가락 벌림)', 'handshape', 'ext', 'EEEE', { s: 1 }],
  ['hs-claw5', '갈고리 5', 'handshape', 'L', 'HHHH', { s: 1 }],
  ['hs-C', 'C', 'handshape', 'C', 'RRRR'],
  ['hs-O', 'O', 'handshape', 'touchI', 'OOOO'],
  ['hs-flatO', '납작 O', 'handshape', 'pinch', 'BBBB', { verify: true }],
  ['hs-1', '1 (검지)', 'handshape', 'wrap', 'ECCC'],
  ['hs-X', 'X (구부린 검지)', 'handshape', 'wrap', 'XCCC'],
  ['hs-L', 'L', 'handshape', 'L', 'ECCC'],
  ['hs-bentL', '꺾인 L', 'handshape', 'L', 'BCCC'],
  ['hs-Y', 'Y', 'handshape', 'L', 'CCCE', { abd: { pinky: -20 } }],
  ['hs-V', 'V', 'handshape', 'wrap', 'EECC', { abd: { index: 10, middle: -10 } }],
  ['hs-bentV', '구부린 V', 'handshape', 'wrap', 'HHCC', { abd: { index: 10, middle: -10 } }],
  ['hs-U', 'U / H (붙인 두 손가락)', 'handshape', 'wrap', 'EECC', { abd: { index: -3, middle: 3 } }],
  ['hs-3', '3 (엄지·검지·중지)', 'handshape', 'L', 'EECC', { abd: { index: 10, middle: -8 } }],
  ['hs-W', 'W (세 손가락)', 'handshape', 'touchP', 'EEEC', { abd: { index: 8, ring: -8 } }],
  ['hs-4', '4', 'handshape', 'across', 'EEEE', { s: 1 }],
  ['hs-I', 'I (새끼손가락)', 'handshape', 'wrap', 'CCCE'],
  ['hs-horns', '뿔 (검지·소지)', 'handshape', 'wrap', 'ECCE', { abd: { index: 8, pinky: -15 } }],
  ['hs-ILY', 'ILY (사랑해)', 'handshape', 'L', 'ECCE', { abd: { pinky: -15 } }],
  ['hs-F', 'F (OK 모양)', 'handshape', 'touchI', 'OEEE', { s: 1 }],
  ['hs-8', '8 (중지 접어 엄지와)', 'handshape', 'touchM', 'EOEE', { s: 1, verify: true }],
  ['hs-K', 'K / P', 'handshape', 'between', 'EKCC', { abd: { index: 8, middle: -12 }, verify: true }],
  ['hs-R', 'R (꼰 손가락, 근사)', 'handshape', 'wrap', 'EECC', { abd: { index: -12, middle: 12 }, note: '손가락을 꼬는 동작은 회전 근사', verify: true }],
  ['hs-G', 'G / Q', 'handshape', 'up', 'BCCC', { note: '검지와 엄지가 나란히', verify: true }],
  ['hs-T', 'T (엄지를 검지 아래로)', 'handshape', 'between', 'TCCC'],
  ['hs-M', 'M', 'handshape', 'tuck', 'TTTC', { verify: true }],
  ['hs-N', 'N', 'handshape', 'tuck', 'TTCC', { verify: true }],
  ['hs-E', 'E', 'handshape', 'tuck', 'TTTT'],
  ['hs-D', 'D', 'handshape', 'touchM', 'EOOO'],

  // --- 미국 수어 알파벳 (ASL fingerspelling; shape only) ---
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => {
    const map = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', H: 'U', I: 'I', J: 'I', K: 'K', L: 'L', M: 'M', N: 'N', O: 'O', P: 'K', Q: 'G', R: 'R', S: 'S', T: 'T', U: 'U', V: 'V', W: 'W', X: 'X', Y: 'Y', Z: '1' };
    const note = { H: '손바닥 옆으로 (U와 같은 모양)', J: 'I 모양으로 J를 그림', P: 'K를 아래로', Q: 'G를 아래로', Z: '검지로 Z를 그림' }[c];
    return ['asl-' + c, `ASL ${c}`, 'asl', { ref: 'hs-' + map[c] }, null, { note, region: '미국' }];
  }),

  // --- 한국 지문자 (shape only; palm direction makes the letter) ---
  ['ksl-g', 'ㄱ', 'ksl', 'L', 'ECCC', { note: '손등이 보이게, 검지 아래로', region: '한국', verify: true }],
  ['ksl-n', 'ㄴ', 'ksl', 'L', 'ECCC', { note: '검지 위로, 엄지 옆으로', region: '한국', verify: true }],
  ['ksl-d', 'ㄷ', 'ksl', 'L', 'EECC', { abd: { index: -3, middle: 3 }, note: '검지·중지 옆으로', region: '한국', verify: true }],
  ['ksl-r', 'ㄹ', 'ksl', 'touchP', 'EEEC', { abd: { index: -3, ring: 3 }, region: '한국', verify: true }],
  ['ksl-m', 'ㅁ', 'ksl', 'touchI', 'RRRR', { note: '네모 모양', region: '한국', verify: true }],
  ['ksl-b', 'ㅂ', 'ksl', 'across', 'EEEE', { region: '한국', verify: true }],
  ['ksl-s', 'ㅅ', 'ksl', 'wrap', 'EECC', { abd: { index: 10, middle: -10 }, note: '손가락 아래로', region: '한국', verify: true }],
  ['ksl-o', 'ㅇ', 'ksl', 'touchI', 'OOOO', { region: '한국', verify: true }],
  ['ksl-j', 'ㅈ', 'ksl', 'L', 'EECC', { abd: { index: 10, middle: -10 }, note: '손가락 아래로', region: '한국', verify: true }],
  ['ksl-k', 'ㅋ', 'ksl', 'L', 'EECC', { abd: { index: 5, middle: -5 }, note: 'ㄱ에 중지를 더함', region: '한국', verify: true }],

  // --- 숫자 세기 ---
  ['num-ko-1', '한국 수어 1', 'number', 'wrap', 'ECCC', { region: '한국' }],
  ['num-ko-2', '한국 수어 2', 'number', 'wrap', 'EECC', { abd: { index: 8, middle: -8 }, region: '한국' }],
  ['num-ko-3', '한국 수어 3', 'number', 'touchP', 'EEEC', { abd: { index: 8, ring: -8 }, region: '한국' }],
  ['num-ko-4', '한국 수어 4', 'number', 'across', 'EEEE', { s: 1, region: '한국' }],
  ['num-ko-5', '한국 수어 5 (엄지)', 'number', 'up', 'CCCC', { region: '한국' }],
  ['num-ko-6', '한국 수어 6', 'number', 'L', 'ECCC', { region: '한국' }],
  ['num-ko-7', '한국 수어 7', 'number', 'L', 'EECC', { abd: { index: 8, middle: -8 }, region: '한국' }],
  ['num-ko-8', '한국 수어 8', 'number', 'L', 'EEEC', { abd: { index: 8, ring: -8 }, region: '한국' }],
  ['num-ko-9', '한국 수어 9', 'number', 'L', 'EEEE', { s: 1, region: '한국' }],
  ['num-kofold-1', '한국식 접어 세기 1', 'number', 'across', 'EEEE', { s: 1, region: '한국', note: '편 손에서 엄지부터 접음' }],
  ['num-kofold-2', '한국식 접어 세기 2', 'number', 'across', 'CEEE', { s: 1, region: '한국' }],
  ['num-kofold-3', '한국식 접어 세기 3', 'number', 'wrap', 'CCEE', { s: 1, region: '한국' }],
  ['num-kofold-4', '한국식 접어 세기 4', 'number', 'wrap', 'CCCE', { region: '한국' }],
  ['num-kofold-5', '한국식 접어 세기 5', 'number', 'wrap', 'CCCC', { region: '한국' }],
  ['num-us-1', '미국 1', 'number', 'wrap', 'ECCC', { region: '미국' }],
  ['num-us-2', '미국 2', 'number', 'wrap', 'EECC', { abd: { index: 8, middle: -8 }, region: '미국' }],
  ['num-us-3', '미국 3 (검지·중지·약지)', 'number', 'touchP', 'EEEC', { abd: { index: 8, ring: -8 }, region: '미국' }],
  ['num-us-4', '미국 4', 'number', 'across', 'EEEE', { s: 1, region: '미국' }],
  ['num-us-5', '미국 5', 'number', 'ext', 'EEEE', { s: 1, region: '미국' }],
  ['num-asl-3', 'ASL 3 (엄지·검지·중지)', 'number', 'L', 'EECC', { abd: { index: 8, middle: -8 }, region: '미국 수어' }],
  ['num-asl-6', 'ASL 6', 'number', 'touchP', 'EEEO', { abd: { index: 6, ring: -6 }, region: '미국 수어' }],
  ['num-asl-7', 'ASL 7', 'number', 'touchR', 'EEOE', { abd: { index: 6, pinky: -10 }, region: '미국 수어' }],
  ['num-asl-8', 'ASL 8', 'number', 'touchM', 'EOEE', { abd: { index: 6, pinky: -10 }, region: '미국 수어' }],
  ['num-asl-9', 'ASL 9', 'number', 'touchI', 'OEEE', { s: 1, region: '미국 수어' }],
  ['num-asl-10', 'ASL 10 (엄지 세워 흔듦)', 'number', 'up', 'CCCC', { region: '미국 수어' }],
  ['num-eu-1', '유럽 1 (엄지)', 'number', 'up', 'CCCC', { region: '독일·프랑스 등' }],
  ['num-eu-2', '유럽 2 (엄지·검지)', 'number', 'L', 'ECCC', { region: '독일·프랑스 등' }],
  ['num-eu-3', '유럽 3', 'number', 'L', 'EECC', { abd: { index: 8, middle: -8 }, region: '독일·프랑스 등' }],
  ['num-eu-4', '유럽 4', 'number', 'L', 'EEEC', { abd: { index: 8, ring: -8 }, region: '독일·프랑스 등' }],
  ['num-cn-6', '중국 6', 'number', 'L', 'CCCE', { abd: { pinky: -20 }, region: '중국' }],
  ['num-cn-7', '중국 7 (세 손끝 모음)', 'number', 'touchI', 'OOCC', { abd: { index: -4, middle: 4 }, region: '중국', verify: true }],
  ['num-cn-8', '중국 8', 'number', 'L', 'ECCC', { region: '중국' }],
  ['num-cn-9', '중국 9 (구부린 검지)', 'number', 'wrap', 'XCCC', { region: '중국' }],
  ['num-cn-10', '중국 10 (주먹)', 'number', 'wrap', 'CCCC', { region: '중국', note: '두 검지를 십자로 겹치기도 함' }],
  ['num-jp-3', '일본 3', 'number', 'touchP', 'EEEC', { abd: { index: 8, ring: -8 }, region: '일본' }],

  // --- 인사·일상 ---
  ['g-wave', '손 흔들기 / 하이파이브', 'greeting', 'ext', 'EEEE', { s: 1 }],
  ['g-thumbsUp', '따봉 (엄지 척)', 'greeting', 'up', 'CCCC'],
  ['g-thumbsDown', '엄지 아래 (반대)', 'greeting', 'up', 'CCCC', { note: '손을 뒤집음' }],
  ['g-ok', 'OK', 'greeting', 'touchI', 'OEEE', { s: 1 }],
  ['g-peace', '브이 / 평화', 'greeting', 'wrap', 'EECC', { abd: { index: 10, middle: -10 } }],
  ['g-fingerHeart', '손가락 하트', 'greeting', 'overIndex', 'hCCC', { region: '한국' }],
  ['g-shaka', '샤카 / 전화해', 'greeting', 'L', 'CCCE', { abd: { pinky: -20 }, region: '하와이' }],
  ['g-rock', '메탈 / 록', 'greeting', 'wrap', 'ECCE', { abd: { index: 8, pinky: -15 } }],
  ['g-ily', '사랑해 (ILY)', 'greeting', 'L', 'ECCE', { abd: { pinky: -15 } }],
  ['g-point', '가리키기', 'greeting', 'side', 'ECCC'],
  ['g-shh', '쉿', 'greeting', 'wrap', 'ECCC'],
  ['g-beckon', '이리 와 (손짓)', 'greeting', 'wrap', 'XCCC', { note: '검지를 까딱임' }],
  ['g-salute', '경례', 'greeting', 'across', 'EEEE'],
  ['g-fistBump', '주먹 인사', 'greeting', 'wrap', 'CCCC'],
  ['g-crossed', '행운 빌기 (꼰 손가락, 근사)', 'greeting', 'wrap', 'EECC', { abd: { index: -12, middle: 12 }, verify: true }],
  ['g-gun', '손가락 총', 'greeting', 'L', 'EECC', { abd: { index: -3, middle: 3 } }],
  ['g-call', '전화 (엄지·소지)', 'greeting', 'L', 'CCCE', { abd: { pinky: -20 } }],
  ['g-money', '돈 (엄지로 비비기)', 'greeting', 'pinch', 'OOCC', { region: '한국·일본', verify: true }],
  ['g-pray', '합장 / 기도 (한 손)', 'greeting', 'across', 'EEEE', { note: '두 손을 맞댐' }],
  ['g-stop', '멈춰', 'greeting', 'out', 'EEEE'],
  ['g-pinchSmall', '조금만', 'greeting', 'pinch', 'hCCC', { note: '엄지와 검지 사이를 조금 띄움', verify: true }],
  ['g-chefKiss', '셰프 키스 / 손끝 모음', 'greeting', 'touchM', 'OOOO', { region: '이탈리아' }],

  // --- 무례한 손짓 (지역마다 의미가 다름) ---
  ['r-middle', '가운뎃손가락', 'rude', 'wrap', 'CECC', { note: '대부분 지역에서 욕설' }],
  ['r-fig', '피그 사인 (감자)', 'rude', 'between', 'CCCC', { region: '한국·러시아·터키 등', note: '엄지를 검지와 중지 사이로' }],
  ['r-vBack', '손등 V', 'rude', 'wrap', 'EECC', { abd: { index: 10, middle: -10 }, region: '영국·호주', note: '손등을 상대로' }],
  ['r-corna', '코르나 (뿔)', 'rude', 'wrap', 'ECCE', { abd: { index: 8, pinky: -15 }, region: '이탈리아·스페인' }],
  ['r-okRude', 'OK (욕설 의미)', 'rude', 'touchI', 'OEEE', { s: 1, region: '브라질·터키' }],
  ['r-moutza', '무차 (손바닥 내밀기)', 'rude', 'ext', 'EEEE', { s: 1, region: '그리스' }],
  ['r-thumbUpRude', '엄지 척 (욕설 의미)', 'rude', 'up', 'CCCC', { region: '이란·서아프리카 일부' }],
  ['r-loser', '루저 L', 'rude', 'L', 'ECCC', { region: '미국', note: '이마에 댐' }],
  ['r-pinky', '새끼손가락 (약속/조롱)', 'rude', 'wrap', 'CCCE', { note: '약속 걸기에도 씀' }],

  // --- 스포츠 ---
  ['sp-catcher1', '포수 사인 1', 'sport', 'wrap', 'ECCC', { note: '손가락을 아래로' }],
  ['sp-catcher2', '포수 사인 2', 'sport', 'wrap', 'EECC', { note: '손가락을 아래로' }],
  ['sp-catcher3', '포수 사인 3', 'sport', 'touchP', 'EEEC', { note: '손가락을 아래로' }],
  ['sp-catcher4', '포수 사인 4', 'sport', 'across', 'EEEE', { note: '손가락을 아래로' }],
  ['sp-catcherFist', '포수 사인 주먹', 'sport', 'wrap', 'CCCC'],
  ['sp-strike', '스트라이크 / 아웃 (주먹)', 'sport', 'wrap', 'CCCC'],
  ['sp-safe', '세이프 (편 손)', 'sport', 'across', 'EEEE'],
  ['sp-timeout', '타임아웃 (T, 한 손)', 'sport', 'across', 'EEEE', { note: '두 손으로 T' }],
  ['sp-three', '3점슛 (세 손가락)', 'sport', 'L', 'EECC', { abd: { index: 8, middle: -8 }, note: '농구 심판' }],
  ['sp-number1', '1등 / 넘버원', 'sport', 'wrap', 'ECCC'],
  ['sp-fourSeam', '야구 포심 그립', 'sport', 'tuck', 'KKCC', { abd: { index: -3, middle: 3 }, verify: true }],
  ['sp-racket', '라켓 / 배트 그립', 'sport', 'wrap', 'hhhh'],
  ['sp-dart', '다트 그립', 'sport', 'pinch', 'hhKK', { verify: true }],
  ['sp-ball', '공 잡기', 'sport', 'C', 'RRRR', { s: 1 }],
  ['sp-bowling', '볼링 그립', 'sport', 'L', 'EhhC', { verify: true }],

  // --- 잡기 ---
  ['grip-power', '원통 쥐기', 'grip', 'wrap', 'hhhh'],
  ['grip-sphere', '공 쥐기', 'grip', 'C', 'RRRR', { s: 1 }],
  ['grip-pinch', '집게 (엄지·검지 끝)', 'grip', 'pinch', 'OKKK'],
  ['grip-tripod', '펜 쥐기 (세 손가락)', 'grip', 'pinch', 'OOhh', { verify: true }],
  ['grip-key', '열쇠 쥐기', 'grip', 'key', 'hhhh'],
  ['grip-hook', '고리 쥐기 (가방)', 'grip', 'side', 'HHHH'],
  ['grip-flat', '쟁반 받치기', 'grip', 'out', 'KKKK', { s: 1 }],

  // --- 《수몰》 귀신 손 ---
  ['ghost-claw', '귀신 갈고리 손', 'ghost', 'L', 'HHHH', { s: 1 }],
  ['ghost-reach', '뻗는 손', 'ghost', 'out', 'KKKK', { s: 1 }],
  ['ghost-beckon', '부르는 손짓', 'ghost', 'touchM', 'XXXX', { verify: true }],
  ['ghost-limp', '축 늘어진 손', 'ghost', 'side', 'hhhh'],
  ['ghost-spread', '경련하듯 벌린 손', 'ghost', 'ext', 'EEEE', { abd: { index: 18, middle: 4, ring: -12, pinky: -28 } }],
  ['ghost-scratch', '할퀴는 손', 'ghost', 'C', 'XXXX', { s: 1 }],
];

export const CATEGORIES = {
  handshape: '수어 기본 손모양',
  asl: '미국 수어 알파벳',
  ksl: '한국 지문자 (근사)',
  number: '숫자 세기',
  greeting: '인사·일상',
  rude: '무례한 손짓',
  sport: '스포츠',
  grip: '잡기',
  ghost: '귀신 손 (수몰)',
};

function build() {
  const byId = {};
  const out = [];
  for (const [id, name, cat, thumb, fingers, opts = {}] of RAW) {
    let h;
    if (thumb && thumb.ref) {
      h = byId[thumb.ref].h;
    } else {
      h = { thumb: T[thumb].slice() };
      KEYS.forEach((key, i) => {
        const [mcp, pip, dip] = F[fingers[i]];
        const abd = opts.abd && opts.abd[key] !== undefined ? opts.abd[key] : opts.s ? SPREAD[key] : 0;
        h[key] = [mcp, abd, 0, pip, dip];
      });
    }
    const entry = { id, name, category: cat, h };
    for (const k of ['region', 'note', 'verify']) if (opts[k]) entry[k] = opts[k];
    if (thumb && thumb.ref) entry.verify = byId[thumb.ref].verify;
    byId[id] = entry;
    out.push(entry);
  }
  return out;
}

export const GESTURES = build();

// Pose a rig (bones relative to its rest frame) into a dictionary shape.
export function applyGesture(rig, entry) {
  rig.resetPose();
  for (const [key, a] of Object.entries(entry.h)) {
    const J = key === 'thumb'
      ? [[a[0], a[1], a[2]], [a[3], a[4], a[5]], [a[6], 0, 0]]
      : [[a[0], a[1], a[2]], [a[3], 0, 0], [a[4], 0, 0]];
    rig.chains[key].forEach((link, k) => link.bone.quaternion.copy(localFrom(link, rig.side, J[k][0], J[k][1], J[k][2])));
  }
}

// Plain data for export (no functions), e.g. for a game engine.
export function gestureData() {
  return {
    format: 'hand-motion-studio.gestures',
    version: 1,
    angles: {
      thumb: ['cmcFlex', 'cmcAbd', 'cmcRoll', 'mcpFlex', 'mcpAbd', 'mcpRoll', 'ipFlex'],
      finger: ['mcpFlex', 'mcpAbd', 'mcpRoll', 'pipFlex', 'dipFlex'],
      units: 'degrees; abduction positive toward the thumb; Euler XZY on the bind pose, then roll about the bone',
    },
    categories: CATEGORIES,
    gestures: GESTURES,
  };
}
