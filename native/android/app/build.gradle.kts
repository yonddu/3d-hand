plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "com.yonddu.handmotion"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.yonddu.handmotion.benchmark"
        minSdk = 31
        targetSdk = 35
        versionCode = 7
        versionName = "0.7-raw-mediapipe-restored"
        ndk { abiFilters += "arm64-v8a" }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    androidResources { noCompress += "task" }
}
val prepareHandModel by tasks.registering(Copy::class) {
    from(rootProject.file("../../vendor/models/hand_landmarker.task"))
    into(layout.buildDirectory.dir("generated/handModelAssets"))
}
android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/handModelAssets"))
tasks.named("preBuild") { dependsOn(prepareHandModel) }
dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("com.google.mediapipe:tasks-vision:0.10.21")
    testImplementation("junit:junit:4.13.2")
}
