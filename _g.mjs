import { readTake, replay, files } from './tools/replay.mjs';
const T={swap:0,flip:0,jump:0,fjump:0,fflip:0,asnap:0,gsw:0};const per={};
for(const f of files(['/mnt/project-files/hand-motion-studio/takes/'])){const d=readTake(f);if(!d)continue;const o=replay(d);for(const k in T)T[k]+=o[k];
 const n=f.split('/').pop();per[n]=`flip ${o.flip} jump ${o.jump} fjump ${o.fjump} wdis ${o.marks.filter(m=>m.kind==='wdis').length}`;}
console.log(process.argv[2],JSON.stringify(T));if(process.argv[3])for(const [k,v] of Object.entries(per))console.log(' ',k,v);
