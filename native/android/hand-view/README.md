# hand-view

Source of `app/src/main/assets/hand.html`: the Quest-style hand drawn over the
camera picture (three.js + the MIT WebXR generic hand, 2,314 triangles /
1,360 vertices / 25 joints per hand). MainActivity -> HandView.show ->
`setHands(json)`.

Rebuild after changing `main.js` (the built file is committed; CI does not build it):

    npm install   # three 0.170.0, esbuild
    node build.mjs
