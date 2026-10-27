// The phone camera as the app models it: about 66 degrees across the long
// side of the frame (main cameras; the synthetic renders use the same,
// tools/synth-render.mjs). Scene axes: x right, y up, z toward the camera,
// which looks down -z.
export const LONG_FOV = (66 * Math.PI) / 180;

// Focal length in image-width units for a frame of this aspect (width / height).
export const focalW = (aspect) => (Math.max(1, 1 / aspect) * 0.5) / Math.tan(LONG_FOV / 2);
