// Independent MIT ufbx test; not linked into the Android app.
#include "ufbx.h"
#include <stdio.h>
#include <stdint.h>
#include <math.h>
static const char *names[]={"Arm","ForeArm","Hand","HandThumb1","HandThumb2","HandThumb3","HandThumb4","HandIndex1","HandIndex2","HandIndex3","HandIndex4","HandMiddle1","HandMiddle2","HandMiddle3","HandMiddle4","HandRing1","HandRing2","HandRing3","HandRing4","HandPinky1","HandPinky2","HandPinky3","HandPinky4"};
int main(int argc,char**argv){
 if(argc!=3)return 1;ufbx_load_opts opts={0};opts.strict=true;opts.target_unit_meters=1;opts.target_axes=ufbx_axes_right_handed_y_up;
 ufbx_error err;ufbx_scene*s=ufbx_load_file(argv[1],&opts,&err);if(!s){char b[4096];ufbx_format_error(b,sizeof(b),&err);fprintf(stderr,"%s\n",b);return 2;}
 if(s->meshes.count||s->anim_stacks.count!=1||s->bones.count!=46)return 3;
 FILE*f=fopen(argv[2],"rb");if(!f)return 4;uint32_t count,joints;fread(&count,4,1,f);fread(&joints,4,1,f);if(joints!=23)return 5;double worst=0;
 for(uint32_t k=0;k<count;k++){double t;fread(&t,8,1,f);ufbx_scene*e=ufbx_evaluate_scene(s,s->anim,t,NULL,&err);if(!e)return 6;
  for(int side=0;side<2;side++){uint32_t present;fread(&present,4,1,f);
   for(int j=0;j<23;j++){double ref[3];fread(ref,8,3,f);char name[80];snprintf(name,sizeof(name),"%s%s",side?"Right":"Left",names[j]);ufbx_node*n=ufbx_find_node(e,name);if(!n)return 7;
    if(!present){if(j==0&&fabs(n->local_transform.scale.x)>1e-6)return 8;continue;}
    ufbx_vec3 p=n->node_to_world.cols[3];double d=sqrt((p.x-ref[0])*(p.x-ref[0])+(p.y-ref[1])*(p.y-ref[1])+(p.z-ref[2])*(p.z-ref[2]));if(!isfinite(d))return 9;if(d>worst){worst=d;fprintf(stderr,"difference t=%.12g node=%s actual=%.9g,%.9g,%.9g expected=%.9g,%.9g,%.9g scale=%.9g\n",t,name,p.x,p.y,p.z,ref[0],ref[1],ref[2],n->local_transform.scale.x);}
   }
  }ufbx_free_scene(e);
 }
 printf("Native raw FBX: %u frames, 46 joint nodes, gaps hidden, max position error %.9g meters\n",count,worst);
 fclose(f);ufbx_free_scene(s);return worst<1e-6?0:10;
}
