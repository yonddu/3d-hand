const {chromium}=require('playwright');const fs=require('fs');const http=require('http');const path=require('path');
const dir=process.argv[2], out=process.argv[3], N=+process.argv[4];
const srv=http.createServer((q,r)=>{const f=path.join(dir,decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return;}r.writeHead(200,{'Content-Type':f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':'application/octet-stream'});r.end(d);});}).listen(8765);
(async()=>{const b=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});const p=await b.newPage({viewport:{width:1280,height:540}});
p.on('console',m=>console.log('page:',m.text()));p.on('pageerror',e=>console.log('err:',e.message));
await p.goto('http://localhost:8765/index.html');await p.waitForFunction('window.ready===true',null,{timeout:60000});
fs.mkdirSync(out,{recursive:true});
for(let i=0;i<N;i++){const u=await p.evaluate(i=>window.draw(i),i);fs.writeFileSync(`${out}/f${String(i).padStart(4,'0')}.png`,Buffer.from(u.split(',')[1],'base64'));}
await b.close();srv.close();})();
