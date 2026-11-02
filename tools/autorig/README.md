# autorig (mesh-only hand/arm models, e.g. Meshy AI)

Per model: look at the mesh (hand along +z, fingers spread in y), write a cfg with wrist z,
finger base(web)/tip guesses in (z, y), thumb base/tip, thumb CMC; then

    python3 -I joints.py model.glb cfg.json          # -> J.npy (joints), showj.py model.glb to check
    python3 -I build.py Left out.glb model.glb J.npy # Mixamo names, nearest bone + neighbours weights

cfg1 = gauntlet v1 (data/models/gauntlet_rigged_left.glb), cfg2 = gauntlet v2 (gauntlet2_rigged_left.glb).
