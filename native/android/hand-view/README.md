# hand-view

Source of `app/src/main/assets/hand.html`: the user's own hand model drawn
over the camera picture (three.js). With no model loaded the page draws
nothing and the app shows the MediaPipe points and lines (the built-in Quest
hand was removed in v0.16). MainActivity -> HandView.show -> `setHands(json)`.

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

Elbow: when body tracking (MediaPipe Pose) is on and a model has a forearm
bone (forearm / lowerarm / elbow in the name) above the hand, the model is
turned about the elbow so the forearm runs from the pose elbow (on its picture
ray, one model forearm from the wrist; nearer or farther as the pose says) to
the MediaPipe wrist, and the hand bone is turned back to the seen palm. The
upper arm stays as modelled.
