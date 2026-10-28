import assert from 'node:assert/strict';
import {HandTracker} from '../src/tracker.js';
import {nativeResult} from '../src/nativeResult.js';
import {restLandmarks} from '../src/skeleton.js';
const web=new HandTracker({}), native=new HandTracker({});
for(let i=0;i<40;i++) {
  const hands=i===20?[]:['left','right'].map(label=>({label,score:.9,lm:restLandmarks(label).flatMap(([x,y,z])=>[.5+x,.5-y,z]),world:restLandmarks(label).flatMap(([x,y,z],j)=>[x,-y,Math.sin(i*.1+j*.05)*.01-z])}));
  const packet={hands};const result=nativeResult(packet);
  web.landmarker={detectForVideo:()=>structuredClone(result)};
  const video={readyState:2,videoWidth:720,videoHeight:1280,currentTime:i};
  const ms=(i+1)*70;
  const options={firstPerson:true,trackMs:ms,swapHandedness:false,rightOnImageRight:true};
  const a=web.detect(video,ms,options);
  const b=native.acceptResult(structuredClone(result),{...options,aspect:720/1280});
  assert.deepEqual(b,a,'native input uses exactly web detection postprocessing');
  assert.deepEqual(native.lastRaw,web.lastRaw,'same raw coordinate convention/rounding');
}
assert.deepEqual(nativeResult({hands:[{label:'right',lm:[1],world:[] }]}).landmarks,[]);
console.log('Native input: 40 two-hand/loss frames match web detect output and raw coordinates PASS');
