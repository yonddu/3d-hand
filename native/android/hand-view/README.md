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

## Rotation retarget (v0.20; replaces the v0.17-v0.19 length / knuckle fits)

Only directions are used, never MediaPipe positions or lengths: every bone keeps its model
length and no bone moves except the model root (hand bone onto the seen wrist, one even
scale for the on-screen size only).
- Hand: palm basis from MediaPipe 3D (world) points: wrist -> middle root (forward), pinky
  root -> index root (side); left / right handled by mirroring a one-handed model.
- First finger bones (MCP, thumb CMC): the seen 3D direction in the palm frame; four fingers
  limited to 30 deg back .. 100 deg toward the palm.
- Middle / end joints of the four fingers: the seen bend at that joint (flex about the knuckle
  line + up to 20 deg sideways; the rest of a sideways reading counts as flex, as MediaPipe
  reads the knuckle line twisted) applied to the model's own bone before: 0 .. 115 deg, never
  backward, no twist (each bone turns the least it must). Thumb: seen directions.
- Parent first: hand -> first bones -> middle -> end; each turn made local through the parent.
- "편 손 캘리브레이션": one open-hand frame = the model's rest pose (first bones: palm-frame
  turn; middle / end: flex / side offsets). Kept in localStorage per side.
- A hand not seen keeps its last pose 0.5 s.
- Export: MainActivity replays the saved frames (setHands record: true), exportBegin('anim')
  = GLB with the model, root translation + rotation and bone rotation tracks only (no scale,
  lengths as modelled); exportBegin('pose', frame) = the model posed at that frame.

Finger lengths (v0.17): the page takes the user's finger bone lengths from MediaPipe's 3D
(world) points, median of the first 60 frames per side (per frame they swing ~25%), and
scales each model finger bone evenly about its joint (0.5 .. 1.6x) so it is as long,
relative to the palm, as the user's. Fingertips then land on the points; fingers get
thinner / thicker by the same factor. `calStatus()` shows samples and the scales used.

v0.18: the length fit no longer scales bones evenly (fingers got thin): on the rest pose the
joints after a bone move along the finger and the skin is stretched / shortened along the
bone only, then re-bound (boneInverses shifted), so the model's finger thickness stays.
Middle and end joints of the four fingers are hinges: the aim is projected onto the plane
across the knuckle line (as turned by the bone before), so they never bend sideways or twist.

v0.19 (skeleton fit): the calibration also takes the knuckles (finger roots, thumb base) in
the palm's own frame; fitLengths moves the model's knuckles there (rest pose, re-bound,
<= 0.6 palm) and rebuilds the palm frame. Each frame the knuckles are then put right on
their MediaPipe points. PIP/DIP may bend up to 20 deg sideways (was 0; tips were off the
points by 14-22% of the palm). Debug: HMS_DEBUG -> inst.err = picture distance per joint in
% of the seen palm; flags HMS_NOFIT / HMS_NOKNUCKLE / HMS_NOROOT / HMS_NOHINGE.
On the user's record (gauntlet v2, frames 65-118): no fit 14.8%, v0.18 11.6%, v0.19 6.0%.
