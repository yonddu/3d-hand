// Exercise the actual existing web main.js; there is no native-only pose solver.
import assert from 'node:assert/strict';
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
import * as THREE from 'three';import {chromium} from 'playwright';
import {HandRig} from '../src/handRig.js';import {FINGERS} from '../src/skeleton.js';
const dir=path.resolve('dist/native');
const srv=http.createServer((req,res)=>{const f=path.join(dir,new URL(req.url,'http://x').pathname);if(!f.startsWith(dir+path.sep)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':'application/octet-stream');fs.createReadStream(f).pipe(res);}).listen(0,'127.0.0.1');await new Promise(r=>srv.on('listening',r));
const browser=await chromium.launch({args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:412,height:650}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('pageerror',e.message);});page.on('console',m=>{if(m.type()==='error')console.log('browser error',m.text());});
 await page.addInitScript(()=>{window.requestAnimationFrame=()=>0;window.exports=[];window.HMSAndroid={ready(){window.bridgeReady=true;},beginExport(name,size){window.transfer={name,size,chunks:[]};return 'test';},appendExport(id,data){window.transfer.chunks.push(data);return true;},finishExport(){window.exports.push(window.transfer);return true;},cancelExport(){}};});
 await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`);await page.waitForFunction(()=>window.bridgeReady,null,{timeout:60000,polling:100});
 assert.deepEqual(await page.evaluate(()=>({fit:__hms.state.fit,lift:__hms.state.lift,limits:__hms.state.limits,contacts:__hms.realHands.right.contacts})),{fit:true,lift:true,limits:true,contacts:true});
 function hand(side,bend){const rig=new HandRig(side);for(const f of FINGERS)for(let k=0;k<3;k++){const l=rig.chains[f.key][k];l.bone.quaternion.copy(l.restLocal).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),bend*(f.key==='thumb'?.3:1)*[.7,1,.6][k]));}rig.group.updateMatrixWorld(true);const P=Array.from({length:21},(_,i)=>rig.boneByLandmark[i].getWorldPosition(new THREE.Vector3()));return {label:side,score:.95,world:P.flatMap(p=>[p.x,-p.y,-p.z]),lm:P.flatMap(p=>[(side==='left'?.3:.7)+p.x*2,.65-p.y*2*(720/1280),-p.z*2])};}
 async function send(i,hands){await page.evaluate(({i,hands})=>{HMSNative.receive({session:1,tMs:i*70,width:720,height:1280,hands,backend:'gpu',maxHands:2});__hms.native.tick(1000+i*70);},{i,hands});}
 await send(1,[hand('right',0)]);
 for(let i=2;i<8;i++)await send(i,[hand('right',(i-2)*.2)]);
 assert.ok(await page.evaluate(()=>Object.keys(__hms.solvers.right.fitPrev).length>0),'existing fitted solver used');
 assert.ok(await page.evaluate(()=>__hms.arms.right.mesh.visible && __hms.arms.right.group.visible),'existing arm displayed');
 assert.ok(await page.evaluate(()=>!!__hms.realHands.right.bendSource),'existing wrist seam source used');
 assert.equal(await page.evaluate(()=>__hms.rigs.right.joints.some(j=>j.visible)),false,'no debug joint markers');
 if(process.env.NATIVE_PREVIEW_PATH){const c=await page.context().newCDPSession(page);const shot=await c.send('Page.captureScreenshot');fs.writeFileSync(process.env.NATIVE_PREVIEW_PATH,Buffer.from(shot.data,'base64'));}
 await page.dispatchEvent('#rec','click');
 for(let i=8;i<16;i++) await send(i,[hand('right',(i-8)*.15)]);
 assert.equal(await page.evaluate(()=>__hms.rec.frames.length),8,'one recorded frame per delivered native result');
 await page.dispatchEvent('#rec','click');await page.waitForFunction(()=>__hms.rec.finishing===null && __hms.takes.length===1,null,{timeout:120000,polling:100});
 await page.dispatchEvent('#review-open','click');await page.dispatchEvent('#rv-glb','click');await page.waitForFunction(()=>window.exports.length===1,null,{timeout:30000,polling:100}).catch(async e=>{console.log('export state',await page.evaluate(()=>({transfer:window.transfer&&{size:transfer.size,chunks:transfer.chunks.length},toast:document.querySelector('#toast')?.textContent})));throw e;});
 const saved=await page.evaluate(()=>exports[0]);const buf=Buffer.concat(saved.chunks.map(s=>Buffer.from(s,'base64')));assert.equal(buf.length,saved.size);assert.equal(buf.readUInt32LE(0),0x46546c67);
 const gltf=JSON.parse(buf.subarray(20,20+buf.readUInt32LE(12)).toString());assert.ok(gltf.skins.length&&gltf.animations.length);
 assert.ok(gltf.nodes.some(n=>n.name==='RightHand'));assert.ok(gltf.nodes.some(n=>n.name==='RightForeArm'));
 assert.equal(gltf.scenes[0].extras.raw.pipeline,'existing-web-native-input-v1');
 const before=await page.evaluate(()=>__hms.takes.length);await page.evaluate(()=>HMSNative.pause());assert.equal(await page.evaluate(()=>__hms.takes.length),before);
 assert.deepEqual(errors,[]);console.log(`Existing-web native Studio: lift/fit/limits/contacts, arms/wrist seam, recording, unchanged finished-take passes, review and skeletal GLB ${buf.length} bytes PASS`);
} finally {await browser.close();srv.close();}
