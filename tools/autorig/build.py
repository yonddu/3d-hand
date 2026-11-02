import sys; sys.path.insert(0,'.')
from load import load
import numpy as np, json, struct
SRC=sys.argv[3]
SIDE=sys.argv[1] if len(sys.argv)>1 else 'Left'
OUT=sys.argv[2] if len(sys.argv)>2 else 'gauntlet_rigged.glb'
j,b,V,F=load(SRC); V=V.astype(float)
l=struct.unpack('<I',b[12:16])[0]; binlen=struct.unpack('<I',b[20+l:24+l])[0]; bin_=bytearray(b[20+l+8:20+l+8+binlen])
J=np.load(sys.argv[4] if len(sys.argv)>4 else 'J.npy',allow_pickle=True).item()
order=['Arm','ForeArm','Hand']+[f'Thumb{i}' for i in range(1,5)]+[f'{f}{i}' for f in ['Index','Middle','Ring','Pinky'] for i in range(1,5)]
parent={'Arm':None,'ForeArm':'Arm','Hand':'ForeArm'}
for f in ['Thumb','Index','Middle','Ring','Pinky']:
    parent[f+'1']='Hand'
    for i in (2,3,4): parent[f'{f}{i}']=f'{f}{i-1}'
idx={n:i for i,n in enumerate(order)}
children={n:[c for c in order if parent[c]==n] for n in order}
# segments: (joint that owns it, a, b)
segs=[]
for n in order:
    for c in children[n]: segs.append((idx[n],J[n],J[c]))
# shoulder side: extend arm segment backwards
segs.append((idx['Arm'],J['Arm']+(J['Arm']-J['ForeArm'])*0.3,J['Arm']))
A=np.array([s[1] for s in segs]); B=np.array([s[2] for s in segs]); own=np.array([s[0] for s in segs])
d=np.empty((len(V),len(segs)))
for k in range(len(segs)):
    ab=B[k]-A[k]; t=np.clip(((V-A[k])@ab)/(ab@ab),0,1); d[:,k]=np.linalg.norm(V-(A[k]+t[:,None]*ab),axis=1)
# per joint distance = min over its segments
dj=np.full((len(V),len(order)),9.0)
for k in range(len(segs)): dj[:,own[k]]=np.minimum(dj[:,own[k]],d[:,k])
near=dj.argmin(1); dmin=dj.min(1)
nb={i:{i}|{idx[parent[n]]} if parent[n] else {i} for n,i in idx.items()}
for n,i in idx.items():
    for c in children[n]: nb[i].add(idx[c])
JW=np.zeros((len(V),4),np.uint8); WW=np.zeros((len(V),4),np.float32)
for v in range(len(V)):
    cand=[i for i in nb[near[v]] if dj[v,i]<dmin[v]*1.5+0.006]
    w=np.array([1/(dj[v,i]+0.004)**4 for i in cand]); o=np.argsort(-w)[:4]
    w=w[o]/w[o].sum()
    for k,oi in enumerate(o): JW[v,k]=cand[oi]; WW[v,k]=w[k]
# tips carry no weight (no segment) -> fine
def add(data):
    while len(bin_)%4: bin_.append(0)
    off=len(bin_); bin_.extend(data); j['bufferViews'].append({'buffer':0,'byteOffset':off,'byteLength':len(data)}); return len(j['bufferViews'])-1
bvJ=add(JW.tobytes()); j['accessors'].append({'bufferView':bvJ,'componentType':5121,'count':len(V),'type':'VEC4'}); aJ=len(j['accessors'])-1
bvW=add(WW.tobytes()); j['accessors'].append({'bufferView':bvW,'componentType':5126,'count':len(V),'type':'VEC4'}); aW=len(j['accessors'])-1
ibm=[]
for n in order:
    M=np.eye(4); M[:3,3]=-J[n]; ibm.append(M.T.flatten())  # column-major
bvI=add(np.array(ibm,np.float32).tobytes()); j['accessors'].append({'bufferView':bvI,'componentType':5126,'count':len(order),'type':'MAT4'}); aI=len(j['accessors'])-1
prim=j['meshes'][0]['primitives'][0]; prim['attributes']['JOINTS_0']=aJ; prim['attributes']['WEIGHTS_0']=aW
# nodes
meshNode=[i for i,n in enumerate(j['nodes']) if 'mesh' in n][0]
base=len(j['nodes'])
for n in order:
    p=parent[n]; t=J[n]-(J[p] if p else 0)
    nm=f'{SIDE}{n}' if n in ('Arm','ForeArm','Hand') else f'{SIDE}Hand{n}'
    j['nodes'].append({'name':nm,'translation':[float(x) for x in t],'children':[base+idx[c] for c in children[n]]})
j['nodes'].append({'name':'Armature','children':[base+idx['Arm']]}); arm=len(j['nodes'])-1
j['nodes'][meshNode]['name']='Gauntlet'; j['nodes'][meshNode]['skin']=0
for k in ('matrix','translation','rotation','scale'): j['nodes'][meshNode].pop(k,None)
j['skins']=[{'joints':[base+i for i in range(len(order))],'inverseBindMatrices':aI,'skeleton':arm,'name':'HandRig'}]
sc=j['scenes'][j.get('scene',0)]
# mesh node at scene root (skinned mesh transform ignored)
def strip(nodes):  # remove meshNode from any children lists, put at root
    for nd in j['nodes']:
        if 'children' in nd and meshNode in nd['children'] and nd is not j['nodes'][meshNode]: nd['children'].remove(meshNode)
strip(j['nodes'])
sc['nodes']=[x for x in sc['nodes'] if x!=meshNode]+[meshNode,arm]
j['buffers'][0]['byteLength']=len(bin_)
j['asset']={'version':'2.0','generator':'hand-motion-studio auto-rig (from Meshy AI mesh)'}
js=json.dumps(j,separators=(',',':')).encode()
while len(js)%4: js+=b' '
while len(bin_)%4: bin_.append(0)
out=struct.pack('<III',0x46546C67,2,12+8+len(js)+8+len(bin_))+struct.pack('<II',len(js),0x4E4F534A)+js+struct.pack('<II',len(bin_),0x004E4942)+bytes(bin_)
open(OUT,'wb').write(out)
print(OUT,len(out),'joint use',np.bincount(JW[:,0],minlength=len(order)))
print(sc, [j['nodes'][i].get('name') for i in sc['nodes']])
