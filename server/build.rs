//! `vulkan-dl` builds on Linux link libwhisper/libggml/libggml-base as shared libraries that
//! ship next to the executable (whisper-rs-sys copies them into target/<profile>/). Point the
//! executable's runpath at its own directory so it finds them wherever it is installed.
//! Windows needs nothing: the loader searches the executable's directory first.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let dl = std::env::var_os("CARGO_FEATURE_VULKAN_DL").is_some();
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if dl && os == "linux" {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN");
    }
}
