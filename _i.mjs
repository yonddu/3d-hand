import { readTake, replay } from './tools/replay.mjs';
const d=readTake('/mnt/project-files/hand-motion-studio/takes/book_turn_08-19.glb');const o=replay(d);
const ts=new Set(o.marks.filter(m=>m.kind==='wdis').map(m=>m.t.toFixed(3)));
let s='';for(const f of d.frames){if(f.t<21.77||!f.hands.length)continue;s+=ts.has(f.t.toFixed(3))?'X':'.';}
console.log(process.argv[2],[...ts].filter(t=>+t>=21.77).length);console.log(s);
