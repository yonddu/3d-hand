import sys; sys.path.insert(0,'.')
from load import load
import numpy as np, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
j,b,V,F=load(sys.argv[1])
J=np.load('J.npy',allow_pickle=True).item()
fig,ax=plt.subplots(2,1,figsize=(14,12))
H=V[V[:,2]>0.15]
ax[0].scatter(H[:,2],H[:,1],s=0.4,c='#bbb'); ax[1].scatter(H[:,2],H[:,0],s=0.4,c='#bbb')
chains=[['Hand','Thumb1','Thumb2','Thumb3','Thumb4']]+[['Hand',f+'1',f+'2',f+'3',f+'4'] for f in ['Index','Middle','Ring','Pinky']]
for ch in chains:
    P=np.array([J[k] for k in ch]); ax[0].plot(P[:,2],P[:,1],'r-o',ms=4); ax[1].plot(P[:,2],P[:,0],'r-o',ms=4)
for a in ax: a.set_aspect('equal'); a.grid()
plt.savefig('joints.png',dpi=70)
