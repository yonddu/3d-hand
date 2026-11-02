import sys; sys.path.insert(0,'.')
from load import load
import numpy as np
F_=sys.argv[1]; import json as _j; CFG=_j.load(open(sys.argv[2]))
j,b,V,F=load(F_); V=V.astype(float)
def center_at(z,w=0.01):
    m=np.abs(V[:,2]-z)<w; R=V[m]; return np.array([(R[:,0].min()+R[:,0].max())/2,(R[:,1].min()+R[:,1].max())/2,z])
def finger(base,tip,rad=0.017):
    base=np.array(base);tip=np.array(tip); u=tip-base; L=np.linalg.norm(u); u/=L
    q=V[:,[2,1]]-base; t=q@u; lat=np.abs(q@np.array([-u[1],u[0]]))
    m=(lat<rad)&(t>-0.005)&(t<L+0.03); P=V[m]; tt=t[m]
    tipT=np.percentile(tt,99.5)
    def c(tq,w=0.006):
        k=np.abs(tt-tq)<w; R=P[k]; return np.array([(R[:,0].min()+R[:,0].max())/2,R[:,1].mean(),R[:,2].mean()])
    return P,tt,tipT,c
J={}
J['Arm']=center_at(-0.42); J['ForeArm']=center_at(-0.12); J['Hand']=center_at(CFG['wrist'])
specs=CFG['fingers']
palmx=V[(V[:,2]>0.24)&(V[:,2]<0.32)&(V[:,1]>-0.06)&(V[:,1]<0.03)]
for nm,(bs,tp) in specs.items():
    P,tt,T,c=finger(bs,tp,CFG.get('rad',0.017))
    near=c(0.012); far=c(T-0.006)
    axis=(far-near)/np.linalg.norm(far-near)
    tipP=near+axis*(T-0.012)
    L=T
    mcp=near-axis*(0.18*L+0.012)
    if CFG.get('mcpmid'):
        R=V[np.linalg.norm(V[:,[2,1]]-mcp[[2,1]],axis=1)<0.01]; mcp[0]=(R[:,0].min()+R[:,0].max())/2
    J[nm+'1']=mcp; J[nm+'2']=c(0.33*L); J[nm+'3']=c(0.66*L); J[nm+'4']=tipP
P,tt,T,c=finger(*CFG['thumb'],CFG.get('trad',0.02))
near=c(0.008); far=c(T-0.006); axis=(far-near)/np.linalg.norm(far-near)
J['Thumb2']=near-axis*0.006; J['Thumb3']=c(0.5*T); J['Thumb4']=near+axis*(T-0.008)
cz,cy=CFG['cmc']; J['Thumb1']=np.array([V[np.linalg.norm(V[:,[2,1]]-[cz,cy],axis=1)<0.012][:,0].mean(),cy,cz])
for k,v in J.items(): print(k,np.round(v,3))
np.save(CFG.get('out','J.npy'),J)
