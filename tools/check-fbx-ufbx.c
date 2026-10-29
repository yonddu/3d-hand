// Test-only independent MIT ufbx reader. Never linked or shipped in the app.
#include "ufbx.h"
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdint.h>
static int read_value(FILE*f,void*p,size_t n){return fread(p,n,1,f)==1;}
int main(int argc,char**argv){
 if(argc!=3)return 1;
 ufbx_load_opts opts={0};opts.strict=true;opts.evaluate_skinning=true;opts.target_unit_meters=1.0;opts.target_axes=ufbx_axes_right_handed_y_up;
 ufbx_error error;ufbx_scene*s=ufbx_load_file(argv[1],&opts,&error);
 if(!s){char b[4096];ufbx_format_error(b,sizeof(b),&error);fprintf(stderr,"%s\n",b);return 2;}
 if(s->meshes.count!=1||s->skin_deformers.count!=1||s->anim_stacks.count!=1)return 3;
 FILE*f=fopen(argv[2],"rb");if(!f)return 4;uint32_t samples,vertices;
 if(!read_value(f,&samples,4)||!read_value(f,&vertices,4))return 5;
 double worst=0;
 for(uint32_t k=0;k<samples;k++){
  double time;if(!read_value(f,&time,8))return 6;
  ufbx_evaluate_opts eo={0};eo.evaluate_skinning=true;
  ufbx_scene*e=ufbx_evaluate_scene(s,s->anim,time,&eo,&error);if(!e)return 7;
  ufbx_mesh*m=e->meshes.data[0];if(m->vertices.count!=vertices){fprintf(stderr,"vertices %zu != %u\n",m->vertices.count,vertices);return 8;}
  for(uint32_t v=0;v<vertices;v++){
   double ref[3];if(!read_value(f,ref,24))return 9;
   ufbx_vec3 p=m->skinned_position.values.data[v];
   if(m->skinned_is_local)p=ufbx_transform_position(&m->instances.data[0]->geometry_to_world,p);
   double d=sqrt((p.x-ref[0])*(p.x-ref[0])+(p.y-ref[1])*(p.y-ref[1])+(p.z-ref[2])*(p.z-ref[2]));
   if(!isfinite(d))return 10;if(d>worst)worst=d;
  }
  ufbx_free_scene(e);
 }
 printf("ufbx strict: %u samples x %u skinned vertices, max world error %.9g meters, unit=%.3g meters\n",samples,vertices,worst,s->settings.unit_meters);
 fclose(f);ufbx_free_scene(s);
 return worst<0.001?0:11;
}
