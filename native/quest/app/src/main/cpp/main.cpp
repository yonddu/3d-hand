// Quest hand recorder: native OpenXR app (no browser, so no browser window can push it to the back).
//  - passthrough (XR_FB_passthrough) if the headset has it, else black
//  - every frame: 26 hand joints per hand (XR_EXT_hand_tracking: position, orientation, radius) and
//    the head pose, saved as JSON lines to Download/quest-hands-<date>.jsonl (each app start = one file)
//  - sync mark for the phone video: both index finger tips touching (skin gap < 1 cm, open > 3 cm);
//    the tips flash yellow and one yellow dot per mark shows above the view (thumb-index pinch with
//    the palm to the face is Quest's own menu gesture, so it is not used)
//  - a red dot top-left while recording; quit the app (Meta button -> close) to finish the file
#include <android/log.h>
#include <android_native_app_glue.h>
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <jni.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define XR_USE_PLATFORM_ANDROID
#define XR_USE_GRAPHICS_API_OPENGL_ES
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "questhands", __VA_ARGS__)
#define CHK(x) do { XrResult r_ = (x); if (XR_FAILED(r_)) { LOG("%s failed: %d (line %d)", #x, (int)r_, __LINE__); } } while (0)

static const char* JOINT_NAMES[XR_HAND_JOINT_COUNT_EXT] = {
  "palm", "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
  "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
  "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
  "little-finger-metacarpal", "little-finger-phalanx-proximal", "little-finger-phalanx-intermediate", "little-finger-phalanx-distal", "little-finger-tip"};

// ---------- small math ----------
struct V3 { float x, y, z; };
static V3 rot(const XrQuaternionf& q, V3 v) { // v + w t + q x t, t = 2 q x v
  float tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return { v.x + q.w * tx + (q.y * tz - q.z * ty), v.y + q.w * ty + (q.z * tx - q.x * tz), v.z + q.w * tz + (q.x * ty - q.y * tx) };
}
// column-major 4x4
static void matMul(float* o, const float* a, const float* b) {
  float r[16];
  for (int c = 0; c < 4; c++) for (int rr = 0; rr < 4; rr++) { float s = 0; for (int k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k]; r[c * 4 + rr] = s; }
  memcpy(o, r, sizeof r);
}
static void projFov(float* m, const XrFovf& f, float n, float fa) {
  float l = tanf(f.angleLeft), r = tanf(f.angleRight), u = tanf(f.angleUp), d = tanf(f.angleDown);
  float w = r - l, h = u - d;
  memset(m, 0, 64);
  m[0] = 2 / w; m[5] = 2 / h; m[8] = (r + l) / w; m[9] = (u + d) / h; m[10] = -(fa + n) / (fa - n); m[11] = -1; m[14] = -2 * fa * n / (fa - n);
}
static void viewFromPose(float* m, const XrPosef& p) { // inverse of the eye pose
  XrQuaternionf qi = { -p.orientation.x, -p.orientation.y, -p.orientation.z, p.orientation.w };
  V3 ex = rot(qi, {1, 0, 0}), ey = rot(qi, {0, 1, 0}), ez = rot(qi, {0, 0, 1});
  V3 t = rot(qi, { -p.position.x, -p.position.y, -p.position.z });
  float r[16] = { ex.x, ex.y, ex.z, 0, ey.x, ey.y, ey.z, 0, ez.x, ez.y, ez.z, 0, t.x, t.y, t.z, 1 };
  memcpy(m, r, 64);
}

// ---------- app state ----------
struct App {
  android_app* aapp = nullptr;
  bool resumed = false, quit = false;
  XrInstance inst = XR_NULL_HANDLE; XrSystemId sys = XR_NULL_SYSTEM_ID; XrSession sess = XR_NULL_HANDLE;
  XrSpace space = XR_NULL_HANDLE, viewSpace = XR_NULL_HANDLE; bool stage = false;
  XrSessionState state = XR_SESSION_STATE_UNKNOWN; bool running = false, focused = false;
  bool hasHands = false, hasPass = false;
  PFN_xrCreateHandTrackerEXT createHand = nullptr; PFN_xrLocateHandJointsEXT locateHand = nullptr;
  XrHandTrackerEXT hand[2] = { XR_NULL_HANDLE, XR_NULL_HANDLE };
  PFN_xrCreatePassthroughFB createPass = nullptr; PFN_xrCreatePassthroughLayerFB createPassLayer = nullptr; PFN_xrPassthroughStartFB passStart = nullptr;
  XrPassthroughFB pass = XR_NULL_HANDLE; XrPassthroughLayerFB passLayer = XR_NULL_HANDLE;
  EGLDisplay dpy = EGL_NO_DISPLAY; EGLConfig cfg = nullptr; EGLContext ctx = EGL_NO_CONTEXT; EGLSurface surf = EGL_NO_SURFACE;
  struct Eye { XrSwapchain sc; int w, h; std::vector<XrSwapchainImageOpenGLESKHR> imgs; std::vector<GLuint> fbo; };
  std::vector<XrViewConfigurationView> vcv; Eye eye[2];
  GLuint prog = 0, vbo = 0, vao = 0; GLint uMvp = -1, uSize = -1;
  // recording
  FILE* out = nullptr; std::string outPath; long long startWall = 0; XrTime t0 = 0; XrTime lastSave = 0;
  long frames = 0; int marks = 0; bool tipTouch = false;
} A;

static long long wallMs() { timespec ts; clock_gettime(CLOCK_REALTIME, &ts); return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000; }

static void openFile() {
  if (A.out) return;
  A.startWall = wallMs();
  time_t now = time(nullptr); tm lt; localtime_r(&now, &lt);
  char name[96]; strftime(name, sizeof name, "quest-hands-%Y%m%d-%H%M%S.jsonl", &lt);
  // Download/ first (the Quest Files app shows it), else the app's own folder
  const char* dirs[] = { "/sdcard/Download", A.aapp->activity->externalDataPath };
  for (const char* d : dirs) {
    if (!d) continue;
    std::string p = std::string(d) + "/" + name;
    A.out = fopen(p.c_str(), "w");
    if (A.out) { A.outPath = p; break; }
    LOG("cannot write %s", p.c_str());
  }
  if (!A.out) return;
  fprintf(A.out, "{\"format\":\"hms-quest-hands-jsonl-1\",\"app\":\"q0.1\",\"startWall\":%lld,\"space\":\"%s (m), y up\",\"row\":[\"px\",\"py\",\"pz\",\"qx\",\"qy\",\"qz\",\"qw\",\"radius\"],\"joints\":[", A.startWall, A.stage ? "stage" : "local");
  for (int i = 0; i < XR_HAND_JOINT_COUNT_EXT; i++) fprintf(A.out, "%s\"%s\"", i ? "," : "", JOINT_NAMES[i]);
  fprintf(A.out, "],\"lines\":\"frame lines {t,wall,head,hands{left,right}}; mark lines {mark,t,wall}; event lines {event,t,wall}\"}\n");
  fflush(A.out);
  LOG("recording to %s", A.outPath.c_str());
}
static void event(const char* e, XrTime t) {
  if (!A.out) return;
  fprintf(A.out, "{\"event\":\"%s\",\"t\":%.1f,\"wall\":%lld}\n", e, A.t0 ? (t - A.t0) / 1e6 : 0.0, wallMs()); fflush(A.out);
}
static void closeFile() { if (A.out) { event("end", A.t0); fclose(A.out); A.out = nullptr; LOG("closed %s (%ld frames, %d marks)", A.outPath.c_str(), A.frames, A.marks); } }

// ---------- android ----------
static void onCmd(android_app* app, int32_t cmd) {
  switch (cmd) {
    case APP_CMD_RESUME: A.resumed = true; break;
    case APP_CMD_PAUSE: A.resumed = false; if (A.out) fflush(A.out); break;
    case APP_CMD_STOP: if (A.out) fflush(A.out); break;
    case APP_CMD_DESTROY: A.quit = true; break;
    default: break;
  }
}

// ---------- GL ----------
static const char* VS = "#version 300 es\nlayout(location=0) in vec3 p; layout(location=1) in vec4 c; uniform mat4 mvp; uniform float sz; out vec4 vc;\n"
  "void main(){ gl_Position = mvp * vec4(p,1.0); gl_PointSize = clamp(sz / max(gl_Position.w, 0.05), 3.0, 64.0); vc = c; }\n";
static const char* FS = "#version 300 es\nprecision mediump float; in vec4 vc; out vec4 o;\n"
  "void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d,d) > 0.25) discard; o = vc; }\n";
static GLuint shader(GLenum t, const char* s) { GLuint h = glCreateShader(t); glShaderSource(h, 1, &s, nullptr); glCompileShader(h); GLint ok; glGetShaderiv(h, GL_COMPILE_STATUS, &ok); if (!ok) { char b[512]; glGetShaderInfoLog(h, 512, nullptr, b); LOG("shader: %s", b); } return h; }
static void initGL() {
  A.prog = glCreateProgram(); glAttachShader(A.prog, shader(GL_VERTEX_SHADER, VS)); glAttachShader(A.prog, shader(GL_FRAGMENT_SHADER, FS)); glLinkProgram(A.prog);
  A.uMvp = glGetUniformLocation(A.prog, "mvp"); A.uSize = glGetUniformLocation(A.prog, "sz");
  glGenVertexArrays(1, &A.vao); glGenBuffers(1, &A.vbo);
  glBindVertexArray(A.vao); glBindBuffer(GL_ARRAY_BUFFER, A.vbo);
  glEnableVertexAttribArray(0); glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 28, (void*)0);
  glEnableVertexAttribArray(1); glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, 28, (void*)12);
  glBindVertexArray(0);
}
static bool initEGL() {
  A.dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY); eglInitialize(A.dpy, nullptr, nullptr);
  const EGLint ca[] = { EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_NONE };
  EGLint n = 0; if (!eglChooseConfig(A.dpy, ca, &A.cfg, 1, &n) || n < 1) { LOG("no EGL config"); return false; }
  const EGLint cx[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE }; A.ctx = eglCreateContext(A.dpy, A.cfg, EGL_NO_CONTEXT, cx);
  const EGLint sa[] = { EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE }; A.surf = eglCreatePbufferSurface(A.dpy, A.cfg, sa);
  if (!eglMakeCurrent(A.dpy, A.surf, A.surf, A.ctx)) { LOG("eglMakeCurrent failed"); return false; }
  return true;
}

// ---------- XR ----------
template <class F> static F fn(const char* name) { PFN_xrVoidFunction f = nullptr; xrGetInstanceProcAddr(A.inst, name, &f); return (F)f; }

static bool initXR() {
  PFN_xrInitializeLoaderKHR initLoader = nullptr;
  xrGetInstanceProcAddr(XR_NULL_HANDLE, "xrInitializeLoaderKHR", (PFN_xrVoidFunction*)&initLoader);
  if (initLoader) { XrLoaderInitInfoAndroidKHR li{XR_TYPE_LOADER_INIT_INFO_ANDROID_KHR}; li.applicationVM = A.aapp->activity->vm; li.applicationContext = A.aapp->activity->clazz; initLoader((XrLoaderInitInfoBaseHeaderKHR*)&li); }
  uint32_t ne = 0; xrEnumerateInstanceExtensionProperties(nullptr, 0, &ne, nullptr);
  std::vector<XrExtensionProperties> ext(ne, {XR_TYPE_EXTENSION_PROPERTIES}); xrEnumerateInstanceExtensionProperties(nullptr, ne, &ne, ext.data());
  auto has = [&](const char* n) { for (auto& e : ext) if (!strcmp(e.extensionName, n)) return true; return false; };
  std::vector<const char*> en = { XR_KHR_ANDROID_CREATE_INSTANCE_EXTENSION_NAME, XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME };
  A.hasHands = has(XR_EXT_HAND_TRACKING_EXTENSION_NAME); if (A.hasHands) en.push_back(XR_EXT_HAND_TRACKING_EXTENSION_NAME);
  A.hasPass = has(XR_FB_PASSTHROUGH_EXTENSION_NAME); if (A.hasPass) en.push_back(XR_FB_PASSTHROUGH_EXTENSION_NAME);
  LOG("extensions: hands %d passthrough %d", A.hasHands, A.hasPass);
  XrInstanceCreateInfoAndroidKHR ai{XR_TYPE_INSTANCE_CREATE_INFO_ANDROID_KHR}; ai.applicationVM = A.aapp->activity->vm; ai.applicationActivity = A.aapp->activity->clazz;
  XrInstanceCreateInfo ci{XR_TYPE_INSTANCE_CREATE_INFO}; ci.next = &ai;
  strcpy(ci.applicationInfo.applicationName, "HandMotionQuest"); ci.applicationInfo.applicationVersion = 1;
  strcpy(ci.applicationInfo.engineName, "none"); ci.applicationInfo.apiVersion = XR_MAKE_VERSION(1, 0, 34);
  ci.enabledExtensionCount = (uint32_t)en.size(); ci.enabledExtensionNames = en.data();
  if (XR_FAILED(xrCreateInstance(&ci, &A.inst))) { LOG("xrCreateInstance failed"); return false; }
  XrSystemGetInfo sg{XR_TYPE_SYSTEM_GET_INFO}; sg.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
  if (XR_FAILED(xrGetSystem(A.inst, &sg, &A.sys))) { LOG("xrGetSystem failed"); return false; }
  auto getReq = fn<PFN_xrGetOpenGLESGraphicsRequirementsKHR>("xrGetOpenGLESGraphicsRequirementsKHR");
  XrGraphicsRequirementsOpenGLESKHR req{XR_TYPE_GRAPHICS_REQUIREMENTS_OPENGL_ES_KHR}; if (getReq) getReq(A.inst, A.sys, &req);
  if (!initEGL()) return false;
  XrGraphicsBindingOpenGLESAndroidKHR gb{XR_TYPE_GRAPHICS_BINDING_OPENGL_ES_ANDROID_KHR}; gb.display = A.dpy; gb.config = A.cfg; gb.context = A.ctx;
  XrSessionCreateInfo sc{XR_TYPE_SESSION_CREATE_INFO}; sc.next = &gb; sc.systemId = A.sys;
  if (XR_FAILED(xrCreateSession(A.inst, &sc, &A.sess))) { LOG("xrCreateSession failed"); return false; }
  // stage (floor, fixed) if the runtime has it, else local
  uint32_t ns = 0; xrEnumerateReferenceSpaces(A.sess, 0, &ns, nullptr); std::vector<XrReferenceSpaceType> st(ns); xrEnumerateReferenceSpaces(A.sess, ns, &ns, st.data());
  for (auto t : st) if (t == XR_REFERENCE_SPACE_TYPE_STAGE) A.stage = true;
  XrReferenceSpaceCreateInfo rs{XR_TYPE_REFERENCE_SPACE_CREATE_INFO}; rs.poseInReferenceSpace.orientation.w = 1;
  rs.referenceSpaceType = A.stage ? XR_REFERENCE_SPACE_TYPE_STAGE : XR_REFERENCE_SPACE_TYPE_LOCAL; CHK(xrCreateReferenceSpace(A.sess, &rs, &A.space));
  rs.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW; CHK(xrCreateReferenceSpace(A.sess, &rs, &A.viewSpace));
  // swapchains
  uint32_t nv = 0; xrEnumerateViewConfigurationViews(A.inst, A.sys, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &nv, nullptr);
  A.vcv.assign(nv, {XR_TYPE_VIEW_CONFIGURATION_VIEW}); xrEnumerateViewConfigurationViews(A.inst, A.sys, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, nv, &nv, A.vcv.data());
  uint32_t nf = 0; xrEnumerateSwapchainFormats(A.sess, 0, &nf, nullptr); std::vector<int64_t> fm(nf); xrEnumerateSwapchainFormats(A.sess, nf, &nf, fm.data());
  int64_t fmt = fm.empty() ? GL_RGBA8 : fm[0]; for (auto f : fm) if (f == GL_SRGB8_ALPHA8) { fmt = f; break; }
  for (uint32_t e = 0; e < 2 && e < nv; e++) {
    XrSwapchainCreateInfo si{XR_TYPE_SWAPCHAIN_CREATE_INFO}; si.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT; si.format = fmt; si.sampleCount = 1;
    si.width = A.vcv[e].recommendedImageRectWidth; si.height = A.vcv[e].recommendedImageRectHeight; si.faceCount = 1; si.arraySize = 1; si.mipCount = 1;
    CHK(xrCreateSwapchain(A.sess, &si, &A.eye[e].sc)); A.eye[e].w = si.width; A.eye[e].h = si.height;
    uint32_t ni = 0; xrEnumerateSwapchainImages(A.eye[e].sc, 0, &ni, nullptr);
    A.eye[e].imgs.assign(ni, {XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR}); xrEnumerateSwapchainImages(A.eye[e].sc, ni, &ni, (XrSwapchainImageBaseHeader*)A.eye[e].imgs.data());
    A.eye[e].fbo.resize(ni); glGenFramebuffers(ni, A.eye[e].fbo.data());
    for (uint32_t i = 0; i < ni; i++) { glBindFramebuffer(GL_FRAMEBUFFER, A.eye[e].fbo[i]); glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, A.eye[e].imgs[i].image, 0); }
  }
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  if (A.hasHands) {
    A.createHand = fn<PFN_xrCreateHandTrackerEXT>("xrCreateHandTrackerEXT"); A.locateHand = fn<PFN_xrLocateHandJointsEXT>("xrLocateHandJointsEXT");
    for (int h = 0; h < 2; h++) { XrHandTrackerCreateInfoEXT hi{XR_TYPE_HAND_TRACKER_CREATE_INFO_EXT}; hi.hand = h ? XR_HAND_RIGHT_EXT : XR_HAND_LEFT_EXT; hi.handJointSet = XR_HAND_JOINT_SET_DEFAULT_EXT; if (A.createHand) CHK(A.createHand(A.sess, &hi, &A.hand[h])); }
  }
  if (A.hasPass) {
    A.createPass = fn<PFN_xrCreatePassthroughFB>("xrCreatePassthroughFB"); A.createPassLayer = fn<PFN_xrCreatePassthroughLayerFB>("xrCreatePassthroughLayerFB"); A.passStart = fn<PFN_xrPassthroughStartFB>("xrPassthroughStartFB");
    XrPassthroughCreateInfoFB pc{XR_TYPE_PASSTHROUGH_CREATE_INFO_FB}; pc.flags = XR_PASSTHROUGH_IS_RUNNING_AT_CREATION_BIT_FB;
    if (!A.createPass || XR_FAILED(A.createPass(A.sess, &pc, &A.pass))) { A.hasPass = false; LOG("no passthrough"); }
    else {
      XrPassthroughLayerCreateInfoFB lc{XR_TYPE_PASSTHROUGH_LAYER_CREATE_INFO_FB}; lc.passthrough = A.pass; lc.flags = XR_PASSTHROUGH_IS_RUNNING_AT_CREATION_BIT_FB; lc.purpose = XR_PASSTHROUGH_LAYER_PURPOSE_RECONSTRUCTION_FB;
      if (!A.createPassLayer || XR_FAILED(A.createPassLayer(A.sess, &lc, &A.passLayer))) { A.hasPass = false; LOG("no passthrough layer"); }
    }
  }
  initGL();
  return true;
}

static void pollXR() {
  XrEventDataBuffer ev{XR_TYPE_EVENT_DATA_BUFFER};
  while (xrPollEvent(A.inst, &ev) == XR_SUCCESS) {
    if (ev.type == XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) {
      auto* s = (XrEventDataSessionStateChanged*)&ev; A.state = s->state;
      LOG("session state %d", (int)A.state);
      if (A.state == XR_SESSION_STATE_READY) { XrSessionBeginInfo bi{XR_TYPE_SESSION_BEGIN_INFO}; bi.primaryViewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO; CHK(xrBeginSession(A.sess, &bi)); A.running = true; }
      else if (A.state == XR_SESSION_STATE_STOPPING) { CHK(xrEndSession(A.sess)); A.running = false; if (A.out) fflush(A.out); }
      else if (A.state == XR_SESSION_STATE_EXITING || A.state == XR_SESSION_STATE_LOSS_PENDING) { A.quit = true; }
      bool f = A.state == XR_SESSION_STATE_FOCUSED;
      if (f != A.focused) { A.focused = f; event(f ? "focused" : "unfocused", s->time); }
    } else if (ev.type == XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING) A.quit = true;
    ev = {XR_TYPE_EVENT_DATA_BUFFER};
  }
}

struct Pt { float x, y, z, r, g, b, a; };

static void frame() {
  XrFrameWaitInfo wi{XR_TYPE_FRAME_WAIT_INFO}; XrFrameState fs{XR_TYPE_FRAME_STATE};
  if (XR_FAILED(xrWaitFrame(A.sess, &wi, &fs))) return;
  XrFrameBeginInfo bi{XR_TYPE_FRAME_BEGIN_INFO}; CHK(xrBeginFrame(A.sess, &bi));
  const XrTime t = fs.predictedDisplayTime;
  std::vector<Pt> pts;
  // head
  XrSpaceLocation hl{XR_TYPE_SPACE_LOCATION}; xrLocateSpace(A.viewSpace, A.space, t, &hl);
  bool headOk = (hl.locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT) && (hl.locationFlags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT);
  // hands
  XrHandJointLocationEXT jl[2][XR_HAND_JOINT_COUNT_EXT]; bool act[2] = { false, false };
  if (A.locateHand) for (int h = 0; h < 2; h++) {
    if (!A.hand[h]) continue;
    XrHandJointLocationsEXT locs{XR_TYPE_HAND_JOINT_LOCATIONS_EXT}; locs.jointCount = XR_HAND_JOINT_COUNT_EXT; locs.jointLocations = jl[h];
    XrHandJointsLocateInfoEXT li{XR_TYPE_HAND_JOINTS_LOCATE_INFO_EXT}; li.baseSpace = A.space; li.time = t;
    if (XR_SUCCEEDED(A.locateHand(A.hand[h], &li, &locs)) && locs.isActive) act[h] = true;
  }
  auto valid = [&](int h, int j) { return act[h] && (jl[h][j].locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT); };
  // sync mark: both index tips touching
  if (valid(0, XR_HAND_JOINT_INDEX_TIP_EXT) && valid(1, XR_HAND_JOINT_INDEX_TIP_EXT)) {
    auto& a = jl[0][XR_HAND_JOINT_INDEX_TIP_EXT]; auto& b = jl[1][XR_HAND_JOINT_INDEX_TIP_EXT];
    float d = sqrtf(powf(a.pose.position.x - b.pose.position.x, 2) + powf(a.pose.position.y - b.pose.position.y, 2) + powf(a.pose.position.z - b.pose.position.z, 2)) - a.radius - b.radius;
    if (!A.tipTouch && d < 0.01f) {
      A.tipTouch = true; A.marks++;
      if (A.out) { fprintf(A.out, "{\"mark\":\"index-tips\",\"t\":%.1f,\"wall\":%lld}\n", A.t0 ? (t - A.t0) / 1e6 : 0.0, wallMs()); }
    } else if (A.tipTouch && d > 0.03f) A.tipTouch = false;
  } else A.tipTouch = false;
  // save (at most ~60 per second), only while a hand is seen
  if (A.focused && (act[0] || act[1])) {
    if (!A.out) openFile();
    if (!A.t0) A.t0 = t;
    if (A.out && t - A.lastSave >= 16000000) {
      A.lastSave = t; A.frames++;
      fprintf(A.out, "{\"t\":%.1f,\"wall\":%lld,\"head\":", (t - A.t0) / 1e6, wallMs());
      if (headOk) { auto& p = hl.pose; fprintf(A.out, "[%.5f,%.5f,%.5f,%.4f,%.4f,%.4f,%.4f]", p.position.x, p.position.y, p.position.z, p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w); } else fprintf(A.out, "null");
      fprintf(A.out, ",\"hands\":{");
      bool first = true;
      for (int h = 0; h < 2; h++) {
        if (!act[h]) continue;
        fprintf(A.out, "%s\"%s\":[", first ? "" : ",", h ? "right" : "left"); first = false;
        for (int j = 0; j < XR_HAND_JOINT_COUNT_EXT; j++) {
          if (j) fputc(',', A.out);
          if (!valid(h, j)) { fprintf(A.out, "null"); continue; }
          auto& p = jl[h][j].pose; fprintf(A.out, "[%.5f,%.5f,%.5f,%.4f,%.4f,%.4f,%.4f,%.5f]", p.position.x, p.position.y, p.position.z, p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w, jl[h][j].radius);
        }
        fputc(']', A.out);
      }
      fprintf(A.out, "}}\n");
      if (A.frames % 60 == 0) fflush(A.out);
    }
  }
  // points to draw: joints (left blue, right green, touching tips yellow)
  for (int h = 0; h < 2; h++) for (int j = 0; j < XR_HAND_JOINT_COUNT_EXT; j++) {
    if (!valid(h, j)) continue;
    auto& p = jl[h][j].pose.position; bool tip = j == XR_HAND_JOINT_INDEX_TIP_EXT && A.tipTouch;
    pts.push_back({ p.x, p.y, p.z, tip ? 1.f : (h ? 0.37f : 0.31f), tip ? 0.82f : (h ? 0.88f : 0.69f), tip ? 0.25f : (h ? 0.54f : 1.f), 1.f });
  }
  // head-fixed: red dot (recording) top-left, one yellow dot per mark along the top
  if (headOk) {
    auto at = [&](float x, float y, float r, float g, float b) { V3 v = rot(hl.pose.orientation, { x, y, -1.2f }); pts.push_back({ hl.pose.position.x + v.x, hl.pose.position.y + v.y, hl.pose.position.z + v.z, r, g, b, 1.f }); };
    if (A.out) at(-0.32f, 0.26f, 0.95f, 0.2f, 0.15f);
    for (int m = 0; m < A.marks && m < 20; m++) at(-0.24f + m * 0.04f, 0.26f, 1.f, 0.82f, 0.25f);
    if (!act[0] && !act[1]) at(0.f, 0.f, 0.6f, 0.6f, 0.6f); // grey centre dot: no hand seen
  }
  // render both eyes
  std::vector<XrCompositionLayerProjectionView> pv(2, {XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW});
  XrViewLocateInfo vli{XR_TYPE_VIEW_LOCATE_INFO}; vli.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO; vli.displayTime = t; vli.space = A.space;
  XrViewState vs{XR_TYPE_VIEW_STATE}; XrView views[2] = { {XR_TYPE_VIEW}, {XR_TYPE_VIEW} }; uint32_t nvw = 0;
  bool drew = false;
  if (fs.shouldRender && XR_SUCCEEDED(xrLocateViews(A.sess, &vli, &vs, 2, &nvw, views)) && nvw == 2) {
    glBindBuffer(GL_ARRAY_BUFFER, A.vbo); glBufferData(GL_ARRAY_BUFFER, pts.size() * sizeof(Pt), pts.data(), GL_STREAM_DRAW);
    for (int e = 0; e < 2; e++) {
      auto& E = A.eye[e]; uint32_t idx = 0;
      XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO}; xrAcquireSwapchainImage(E.sc, &ai, &idx);
      XrSwapchainImageWaitInfo wi2{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO}; wi2.timeout = XR_INFINITE_DURATION; xrWaitSwapchainImage(E.sc, &wi2);
      glBindFramebuffer(GL_FRAMEBUFFER, E.fbo[idx]); glViewport(0, 0, E.w, E.h);
      glClearColor(0, 0, 0, A.hasPass ? 0.f : 1.f); glClear(GL_COLOR_BUFFER_BIT);
      float P[16], V[16], M[16]; projFov(P, views[e].fov, 0.05f, 100.f); viewFromPose(V, views[e].pose); matMul(M, P, V);
      glUseProgram(A.prog); glUniformMatrix4fv(A.uMvp, 1, GL_FALSE, M); glUniform1f(A.uSize, E.h * 0.006f);
      glBindVertexArray(A.vao); glDrawArrays(GL_POINTS, 0, (GLsizei)pts.size()); glBindVertexArray(0);
      glBindFramebuffer(GL_FRAMEBUFFER, 0);
      XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO}; xrReleaseSwapchainImage(E.sc, &ri);
      pv[e].pose = views[e].pose; pv[e].fov = views[e].fov;
      pv[e].subImage.swapchain = E.sc; pv[e].subImage.imageRect = { { 0, 0 }, { E.w, E.h } };
    }
    drew = true;
  }
  XrCompositionLayerPassthroughFB pl{XR_TYPE_COMPOSITION_LAYER_PASSTHROUGH_FB}; pl.layerHandle = A.passLayer;
  XrCompositionLayerProjection proj{XR_TYPE_COMPOSITION_LAYER_PROJECTION}; proj.space = A.space; proj.viewCount = 2; proj.views = pv.data();
  if (A.hasPass) proj.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
  std::vector<const XrCompositionLayerBaseHeader*> layers;
  if (A.hasPass) layers.push_back((XrCompositionLayerBaseHeader*)&pl);
  if (drew) layers.push_back((XrCompositionLayerBaseHeader*)&proj);
  XrFrameEndInfo ei{XR_TYPE_FRAME_END_INFO}; ei.displayTime = t; ei.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
  ei.layerCount = (uint32_t)layers.size(); ei.layers = layers.data();
  CHK(xrEndFrame(A.sess, &ei));
}

void android_main(android_app* app) {
  A.aapp = app; app->onAppCmd = onCmd;
  if (!initXR()) { LOG("XR init failed"); }
  while (!A.quit && !app->destroyRequested) {
    int events; android_poll_source* src;
    // block while paused and not running; else poll
    while (ALooper_pollOnce((!A.resumed && !A.running) ? 250 : 0, nullptr, &events, (void**)&src) >= 0) {
      if (src) src->process(app, src);
      if (app->destroyRequested) break;
    }
    if (!A.sess) continue;
    pollXR();
    if (A.running) frame();
  }
  closeFile();
  if (A.sess) xrDestroySession(A.sess);
  if (A.inst) xrDestroyInstance(A.inst);
}
