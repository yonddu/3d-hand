import json,struct,sys,numpy as np
src,dst=sys.argv[1],sys.argv[2]
b=open(src,'rb').read(); L=struct.unpack('<I',b[12:16])[0]; g=json.loads(b[20:20+L]); bin0=bytearray(b[20+L+8:])
S=np.diag([1.,-1.,1.,1.])
def acc_arr(i):
  a=g['accessors'][i]; bv=g['bufferViews'][a['bufferView']]
  n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
  dt={5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[a['componentType']]
  off=bv.get('byteOffset',0)+a.get('byteOffset',0)
  assert bv.get('byteStride',0) in (0, n*np.dtype(dt).itemsize), ('stride', bv.get('byteStride'), n)
  arr=np.frombuffer(bytes(bin0[off:off+a['count']*n*np.dtype(dt).itemsize]),dtype=dt).reshape(a['count'],n).copy()
  return arr,off
def put(i,arr):
  _,off=acc_arr(i); d=arr.tobytes(); bin0[off:off+len(d)]=d
done=set()
for m in g['meshes']:
  for p in m['primitives']:
    for k in ('POSITION','NORMAL','TANGENT'):
      i=p['attributes'].get(k)
      if i is None or i in done: continue
      done.add(i); a,_=acc_arr(i); a[:,1]*=-1
      if k=='TANGENT': a[:,3]*=-1
      put(i,a)
      acc=g['accessors'][i]
      if 'min' in acc: mn,mx=acc['min'][:],acc['max'][:]; acc['min'][1],acc['max'][1]=-mx[1],-mn[1]
    i=p.get('indices')
    if i is not None and i not in done:
      done.add(i); a,_=acc_arr(i); a=a.reshape(-1,3)[:,[0,2,1]].reshape(-1,1); put(i,a)
for sk in g.get('skins',[]):
  a,_=acc_arr(sk['inverseBindMatrices'])
  M=a.reshape(-1,4,4).transpose(0,2,1)  # column-major -> row-major
  M=S@M@S; put(sk['inverseBindMatrices'],M.transpose(0,2,1).reshape(-1,16).astype('<f4'))
for n in g['nodes']:
  if 'matrix' in n:
    M=np.array(n['matrix']).reshape(4,4).T; n['matrix']=(S@M@S).T.reshape(-1).tolist()
  if 'translation' in n: n['translation'][1]*=-1
  if 'rotation' in n: x,y,z,w=n['rotation']; n['rotation']=[-x,y,-z,w]
  if n.get('name'): n['name']=n['name'].replace('Left','Right')
js=json.dumps(g,separators=(',',':')).encode(); js+=b' '*((4-len(js)%4)%4)
out=struct.pack('<III',0x46546C67,2,12+8+len(js)+8+len(bin0))+struct.pack('<II',len(js),0x4E4F534A)+js+struct.pack('<II',len(bin0),0x004E4942)+bytes(bin0)
open(dst,'wb').write(out); print('ok',len(out))
