// Realistic hand skin driven by the solver rig.
//
// The mesh is the WebXR "generic-hand" model (MIT, @webxr-input-profiles/assets),
// the same joint layout Quest hand tracking uses. Its joints are siblings under
// one armature, each with an armature-space transform, so we pose it with a
// small forward-kinematics pass: every phalanx takes the solved bone's frame
// (Y = bone direction, X = flex axis) times a constant calibration, and its
// position follows the model's own bone lengths.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FINGERS, sideSign } from './skeleton.js';
import { basisQuat, handFrameQuat } from './handRig.js';

// WebXR joint names per finger: [metacarpal, proximal, intermediate/distal, distal/tip, tip].
const XR = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};

// Joints driven by the solver's three bones, plus the end joint they point to.
function drivenChain(key) {
  const names = XR[key];
  return key === 'thumb' ? names : names.slice(1); // thumb metacarpal moves; finger metacarpals are rigid
}

export async function loadHandGLB(source) {
  let buffer;
  if (source.base64) {
    const bin = atob(source.base64);
    buffer = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buffer[i] = bin.charCodeAt(i);
    buffer = buffer.buffer;
  } else {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`hand model fetch failed: ${res.status}`);
    buffer = await res.arrayBuffer();
  }
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
}

export class RealHand {
  constructor(gltf, rig, material) {
    this.rig = rig;
    this.side = rig.side;
    this.root = gltf.scene;
    this.root.name = `${this.side}RealHand`;
    this.joints = {};
    this.root.traverse((o) => {
      if (o.isBone) this.joints[o.name] = o;
      if (o.isSkinnedMesh) {
        this.mesh = o;
        o.frustumCulled = false;
        o.castShadow = true;
      }
    });
    this.setMaterial(material);

    // Rest transforms (armature space == parent space, the joints are siblings).
    this.restPos = {};
    this.restQuat = {};
    for (const [name, j] of Object.entries(this.joints)) {
      this.restPos[name] = j.position.clone();
      this.restQuat[name] = j.quaternion.clone();
    }
    const P = (n) => this.restPos[n];
    // Same landmark roles as MediaPipe: wrist, index/middle/pinky MCP.
    const frameLandmarks = [];
    frameLandmarks[0] = P('wrist');
    frameLandmarks[5] = P('index-finger-phalanx-proximal');
    frameLandmarks[9] = P('middle-finger-phalanx-proximal');
    frameLandmarks[17] = P('pinky-finger-phalanx-proximal');
    this.restFrame = handFrameQuat(frameLandmarks, this.side);
    this.restFrameInv = this.restFrame.clone().invert();
    this.addWristFade();

    // Calibration per driven joint: model rest rotation expressed in the
    // solver-style bone frame built from the model's own rest pose.
    this.calib = {};
    this.offset = {}; // child offset in that bone frame
    const s = sideSign(this.side);
    const handX = new THREE.Vector3(1, 0, 0).applyQuaternion(this.restFrame);
    const across = new THREE.Vector3(-0.55 * s, 0, 0.85).applyQuaternion(this.restFrame);
    for (const finger of FINGERS) {
      const chain = drivenChain(finger.key);
      for (let k = 0; k < 3; k++) {
        const a = chain[k];
        const b = chain[k + 1];
        const dir = P(b).clone().sub(P(a));
        const hint = finger.key === 'thumb' ? new THREE.Vector3().crossVectors(dir.clone().normalize(), across) : handX;
        const frame = basisQuat(dir, hint);
        const inv = frame.clone().invert();
        this.calib[a] = inv.clone().multiply(this.restQuat[a]);
        this.offset[a] = dir.clone().applyQuaternion(inv);
        if (k === 2) this.calib[b] = inv.clone().multiply(this.restQuat[b]); // tip follows the last bone
      }
    }
  }

  setMaterial(material) {
    if (this.mesh) this.mesh.material = withWristFade(material);
  }

  // Per-vertex 0..1 fade toward the cut at the wrist, like Quest hands.
  addWristFade() {
    const pos = this.mesh.geometry.attributes.position;
    const back = new THREE.Vector3(0, -1, 0).applyQuaternion(this.restFrame); // toward the forearm
    const wrist = this.restPos.wrist;
    const p = new THREE.Vector3();
    const along = new Float32Array(pos.count);
    let max = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      along[i] = p.fromBufferAttribute(pos, i).sub(wrist).dot(back);
      max = Math.max(max, along[i]);
    }
    const fade = along.map((t) => 1 - THREE.MathUtils.smoothstep(t, max - 0.03, max));
    this.mesh.geometry.setAttribute('wristFade', new THREE.BufferAttribute(fade, 1));
  }

  // Copy the solver rig's pose onto the model. Call after the rig is posed.
  update() {
    const rig = this.rig;
    this.root.position.copy(rig.group.position);
    this.root.visible = rig.group.visible;

    // Palm: rigid transform taking the model's rest hand frame to the solved one.
    const palm = rig.wrist.quaternion.clone().multiply(this.restFrameInv);
    const wristRest = this.restPos.wrist;
    const placeRigid = (name) => {
      const j = this.joints[name];
      j.position.copy(this.restPos[name]).sub(wristRest).applyQuaternion(palm);
      j.quaternion.copy(palm).multiply(this.restQuat[name]);
    };
    placeRigid('wrist');
    for (const key of ['index', 'middle', 'ring', 'pinky']) placeRigid(XR[key][0]);

    const parentQ = new THREE.Quaternion();
    const boneQ = new THREE.Quaternion();
    for (const finger of FINGERS) {
      const chain = drivenChain(finger.key);
      const links = rig.chains[finger.key];
      // Start of the driven chain sits on the rigid palm.
      placeRigid(chain[0]);
      const pos = this.joints[chain[0]].position.clone();
      parentQ.copy(rig.wrist.quaternion);
      for (let k = 0; k < 3; k++) {
        boneQ.copy(parentQ).multiply(links[k].bone.quaternion); // solved bone frame (rig space)
        parentQ.copy(boneQ);
        const j = this.joints[chain[k]];
        j.position.copy(pos);
        j.quaternion.copy(boneQ).multiply(this.calib[chain[k]]);
        pos.add(this.offset[chain[k]].clone().applyQuaternion(boneQ));
        if (k === 2) {
          const tip = this.joints[chain[3]];
          tip.position.copy(pos);
          tip.quaternion.copy(boneQ).multiply(this.calib[chain[3]]);
        }
      }
    }
  }
}

function withWristFade(material) {
  const prev = material.onBeforeCompile;
  material.transparent = true;
  material.customProgramCacheKey = () => `wrist-fade|${prev ? prev.toString() : ''}`;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float wristFade;\nvarying float vWristFade;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWristFade = wristFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vWristFade;\n#include <common>')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vWristFade;\n#include <opaque_fragment>');
  };
  return material;
}

// Quest-style hand: pale, slightly translucent, with a soft bright rim.
export function questMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.45, metalness: 0, transparent: true, opacity: 0.88 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float rim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.2);
       outgoingLight += vec3(0.55, 0.78, 0.95) * rim * 0.9;
       diffuseColor.a = mix(diffuseColor.a, 1.0, rim * 0.6);
       #include <opaque_fragment>`,
    );
  };
  return m;
}
