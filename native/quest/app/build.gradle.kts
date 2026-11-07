plugins { id("com.android.application") }
android {
    namespace = "com.yonddu.handmotion.quest"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.yonddu.handmotion.quest"
        minSdk = 29
        targetSdk = 32
        versionCode = 1
        versionName = "q0.1-hand-recorder"
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild { cmake { arguments += listOf("-DANDROID_STL=c++_shared") } }
    }
    buildFeatures { prefab = true }
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt") } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
dependencies {
    implementation("org.khronos.openxr:openxr_loader_for_android:1.1.61")
}
