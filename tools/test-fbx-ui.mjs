import assert from 'node:assert/strict';
import fs from 'node:fs';import http from 'node:http';import path from 'node:path';
import {chromium} from 'playwright';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
const root=process.cwd();const types={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.json':'application/json','.wasm':'application/wasm'};
const server=http.createServer((req,res)=>{const file=path.join(root,new URL(req.url,'http://x').pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
const browser=await chromium.launch({args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:360,height:740},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
 await page.waitForFunction(()=>window.__hms && __hms.realHands.left && __hms.realHands.right,null,{timeout:60000});
 await page.click('#start-demo');
 assert.equal(await page.locator('#export-format').inputValue(),'glb');
 await page.evaluate(()=>__hms.startRecording());
 await page.waitForFunction(()=>__hms.rec.frames.length>=4,null,{timeout:30000});await page.evaluate(()=>__hms.stopRecording());
 await page.waitForFunction(()=>__hms.rec.finishing===null && __hms.takes.length>0,null,{timeout:120000});
 await page.click('#review-open');await page.selectOption('#export-format','fbx');
 let pending=page.waitForEvent('download');await page.click('#rv-glb');let download=await pending;
 assert.ok(download.suggestedFilename().endsWith('.fbx'));await download.saveAs('/tmp/fbx-check/ui.fbx');
 const b=fs.readFileSync('/tmp/fbx-check/ui.fbx');const scene=new FBXLoader().parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
 assert.ok(scene.getObjectByName('HMS_ArmsMesh')?.isSkinnedMesh);assert.ok(scene.animations[0]?.duration>0);
 await page.selectOption('#export-format','glb');pending=page.waitForEvent('download');await page.click('#rv-glb');download=await pending;
 assert.ok(download.suggestedFilename().endsWith('.glb'));await download.saveAs('/tmp/fbx-check/ui.glb');assert.equal(fs.readFileSync('/tmp/fbx-check/ui.glb').readUInt32LE(0),0x46546c67);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile controls fit');
 assert.deepEqual(errors,[]);console.log('FBX/GLB review dropdown, real Quest skin/bones/animation, binary downloads and mobile layout PASS');
}finally{await browser.close();server.close();}
