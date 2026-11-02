import sys,json,struct,numpy as np
def load(f):
    b=open(f,'rb').read()
    l=struct.unpack('<I',b[12:16])[0]
    j=json.loads(b[20:20+l]); bin_=b[20+l+8:]
    def acc(i):
        a=j['accessors'][i]; bv=j['bufferViews'][a['bufferView']]
        n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
        dt={5126:np.float32,5125:np.uint32,5123:np.uint16}[a['componentType']]
        off=bv.get('byteOffset',0)+a.get('byteOffset',0)
        return np.frombuffer(bin_,dt,a['count']*n,off).reshape(a['count'],n) if n>1 else np.frombuffer(bin_,dt,a['count'],off)
    p=j['meshes'][0]['primitives'][0]
    return j,b,acc(p['attributes']['POSITION']),acc(p['indices']).reshape(-1,3)
