import * as THREE from 'three';

// The hand and arm are see-through shells. Drawn as they are, which of their
// own surfaces shows depends on the order the triangles and the two meshes
// happen to be drawn in: from some angles a surface behind (or the arm skin
// in front of the heel of the hand) wins, and part of the hand, such as the
// ball of the thumb, seems to vanish. A depth-only copy drawn first marks the
// nearest surface of hand and arm together; the visible pass then draws only
// that surface, from every angle.
export function addDepthPrepass(mesh) {
  if (mesh.userData.prepass) {
    mesh.remove(mesh.userData.prepass);
    mesh.userData.prepass.material.dispose();
  }
  const pre = new THREE.SkinnedMesh(mesh.geometry, prepassMaterial(mesh.material));
  pre.bind(mesh.skeleton, mesh.bindMatrix);
  pre.bindMode = mesh.bindMode;
  pre.frustumCulled = false;
  pre.renderOrder = -1;
  // The mesh's own morph weights (the thenar pad), even if set up later.
  Object.defineProperty(pre, 'morphTargetInfluences', { get: () => mesh.morphTargetInfluences, set: () => {}, configurable: true });
  Object.defineProperty(pre, 'morphTargetDictionary', { get: () => mesh.morphTargetDictionary, set: () => {}, configurable: true });
  pre.name = `${mesh.name}DepthPrepass`;
  mesh.add(pre); // a child: shown and hidden with the mesh
  mesh.userData.prepass = pre;
  return pre;
}

function prepassMaterial(material) {
  const m = material.clone();
  m.onBeforeCompile = material.onBeforeCompile;
  m.customProgramCacheKey = () => `prepass|${material.customProgramCacheKey()}`;
  m.colorWrite = false;
  m.depthWrite = true;
  m.transparent = true;
  // A hair behind, so the visible pass's nearest surface always passes.
  m.polygonOffset = true;
  m.polygonOffsetFactor = 1;
  m.polygonOffsetUnits = 1;
  return m;
}
