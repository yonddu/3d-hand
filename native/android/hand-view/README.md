# hand-view

Source of `app/src/main/assets/hand.html`: the Quest-style hand drawn over the
camera picture (three.js + the MIT WebXR generic hand, 2,314 triangles /
1,360 vertices / 25 joints per hand). MainActivity -> HandView.show ->
`setHands(json)`.

Rebuild after changing `main.js` (the built file is committed; CI does not build it):

    npm install   # three 0.170.0, esbuild
    node build.mjs

## Your own hand model (custom.js)

"내 손 모델 불러오기" opens a GLB / glTF (one file) / FBX. Finger bones are
found by name (thumb / index / middle / ring / pinky, with left/right in the
name: Mixamo, Unreal, Rigify, Unity styles); the hand bone is their nearest
common ancestor; the last three bones of each finger move (metacarpals ride
with the palm; a last bone named tip/end/4 is the tip). The model is placed so
its hand bone sits on the MediaPipe wrist with the seen palm's turn and size,
and every finger bone turns the least it must to aim at the next MediaPipe
point. A one-handed model is mirrored for the other hand.
