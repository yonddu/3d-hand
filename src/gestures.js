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

import { F as BASE_F, T as BASE_T } from './shapes.js';

// Extra shapes used only by the dictionary (the fit's hidden-joint prior
// keeps to the basic ones in shapes.js).
const F = {
  ...BASE_F,
  G: [65, 75, 50], // loose grip, a little more open than a fist
  D: [40, 10, 5], // bent mostly at the knuckle
  P: [60, 25, 15], // flat pinch, pads toward the thumb
  S: [10, 30, 20], // softly curved, open
  U: [25, 25, 15], // cupped (scooping water)
  W: [30, 70, 50], // hooked over a bar or handle
  Z: [0, 60, 45], // half claw
  Y: [90, 40, 20], // knuckle fully bent, finger half straight
};
const T = {
  ...BASE_T,
  tripod: [40, -10, 0, 30, -10, 0, 25], // tip to the index and middle tips
  press: [20, 20, 0, 10, 0, 0, 5], // out and forward, pad pressing a button
  flat: [0, -35, 0, 0, 0, 0, 0], // flat against the side of the hand
  big: [30, 30, 0, 5, 0, 0, 5], // wide and opposed, around a big object
  bent: [10, 10, 0, 50, 0, 0, 70], // hooked at both thumb joints
  // Kapandji opposition test, the thumb's reach across the palm: 1-2 the
  // index's side, 3-6 the fingertips (touchI..touchP), 7-10 down the little
  // finger to the palm crease.
  k1: [10, -25, 0, 10, 0, 0, 10],
  k2: [18, -20, 0, 20, -5, 0, 15],
  k7: [58, -34, 0, 45, -10, 0, 35],
  k8: [60, -38, 0, 50, -10, 0, 40],
  k9: [60, -42, 0, 55, -10, 0, 45],
  k10: [55, -45, 0, 50, -10, 0, 40],
};

// Palm cupping (degrees, see handRig.js cupQuat) a thumb position needs: the
// thumb meets the ring and little fingers only on a hollowed palm.
const THUMB_CUP = { touchM: 6, touchR: 16, touchP: 26, k7: 28, k8: 30, k9: 30, k10: 26 };
// The fingertip a touching thumb rests on.
const THUMB_TOUCH = { touchI: 'index', touchM: 'middle', touchR: 'ring', touchP: 'pinky' };

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


  // --- 수어 손모양 추가 ---
  ['hs-openA', '열린 A (엄지 세움)', 'handshape', 'up', 'CCCC'],
  ['hs-babyO', '작은 O (검지와 엄지)', 'handshape', 'touchI', 'OCCC'],
  ['hs-flatF', '납작 F', 'handshape', 'pinch', 'BEEE', { s: 1, verify: true }],
  ['hs-open8', '열린 8 (중지 꺾음)', 'handshape', 'out', 'EBEE', { s: 1 }],
  ['hs-bent3', '구부린 3', 'handshape', 'L', 'HHCC', { abd: { index: 10, middle: -8 } }],
  ['hs-bentU', '꺾인 U / H', 'handshape', 'wrap', 'BBCC', { abd: { index: -3, middle: 3 } }],
  ['hs-flatC', '납작 C', 'handshape', 'C', 'DDDD'],
  ['hs-cupB', '오목한 B', 'handshape', 'across', 'DDDD'],
  ['hs-closedG', '닫힌 G', 'handshape', 'pinch', 'DCCC', { verify: true }],
  ['hs-cockedF', '굽힌 F', 'handshape', 'touchI', 'OKKK', { s: 1 }],
  ['hs-bentI', '구부린 I', 'handshape', 'wrap', 'CCCB'],
  ['hs-25', '25 (중지만 꺾은 5)', 'handshape', 'ext', 'EHEE', { s: 1, verify: true }],
  ['hs-flatV', '납작 V', 'handshape', 'wrap', 'BBCC', { abd: { index: 10, middle: -10 } }],
  ['hs-curved5', '둥근 5', 'handshape', 'C', 'RRRR', { s: 1 }],

  // --- 잡기 분류 33종 (Feix 등, GRASP taxonomy) ---
  ['gt-01', '01 큰 원통 감싸기', 'graspTax', 'big', 'RRRR'],
  ['gt-02', '02 가는 원통 감싸기', 'graspTax', 'wrap', 'GGGG'],
  ['gt-03', '03 중간 원통 감싸기', 'graspTax', 'wrap', 'hhhh'],
  ['gt-04', '04 엄지 붙인 감싸기', 'graspTax', 'side', 'hhhh'],
  ['gt-05', '05 가벼운 도구', 'graspTax', 'side', 'hhGG'],
  ['gt-06', '06 납작한 물건 (네 손가락)', 'graspTax', 'pinch', 'PPPP'],
  ['gt-07', '07 납작한 물건 (세 손가락)', 'graspTax', 'pinch', 'PPPK'],
  ['gt-08', '08 납작한 물건 (두 손가락)', 'graspTax', 'pinch', 'PPKK'],
  ['gt-09', '09 손가락 바닥 집기', 'graspTax', 'pinch', 'PKKK'],
  ['gt-10', '10 원판 감싸기 (뚜껑)', 'graspTax', 'big', 'hhhh', { s: 1 }],
  ['gt-11', '11 공 감싸기', 'graspTax', 'C', 'hhhh', { s: 1 }],
  ['gt-12', '12 원판 끝 잡기', 'graspTax', 'big', 'DDDD', { s: 1 }],
  ['gt-13', '13 공 끝 잡기', 'graspTax', 'C', 'OOOO', { s: 1 }],
  ['gt-14', '14 세 손가락 집기', 'graspTax', { ref: 'grip-tripod' }],
  ['gt-15', '15 고리 걸기', 'graspTax', { ref: 'grip-hook' }],
  ['gt-16', '16 옆으로 집기 (열쇠)', 'graspTax', { ref: 'grip-key' }],
  ['gt-17', '17 검지 펴고 쥐기 (칼)', 'graspTax', 'side', 'Khhh'],
  ['gt-18', '18 펴서 넓게 잡기', 'graspTax', 'big', 'DDDD'],
  ['gt-19', '19 가위 쥐기', 'graspTax', 'C', 'DhhC', { verify: true }],
  ['gt-20', '20 필기 쥐기', 'graspTax', 'tripod', 'OhGG'],
  ['gt-21', '21 세 손가락 변형', 'graspTax', 'tripod', 'hOGG', { verify: true }],
  ['gt-22', '22 평행 펴서 집기', 'graspTax', { ref: 'hs-flatO' }],
  ['gt-23', '23 손가락 사이 끼우기 (담배)', 'graspTax', 'side', 'KKhh', { abd: { index: -6, middle: 6 } }],
  ['gt-24', '24 손끝 집기', 'graspTax', 'touchI', 'OKKK'],
  ['gt-25', '25 옆 세 손가락', 'graspTax', 'key', 'Ohhh', { verify: true }],
  ['gt-26', '26 공 (네 손가락)', 'graspTax', 'C', 'RRRh', { s: 1 }],
  ['gt-27', '27 네 손가락 집기', 'graspTax', 'tripod', 'OOOG'],
  ['gt-28', '28 공 (세 손가락)', 'graspTax', 'C', 'RRhh', { s: 1 }],
  ['gt-29', '29 막대 쥐기', 'graspTax', 'key', 'KKhh', { verify: true }],
  ['gt-30', '30 손바닥 받치기', 'graspTax', 'side', 'DDDD'],
  ['gt-31', '31 고리 (엄지·검지)', 'graspTax', 'pinch', 'RCCC', { verify: true }],
  ['gt-32', '32 손바닥 쪽 끼우기', 'graspTax', 'side', 'KhGG', { verify: true }],
  ['gt-33', '33 아래 집게', 'graspTax', 'pinch', 'hKKK', { verify: true }],

  // --- 무드라 (요가·불교 손모양) ---
  ['mu-gyan', '갸나 (엄지·검지 끝)', 'mudra', 'touchI', 'OEEE'],
  ['mu-shuni', '샤니 (엄지·중지 끝)', 'mudra', 'touchM', 'EOEE'],
  ['mu-prithvi', '프리트비 (엄지·약지 끝)', 'mudra', 'touchR', 'EEOE'],
  ['mu-varuna', '바루나 (엄지·소지 끝)', 'mudra', 'touchP', 'EEEO'],
  ['mu-prana', '프라나 (엄지·약지·소지)', 'mudra', 'touchR', 'EEOO'],
  ['mu-apana', '아파나 (엄지·중지·약지)', 'mudra', 'touchM', 'EOOE'],
  ['mu-surya', '수리야 (약지 접어 엄지로 누름)', 'mudra', 'touchR', 'EECE'],
  ['mu-vayu', '바유 (검지 접어 엄지로 누름)', 'mudra', 'overIndex', 'CEEE', { verify: true }],
  ['mu-rudra', '루드라 (엄지·검지·약지)', 'mudra', 'touchI', 'OEOE', { verify: true }],
  ['mu-kubera', '쿠베라 (세 손끝 모음)', 'mudra', 'tripod', 'OOCC'],
  ['mu-adi', '아디 (엄지를 넣은 주먹)', 'mudra', 'tuck', 'CCCC'],
  ['mu-abhaya', '아바야 (두려움 없음)', 'mudra', 'out', 'EEEE'],
  ['mu-varada', '바라다 (베풂)', 'mudra', 'out', 'KKKK'],
  ['mu-vitarka', '비타르카 (설법)', 'mudra', 'touchI', 'OEEE', { s: 1 }],
  ['mu-karana', '카라나 (액막이)', 'mudra', { ref: 'hs-horns' }],
  ['mu-dhyana', '디야나 (선정, 한 손)', 'mudra', 'C', 'KKKK', { note: '두 손을 포개고 엄지끼리 닿음' }],
  ['mu-hakini', '하키니 (한 손)', 'mudra', 'C', 'SSSS', { s: 1, note: '두 손 손끝을 맞댐' }],
  ['mu-anjali', '안잘리 (합장, 한 손)', 'mudra', { ref: 'g-pray' }],

  // --- 엄지 맞서기 (opposition): thumb tip to each finger, palm hollowed ---
  ['op-k1', '캐펀지 1: 검지 첫마디 옆', 'opposition', 'k1', 'EEEE'],
  ['op-k2', '캐펀지 2: 검지 둘째마디 옆', 'opposition', 'k2', 'EEEE'],
  ['op-k3', '캐펀지 3: 검지 끝', 'opposition', 'touchI', 'OEEE'],
  ['op-k4', '캐펀지 4: 중지 끝', 'opposition', 'touchM', 'EOEE'],
  ['op-k5', '캐펀지 5: 약지 끝', 'opposition', 'touchR', 'EEOE'],
  ['op-k6', '캐펀지 6: 소지 끝', 'opposition', 'touchP', 'EEEO'],
  ['op-k7', '캐펀지 7: 소지 끝마디 주름', 'opposition', 'k7', 'EEEE'],
  ['op-k8', '캐펀지 8: 소지 가운데마디 주름', 'opposition', 'k8', 'EEEE'],
  ['op-k9', '캐펀지 9: 소지 뿌리 주름', 'opposition', 'k9', 'EEEE'],
  ['op-k10', '캐펀지 10: 손바닥 먼쪽 주름', 'opposition', 'k10', 'EEEE'],
  ['op-iCurl', '엄지–검지 끝 (나머지 말기)', 'opposition', 'touchI', 'OCCC'],
  ['op-mCurl', '엄지–중지 끝 (나머지 말기)', 'opposition', 'touchM', 'COCC'],
  ['op-rCurl', '엄지–약지 끝 (나머지 말기)', 'opposition', 'touchR', 'CCOC'],
  ['op-pCurl', '엄지–소지 끝 (나머지 말기)', 'opposition', 'touchP', 'CCCO'],
  ['op-iSpread', '엄지–검지 끝 (나머지 벌림)', 'opposition', 'touchI', 'OEEE', { s: 1 }],
  ['op-mSpread', '엄지–중지 끝 (나머지 벌림)', 'opposition', 'touchM', 'EOEE', { s: 1 }],
  ['op-rSpread', '엄지–약지 끝 (나머지 벌림)', 'opposition', 'touchR', 'EEOE', { s: 1 }],
  ['op-pSpread', '엄지–소지 끝 (나머지 벌림)', 'opposition', 'touchP', 'EEEO', { s: 1 }],
  ['op-iRelax', '엄지–검지 끝 (나머지 힘 뺌)', 'opposition', 'touchI', 'OSSS'],
  ['op-mRelax', '엄지–중지 끝 (나머지 힘 뺌)', 'opposition', 'touchM', 'SOSS'],
  ['op-rRelax', '엄지–약지 끝 (나머지 힘 뺌)', 'opposition', 'touchR', 'SSOS'],
  ['op-pRelax', '엄지–소지 끝 (나머지 힘 뺌)', 'opposition', 'touchP', 'SSSO'],
  ['op-rp', '엄지–약지·소지 끝 함께', 'opposition', 'touchR', 'EEOO'],
  ['op-mr', '엄지–중지·약지 끝 함께', 'opposition', 'touchM', 'EOOE'],
  ['op-cupWater', '손바닥 오므려 물 담기', 'opposition', 'out', 'UUUU', { cup: 22 }],
  ['op-cupHollow', '손바닥 깊게 오므림 (공기 담기)', 'opposition', 'big', 'SSSS', { cup: 30 }],

  // --- 다이빙 수신호 (물속) ---
  ['dv-ok', '괜찮다 (OK)', 'dive', { ref: 'g-ok' }],
  ['dv-up', '올라가자', 'dive', { ref: 'g-thumbsUp' }, null, { note: '엄지를 위로' }],
  ['dv-down', '내려가자', 'dive', { ref: 'g-thumbsDown' }, null, { note: '엄지를 아래로' }],
  ['dv-problem', '문제 있음', 'dive', 'out', 'EEEE', { note: '손바닥을 아래로 하고 좌우로 흔듦' }],
  ['dv-noAir', '공기 없음', 'dive', 'across', 'EEEE', { note: '편 손으로 목을 긋는 동작' }],
  ['dv-stop', '멈춰', 'dive', 'out', 'EEEE', { note: '손바닥을 앞으로' }],
  ['dv-airCheck', '공기 얼마나 남았나', 'dive', 'wrap', 'EECC', { abd: { index: -3, middle: 3 }, note: '두 손가락으로 손바닥을 두드림' }],
  ['dv-lookMe', '나를 봐', 'dive', 'wrap', 'EECC', { abd: { index: 10, middle: -10 }, note: 'V를 눈에서 상대에게' }],
  ['dv-buddy', '짝과 함께', 'dive', 'wrap', 'ECCC', { note: '두 검지를 나란히' }],
  ['dv-level', '이 깊이 유지', 'dive', 'across', 'EEEE', { note: '손바닥을 아래로 수평으로' }],
  ['dv-slow', '천천히', 'dive', 'out', 'KKKK', { note: '손바닥을 아래로 천천히 누름' }],
  ['dv-cold', '추워요', 'dive', 'wrap', 'CCCC', { note: '두 주먹으로 팔을 감쌈' }],
  ['dv-ear', '귀가 아파요', 'dive', 'side', 'ECCC', { note: '귀를 가리킴' }],
  ['dv-danger', '위험 / 상어', 'dive', 'across', 'EEEE', { note: '편 손을 세워 머리 위에' }],
  ['dv-safety', '안전 정지 (3분)', 'dive', 'touchP', 'EEEC', { note: '세 손가락을 편 손 위에' }],

  // --- 작전 수신호 ---
  ['sg-freeze', '정지 (주먹 들기)', 'signal', 'wrap', 'CCCC'],
  ['sg-stop', '멈춤 (손바닥)', 'signal', 'out', 'EEEE'],
  ['sg-listen', '들어라', 'signal', 'side', 'SSSS', { note: '오목한 손을 귀 뒤에' }],
  ['sg-look', '봐라', 'signal', 'wrap', 'EECC', { abd: { index: 10, middle: -10 }, note: 'V를 눈에서 앞쪽으로' }],
  ['sg-enemy', '적 발견', 'signal', 'up', 'CCCC', { note: '엄지를 아래로' }],
  ['sg-hurry', '서둘러', 'signal', 'wrap', 'CCCC', { note: '주먹을 위아래로' }],
  ['sg-down', '엎드려', 'signal', 'across', 'EEEE', { note: '손바닥을 아래로 누름' }],
  ['sg-door', '문', 'signal', 'side', 'ECCC', { note: '검지로 네모를 그림' }],
  ['sg-rally', '집결', 'signal', 'wrap', 'ECCC', { note: '머리 위에서 검지로 원을 그림' }],
  ['sg-cover', '엄호해', 'signal', 'across', 'EEEE', { note: '손바닥으로 머리를 두드림' }],
  ['sg-direction', '이 방향 (칼날 손)', 'signal', 'flat', 'EEEE'],

  // --- 생활 동작 ---
  ['dl-flashlight', '손전등 쥐기', 'daily', 'wrap', 'hhhh'],
  ['dl-flashlightOn', '손전등 스위치 누르기', 'daily', 'press', 'hhhh'],
  ['dl-knob', '둥근 문고리 쥐기', 'daily', 'big', 'hhhh', { s: 1 }],
  ['dl-lever', '레버 손잡이 잡기', 'daily', 'wrap', 'GGGG'],
  ['dl-push', '문 밀기 (손바닥)', 'daily', 'out', 'KKKK', { s: 1 }],
  ['dl-knock', '노크', 'daily', 'side', 'GGGG'],
  ['dl-phoneHold', '휴대폰 들기 (엄지로 조작)', 'daily', 'press', 'DDhh', { verify: true }],
  ['dl-phoneTap', '화면 누르기 (검지)', 'daily', 'side', 'KCCC'],
  ['dl-cup', '컵 쥐기', 'daily', 'C', 'RRRR'],
  ['dl-mug', '머그 손잡이 잡기', 'daily', 'pinch', 'Ghhh', { verify: true }],
  ['dl-switch', '스위치 올리기', 'daily', 'side', 'KCCC'],
  ['dl-page', '책장 넘기기', 'daily', 'pinch', 'PSSS'],
  ['dl-lighter', '라이터 켜기', 'daily', 'press', 'GGGG'],
  ['dl-match', '성냥 쥐기', 'daily', 'tripod', 'Ohhh'],
  ['dl-candle', '촛대 들기', 'daily', 'wrap', 'hhhh'],
  ['dl-rope', '밧줄 당기기', 'daily', 'wrap', 'GGGG'],
  ['dl-rung', '사다리 가로대 잡기', 'daily', 'side', 'WWWW'],
  ['dl-rail', '난간 잡기', 'daily', 'wrap', 'hhhh'],
  ['dl-wall', '벽 짚기', 'daily', 'out', 'KKKK', { s: 1 }],
  ['dl-feel', '어둠 속 더듬기', 'daily', 'out', 'SSSS', { s: 1 }],
  ['dl-mouth', '입 막기', 'daily', 'side', 'SSSS'],
  ['dl-eyes', '눈 가리기', 'daily', 'side', 'KKKK'],
  ['dl-scoop', '물 떠 마시기 (오목한 손)', 'daily', 'side', 'UUUU'],
  ['dl-paddle', '물 젓기 (모은 손)', 'daily', 'flat', 'KKKK', { abd: { index: -4, middle: 0, ring: 3, pinky: 5 } }],
  ['dl-part', '물 헤치기', 'daily', 'side', 'SSSS', { s: 1 }],
  ['dl-reach', '잡으려고 뻗은 손', 'daily', 'C', 'SSSS', { s: 1 }],
  ['dl-help', '구해 달라고 내민 손', 'daily', 'out', 'KKKK'],
  ['dl-drawer', '서랍 당기기', 'daily', 'side', 'WWWW'],
  ['dl-button', '엄지로 버튼 누르기', 'daily', 'press', 'CCCC'],
  ['dl-valve', '밸브 핸들 돌리기', 'daily', 'wrap', 'GGGG', { s: 1 }],
  ['dl-zip', '지퍼 내리기', 'daily', 'key', 'hGGG'],
  ['dl-chopsticks', '젓가락 쥐기', 'daily', 'tripod', 'OOGG', { verify: true }],
  ['dl-spoon', '숟가락 쥐기', 'daily', 'key', 'hGGG', { verify: true }],
  ['dl-card', '쪽지·사진 들기', 'daily', 'pinch', 'PPKK'],
  ['dl-coin', '동전 집기', 'daily', 'touchI', 'OKKK'],
  ['dl-stroke', '쓰다듬기', 'daily', 'out', 'SSSS'],
  ['dl-nose', '코 막기', 'daily', 'pinch', 'Ohhh'],

  // --- 악기·놀이 ---
  ['pl-rock', '가위바위보: 바위', 'play', 'wrap', 'CCCC'],
  ['pl-scissors', '가위바위보: 가위', 'play', 'wrap', 'EECC', { abd: { index: 10, middle: -10 } }],
  ['pl-paper', '가위바위보: 보', 'play', 'ext', 'EEEE', { s: 1 }],
  ['pl-thumbWar', '엄지 씨름', 'play', 'up', 'GGGG'],
  ['pl-snap', '손가락 튕기기 준비', 'play', 'touchM', 'KOCC'],
  ['pl-flick', '딱밤 준비', 'play', 'touchI', 'HKKK', { verify: true }],
  ['pl-drum', '드럼 스틱 쥐기', 'play', 'key', 'hhGG'],
  ['pl-pick', '기타 피크 쥐기', 'play', 'key', 'hGGG'],
  ['pl-piano', '피아노 기본 손', 'play', 'C', 'RRRR'],
  ['pl-octave', '피아노 옥타브 벌림', 'play', 'L', 'DDDS', { abd: { index: 10, middle: 0, ring: -10, pinky: -28 } }],
  ['pl-bow', '바이올린 활 쥐기', 'play', 'tripod', 'hOOD', { verify: true }],
  ['pl-baton', '지휘봉 쥐기', 'play', 'tripod', 'OKKK', { verify: true }],
  ['pl-recorder', '리코더 구멍 막기', 'play', 'out', 'DDDD', { verify: true }],

  // --- 수어 손모양 추가 2 (ASL·국제 수형 목록) ---
  ['hs-bent1', '구부린 1', 'handshape', 'wrap', 'BCCC'],
  ['hs-openX', '열린 X', 'handshape', 'L', 'XCCC'],
  ['hs-bentY', '구부린 Y', 'handshape', 'L', 'CCCB', { abd: { pinky: -20 } }],
  ['hs-openE', '열린 E', 'handshape', 'tuck', 'HHHH'],
  ['hs-bentW', '구부린 W', 'handshape', 'touchP', 'HHHC', { abd: { index: 8, ring: -8 } }],
  ['hs-bent4', '구부린 4', 'handshape', 'across', 'BBBB', { s: 1 }],
  ['hs-claw4', '갈고리 4', 'handshape', 'across', 'HHHH', { s: 1 }],
  ['hs-bentL3', '꺾인 L (두 손가락)', 'handshape', 'L', 'BBCC', { abd: { index: -3, middle: 3 } }],
  ['hs-openH', '벌린 H (옆)', 'handshape', 'out', 'EECC', { abd: { index: 6, middle: -6 } }],
  ['hs-flatG', '납작 G', 'handshape', 'flat', 'BCCC'],
  ['hs-openT', '열린 T', 'handshape', 'between', 'XCCC', { verify: true }],
  ['hs-C3', 'C (두 손가락)', 'handshape', 'C', 'RRCC'],
  ['hs-O3', 'O (두 손가락)', 'handshape', 'touchI', 'OOCC'],
  ['hs-tapered', '모은 O (끝 모음)', 'handshape', 'tripod', 'OOOO'],
  ['hs-spreadB', '벌린 B (엄지 접음)', 'handshape', 'across', 'EEEE', { s: 1 }],
  ['hs-bentMidd', '중지 꺾은 5', 'handshape', 'ext', 'EBEE', { s: 1 }],
  ['hs-thumbIn', '엄지 넣은 B', 'handshape', 'tuck', 'EEEE'],
  ['hs-indexHook', '검지 갈고리 (주먹 위)', 'handshape', 'side', 'HCCC'],
  ['hs-pinkyHook', '소지 갈고리', 'handshape', 'wrap', 'CCCX'],
  ['hs-IL', 'I-L (엄지·소지·검지 굽힘)', 'handshape', 'L', 'XCCE', { abd: { pinky: -15 } }],

  // --- 일상 제스처 추가 (HaGRID 33종 이름 기준, 형태만) ---
  ['g-peaceInv', '거꾸로 브이', 'greeting', 'wrap', 'EECC', { abd: { index: 10, middle: -10 }, note: '손가락이 아래로' }],
  ['g-twoUp', '두 손가락 붙여 세우기', 'greeting', 'wrap', 'EECC', { abd: { index: -3, middle: 3 } }],
  ['g-three2', '셋 (검지·중지·약지)', 'greeting', 'touchP', 'EEEC', { abd: { index: 8, ring: -8 } }],
  ['g-three3', '셋 (엄지·검지·중지)', 'greeting', 'L', 'EECC', { abd: { index: 8, middle: -8 } }],
  ['g-threeGun', '세 손가락 총', 'greeting', 'up', 'EECC', { abd: { index: -3, middle: 3 } }],
  ['g-thumbIndex', '엄지·검지 벌리기', 'greeting', 'L', 'ECCC', { note: '엄지와 검지로 크기 표시' }],
  ['g-thumbIndex2', '엄지·검지 조금 벌리기', 'greeting', 'pinch', 'KCCC'],
  ['g-grabbing', '움켜쥐기 직전', 'greeting', 'C', 'WWWW', { s: 1 }],
  ['g-grip', '쥔 손', 'greeting', 'wrap', 'GGGG'],
  ['g-palm', '손바닥 보이기', 'greeting', 'out', 'EEEE', { abd: { index: 3, ring: -3, pinky: -6 } }],
  ['g-mute', '조용히 (입에 검지)', 'greeting', 'wrap', 'ECCC'],
  ['g-holy', '두 손 모으기 (한 손)', 'greeting', 'flat', 'EEEE'],
  ['g-heartHalf', '두 손 하트 (한 손)', 'greeting', 'C', 'RRRR', { note: '두 손을 맞대 하트' }],
  ['g-cheekHeart', '볼 하트 (한 손)', 'greeting', 'C', 'hhhh', { note: '손끝을 머리 위로' }],
  ['g-picture', '사진 찍는 손 (한 손)', 'greeting', 'L', 'ECCC', { note: '두 손 L로 네모' }],
  ['g-xsign', 'X (검지 교차, 한 손)', 'greeting', 'wrap', 'ECCC', { note: '두 검지를 엇갈림' }],
  ['g-crazy', '머리 옆 검지 돌리기', 'greeting', 'side', 'ECCC'],
  ['g-comeAsia', '이리 와 (손바닥 아래)', 'greeting', 'out', 'BBBB', { note: '손바닥을 아래로 까딱', region: '한국·일본·동남아' }],
  ['g-soSo', '그저 그래 (흔들기)', 'greeting', 'out', 'EEEE', { s: 1, note: '손바닥을 아래로 좌우 흔듦' }],
  ['g-writeCheck', '계산서 주세요', 'greeting', 'tripod', 'OOCC', { note: '허공에 쓰는 시늉' }],
  ['g-drink', '한잔 (마시는 시늉)', 'greeting', 'L', 'CCCE', { abd: { pinky: -20 } }],
  ['g-eat', '먹는 시늉 (손끝 모아 입으로)', 'greeting', 'tripod', 'OOOO'],
  ['g-sleep', '잠 (손바닥 볼에)', 'greeting', 'flat', 'KKKK'],
  ['g-think', '생각 중 (턱 괴기)', 'greeting', 'L', 'BCCC'],
  ['g-noWag', '안 돼 (검지 흔들기)', 'greeting', 'wrap', 'ECCC'],
  ['g-clap', '박수 (한 손)', 'greeting', 'out', 'SSSS'],
  ['g-highFive', '하이파이브', 'greeting', 'ext', 'EEEE', { s: 1 }],
  ['g-wink', '찡긋 OK (손가락 세 개 펴기)', 'greeting', 'touchI', 'OEEE', { s: 1 }],
  ['g-oneMoment', '잠깐만 (검지 들기)', 'greeting', 'side', 'ECCC'],
  ['g-callMe', '전화해 (귀에 대기)', 'greeting', 'L', 'CCCE', { abd: { pinky: -20 } }],
  ['g-bigHeart', '팔 하트 (한 손)', 'greeting', 'side', 'KKKK', { note: '팔을 머리 위로' }],

  // --- 운동: 구기 ---
  ['sp-twoSeam', '야구 투심 그립', 'sport', 'tuck', 'KKCC', { abd: { index: -2, middle: 2 }, verify: true }],
  ['sp-curve', '야구 커브 그립', 'sport', 'tuck', 'DKCC', { abd: { index: -4, middle: 4 }, verify: true }],
  ['sp-slider', '야구 슬라이더 그립', 'sport', 'tuck', 'KKCC', { abd: { index: -5, middle: 5 }, verify: true }],
  ['sp-change', '야구 서클 체인지업', 'sport', 'touchI', 'OhhK', { verify: true }],
  ['sp-splitter', '야구 스플리터', 'sport', 'tuck', 'DDCC', { abd: { index: 14, middle: -14 } }],
  ['sp-fork', '야구 포크볼', 'sport', 'tuck', 'DDCC', { abd: { index: 20, middle: -20 } }],
  ['sp-knuckle', '야구 너클볼', 'sport', 'tuck', 'XXhh', { verify: true }],
  ['sp-glove', '야구 글러브 낀 손', 'sport', 'C', 'SSSS', { s: 1 }],
  ['sp-bat', '야구 배트 쥐기', 'sport', 'wrap', 'GGGG'],
  ['sp-shoot', '농구 슛 (손목 젖힌 손)', 'sport', 'L', 'SSSS', { s: 1 }],
  ['sp-follow', '농구 슛 팔로스루 (구스넥)', 'sport', 'out', 'BBBB', { s: 1 }],
  ['sp-dribble', '농구 드리블', 'sport', 'C', 'SSSS', { s: 1 }],
  ['sp-set', '배구 토스 (오목하게 벌림)', 'sport', 'C', 'RRRR', { s: 1 }],
  ['sp-bump', '배구 리시브 (손 겹침)', 'sport', 'flat', 'DDDD'],
  ['sp-spike', '배구 스파이크', 'sport', 'out', 'SSSS', { s: 1 }],
  ['sp-tennisEast', '테니스 이스턴 포핸드', 'sport', 'wrap', 'GGGG', { abd: { index: 10 } }],
  ['sp-tennisCont', '테니스 컨티넨털 그립', 'sport', 'key', 'WGGG', { abd: { index: 12 } }],
  ['sp-pingShake', '탁구 셰이크핸드', 'sport', 'key', 'DGGG'],
  ['sp-pingPen', '탁구 펜홀드', 'sport', 'tripod', 'OhGG', { verify: true }],
  ['sp-badminton', '배드민턴 그립', 'sport', 'key', 'WhGG'],
  ['sp-golfOverlap', '골프 오버래핑 그립 (오른손)', 'sport', 'key', 'hGGW', { verify: true }],
  ['sp-golfInter', '골프 인터로킹 그립 (오른손)', 'sport', 'key', 'hGGE', { verify: true }],
  ['sp-golfPutt', '골프 퍼팅 그립', 'sport', 'side', 'Dhhh'],
  ['sp-football', '미식축구 공 쥐기', 'sport', 'big', 'DhhG', { s: 1 }],
  ['sp-rugbyPass', '럭비 패스', 'sport', 'big', 'SSSS', { s: 1 }],
  ['sp-keeper', '골키퍼 손 (W 모양)', 'sport', 'ext', 'SSSS', { s: 1 }],
  ['sp-hockey', '하키 스틱 쥐기', 'sport', 'wrap', 'hhhh'],
  ['sp-cricket', '크리켓 볼 그립', 'sport', 'tuck', 'DDCC', { abd: { index: 6, middle: -6 }, verify: true }],

  // --- 운동: 격투·무술 ---
  ['ma-fist', '정권 (주먹)', 'martial', 'wrap', 'CCCC'],
  ['ma-knife', '수도 (칼날 손)', 'martial', 'flat', 'EEEE'],
  ['ma-spear', '관수 (손끝 찌르기)', 'martial', 'flat', 'KKKK', { abd: { index: -3, ring: 2, pinky: 4 } }],
  ['ma-palmHeel', '장저 (손바닥 밑)', 'martial', 'across', 'BBBB', { note: '손목을 젖혀 손바닥 아래로 침' }],
  ['ma-ridge', '배수도 (엄지 쪽 날)', 'martial', 'tuck', 'EEEE'],
  ['ma-oneKnuckle', '일지권 (검지 관절 주먹)', 'martial', 'wrap', 'XCCC'],
  ['ma-middleKnuckle', '중지 관절 주먹', 'martial', 'wrap', 'CXCC'],
  ['ma-bearHand', '곰손 (반주먹)', 'martial', 'side', 'HHHH'],
  ['ma-tigerClaw', '호조 (범 발톱)', 'martial', 'L', 'ZZZZ', { s: 1 }],
  ['ma-crane', '학 머리 (손끝 모음)', 'martial', 'tripod', 'OOOO'],
  ['ma-boxGuard', '복싱 가드 (붕대 감은 주먹)', 'martial', 'wrap', 'GGGG'],
  ['ma-wrestle', '레슬링 C 그립', 'martial', 'side', 'WWWW'],
  ['ma-judo', '유도 깃 잡기', 'martial', 'wrap', 'GGGG'],
  ['ma-swordGrip', '검도 죽도 쥐기', 'martial', 'wrap', 'hhGG'],

  // --- 운동: 웨이트·클라이밍·활쏘기 등 ---
  ['ex-overhand', '바벨 오버핸드 그립', 'exercise', 'wrap', 'GGGG'],
  ['ex-hook', '역도 훅 그립 (엄지를 손가락 아래)', 'exercise', 'tuck', 'GGGG'],
  ['ex-false', '썸리스 그립 (엄지 같은 쪽)', 'exercise', 'side', 'WWWW'],
  ['ex-pushupFist', '주먹 푸시업', 'exercise', 'wrap', 'CCCC'],
  ['ex-pushupPalm', '푸시업 손바닥', 'exercise', 'out', 'EEEE', { s: 1, note: '손목을 젖혀 바닥 짚기' }],
  ['ex-kettlebell', '케틀벨 손잡이', 'exercise', 'wrap', 'WWWW'],
  ['ex-dumbbell', '덤벨 쥐기', 'exercise', 'wrap', 'GGGG'],
  ['ex-chalk', '철봉 매달리기', 'exercise', 'side', 'WWWW'],
  ['cl-crimp', '클라이밍 크림프', 'exercise', 'overIndex', 'HHHH', { verify: true }],
  ['cl-halfCrimp', '클라이밍 하프 크림프', 'exercise', 'out', 'ZZZZ'],
  ['cl-open', '클라이밍 오픈 핸드', 'exercise', 'out', 'WWWW'],
  ['cl-pinch', '클라이밍 핀치', 'exercise', 'big', 'DDDD'],
  ['cl-sloper', '클라이밍 슬로퍼', 'exercise', 'out', 'SSSS', { s: 1 }],
  ['cl-pocket', '클라이밍 포켓 (두 손가락)', 'exercise', 'side', 'CWWC'],
  ['cl-jug', '클라이밍 저그 (큰 손잡이)', 'exercise', 'side', 'GGGG'],
  ['ar-draw', '활 시위 당기기 (세 손가락)', 'exercise', 'side', 'WWWC', { note: '지중해식' }],
  ['ar-thumbDraw', '깍지 시위 (엄지)', 'exercise', 'bent', 'hCCC', { region: '한국·몽골 국궁', verify: true }],
  ['ar-bowHand', '활 쥔 손', 'exercise', 'side', 'Dhhh'],
  ['ex-row', '노 젓기', 'exercise', 'wrap', 'hhhh'],
  ['ex-bike', '자전거 핸들·브레이크', 'exercise', 'wrap', 'KKhh'],
  ['ex-ski', '스키 폴', 'exercise', 'wrap', 'GGGG'],
  ['ex-swim', '자유형 손', 'exercise', 'flat', 'KKKK', { abd: { index: -4, ring: 3, pinky: 5 } }],
  ['ex-breast', '평영 손 (벌려 젓기)', 'exercise', 'flat', 'SSSS'],
  ['ex-yogaChin', '요가 친 무드라 (명상)', 'exercise', 'touchI', 'OKKK'],
  ['ex-stretch', '손가락 스트레칭 (활짝)', 'exercise', 'ext', 'EEEE', { abd: { index: 18, middle: 4, ring: -12, pinky: -28 } }],

  // --- 자연스러운 손 ---
  ['nt-relaxed', '힘 뺀 손 (휴식)', 'natural', 'out', null, { custom: { index: [15, 20, 10], middle: [20, 25, 12], ring: [25, 30, 15], pinky: [30, 35, 18] } }],
  ['nt-sleep', '잠든 손', 'natural', 'side', null, { custom: { index: [30, 40, 20], middle: [35, 45, 25], ring: [40, 50, 28], pinky: [45, 55, 30] } }],
  ['nt-float', '물에 뜬 손', 'natural', 'out', null, { custom: { index: [10, 15, 8], middle: [12, 18, 10], ring: [15, 22, 12], pinky: [18, 25, 14] }, s: 1 }],
  ['nt-hang', '늘어뜨린 손', 'natural', 'side', null, { custom: { index: [10, 25, 15], middle: [15, 30, 18], ring: [20, 35, 20], pinky: [25, 40, 22] } }],
];

// Every combination of straight and folded fingers (32), and the spread
// version of each with two or more straight fingers.
const DIGIT = ['엄지', '검지', '중지', '약지', '소지'];
for (let m = 0; m < 32; m++) {
  const up = DIGIT.map((_, i) => !!(m & (1 << i)));
  const fingers = up.slice(1).map((u) => (u ? 'E' : 'C')).join('');
  const thumb = up[0] ? 'L' : fingers[0] === 'C' && fingers[1] === 'C' ? 'wrap' : 'across';
  const named = DIGIT.filter((_, i) => up[i]);
  const name = named.length === 5 ? '모두 펴기' : named.length === 0 ? '모두 접기' : `${named.join('·')} 펴기`;
  RAW.push([`cb-${m}`, name, 'combo', thumb, fingers]);
  if (up.slice(1).filter(Boolean).length >= 2) RAW.push([`cb-${m}s`, `${name} (벌림)`, 'combo', thumb, fingers, { s: 1 }]);
}

// Shapes between two others, as a hand closes or opens.
const STEPS = [
  ['편 손 → 주먹', 'hs-openB', 'hs-S'],
  ['편 손 → 갈고리', 'hs-5', 'hs-claw5'],
  ['편 손 → 집게', 'g-wave', 'grip-pinch'],
  ['편 손 → OK', 'hs-5', 'g-ok'],
  ['주먹 → 검지', 'hs-S', 'hs-1'],
  ['주먹 → V', 'hs-S', 'g-peace'],
  ['편 손 → 공 쥐기', 'hs-5', 'grip-sphere'],
  ['편 손 → 원통 쥐기', 'hs-openB', 'grip-power'],
  ['힘 뺀 손 → 주먹', 'nt-relaxed', 'hs-S'],
  ['B → 꺾인 B', 'hs-B', 'hs-bentB'],
  ['검지 → 까딱', 'hs-1', 'hs-X'],
];
STEPS.forEach(([name, a, b], i) => {
  for (const t of [0.25, 0.5, 0.75]) RAW.push([`st-${i}-${t * 100}`, `${name} ${t * 100}%`, 'steps', { mix: [a, b, t] }]);
});

export const CATEGORIES = {
  handshape: '수어 기본 손모양',
  asl: '미국 수어 알파벳',
  ksl: '한국 지문자 (근사)',
  number: '숫자 세기',
  greeting: '인사·일상',
  rude: '무례한 손짓',
  sport: '스포츠',
  grip: '잡기',
  graspTax: '잡기 분류 33종 (GRASP)',
  daily: '생활 동작',
  natural: '자연스러운 손',
  steps: '오므리기·펴기 단계',
  combo: '손가락 조합 (펴기/접기)',
  mudra: '무드라',
  opposition: '엄지 맞서기·손바닥 오므림',
  dive: '다이빙 수신호',
  signal: '작전 수신호',
  play: '악기·놀이',
  martial: '격투·무술',
  exercise: '운동·웨이트·클라이밍',
};

function build() {
  const byId = {};
  const out = [];
  for (const [id, name, cat, thumb, fingers, opts = {}] of RAW) {
    let h;
    if (thumb && thumb.ref) {
      h = byId[thumb.ref].h;
    } else if (thumb && thumb.mix) {
      const [a, b, t] = thumb.mix;
      h = {};
      for (const k of Object.keys(byId[a].h)) h[k] = byId[a].h[k].map((v, j) => v + (byId[b].h[k][j] - v) * t);
    } else {
      h = { thumb: T[thumb].slice() };
      KEYS.forEach((key, i) => {
        const [mcp, pip, dip] = opts.custom ? opts.custom[key] : F[fingers[i]];
        const abd = opts.abd && opts.abd[key] !== undefined ? opts.abd[key] : opts.s ? SPREAD[key] : 0;
        h[key] = [mcp, abd, 0, pip, dip];
      });
    }
    const entry = { id, name, category: cat, h };
    for (const k of ['region', 'note', 'verify']) if (opts[k]) entry[k] = opts[k];
    const base = thumb && (thumb.ref || (thumb.mix && thumb.mix[0]));
    const cup = opts.cup ?? (typeof thumb === 'string' ? THUMB_CUP[thumb] : base && byId[base].cup);
    if (cup) entry.cup = cup;
    const touch = typeof thumb === 'string' ? THUMB_TOUCH[thumb] : base && byId[base].touch;
    // Only when that finger curls to meet it (code O), not for a loose O shape.
    if (touch && (typeof thumb !== 'string' || fingers[KEYS.indexOf(touch)] === 'O')) entry.touch = touch;
    if (thumb && thumb.ref && byId[thumb.ref].verify) entry.verify = true;
    if (thumb && thumb.mix && (byId[thumb.mix[0]].verify || byId[thumb.mix[1]].verify)) entry.verify = true;
    byId[id] = entry;
    out.push(entry);
  }
  return out;
}

export const GESTURES = build();

// Pose a rig (bones relative to its rest frame) into a dictionary shape.
export function applyGesture(rig, entry) {
  rig.resetPose();
  rig.cup = entry.cup || 0;
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
