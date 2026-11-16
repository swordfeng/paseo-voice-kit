//! ggml compute backends and devices.
//!
//! macOS builds link Metal (and the CPU backend) statically, so their devices exist from the
//! start. Linux / Windows release builds (`--features vulkan-dl`) ship every backend as a module
//! next to the executable: one CPU module per instruction-set level and a Vulkan module. They are
//! loaded here, once, before any model: ggml keeps the CPU variant that scores best on this CPU,
//! and the Vulkan module only loads when the Vulkan loader is installed (it is the module, not
//! voicekit, that links it). Without a loader or a GPU, Whisper simply runs on the CPU.

use std::{
    ffi::{c_char, CStr},
    sync::OnceLock,
};

use serde::Serialize;
use whisper_rs_sys as sys;

#[derive(Debug, Clone, Serialize)]
pub struct Device {
    /// ggml device name, e.g. "CPU", "Vulkan0", "Metal".
    pub name: String,
    pub description: String,
    /// cpu | gpu | igpu | accel
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// Backend (registry) the device belongs to, e.g. "CPU", "Vulkan", "Metal", "BLAS".
    pub backend: String,
    #[serde(rename = "memoryFree", skip_serializing_if = "Option::is_none")]
    pub memory_free: Option<u64>,
    #[serde(rename = "memoryTotal", skip_serializing_if = "Option::is_none")]
    pub memory_total: Option<u64>,
}

impl Device {
    /// A device whisper.cpp offloads to when `use_gpu` is set (it takes the first such device).
    pub fn is_gpu(&self) -> bool {
        matches!(self.kind, "gpu" | "igpu")
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Hardware {
    /// Loaded backends, in registration order.
    pub backends: Vec<String>,
    pub devices: Vec<Device>,
    /// Where backend modules were loaded from (runtime-loaded builds only).
    #[serde(rename = "backendDir", skip_serializing_if = "Option::is_none")]
    pub backend_dir: Option<String>,
}

impl Hardware {
    /// The device whisper.cpp uses with `use_gpu`.
    pub fn gpu(&self) -> Option<&Device> {
        self.devices.iter().find(|d| d.is_gpu())
    }

    pub fn has_cpu(&self) -> bool {
        self.devices.iter().any(|d| d.kind == "cpu")
    }
}

static HARDWARE: OnceLock<Hardware> = OnceLock::new();

/// The devices, if `hardware()` has finished initializing them (never blocks).
pub fn hardware_ready() -> Option<&'static Hardware> {
    HARDWARE.get()
}

/// Load the backends (first call only; blocks while another thread initializes) and describe
/// the devices.
pub fn hardware() -> &'static Hardware {
    HARDWARE.get_or_init(|| {
        let backend_dir = load_backends();
        let hw = Hardware { backends: backends(), devices: devices(), backend_dir };
        for d in &hw.devices {
            tracing::info!(device = d.name, backend = d.backend, kind = d.kind, description = d.description, "compute device");
        }
        if cfg!(feature = "vulkan-dl") && !hw.backends.iter().any(|b| b == "Vulkan") {
            tracing::info!("Vulkan backend not loaded (no Vulkan loader or driver); Whisper runs on the CPU");
        }
        if !hw.has_cpu() {
            tracing::error!(dir = ?hw.backend_dir, "no ggml CPU backend found next to voicekit; Whisper models cannot load");
        }
        hw
    })
}

/// Load the backend modules that sit next to the executable. Returns the directory used.
#[cfg(any(feature = "vulkan-dl", feature = "cpu-dl"))]
fn load_backends() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    let mut candidates = vec![dir.clone()];
    // `cargo test` binaries live in target/<profile>/deps; the modules are one level up.
    if dir.file_name().is_some_and(|n| n == "deps") {
        candidates.extend(dir.parent().map(|p| p.to_path_buf()));
    }
    for dir in candidates {
        let Some(path) = dir.to_str().and_then(|s| std::ffi::CString::new(s).ok()) else { continue };
        // Only this directory (plus GGML_BACKEND_PATH): ggml's default search also tries the
        // current directory, which should not be able to inject code.
        unsafe { sys::ggml_backend_load_all_from_path(path.as_ptr()) };
        if devices().iter().any(|d| d.kind == "cpu") {
            return Some(dir.display().to_string());
        }
    }
    None
}

#[cfg(not(any(feature = "vulkan-dl", feature = "cpu-dl")))]
fn load_backends() -> Option<String> {
    // Statically linked backends register themselves.
    None
}

fn string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        String::new()
    } else {
        // SAFETY: ggml returns NUL-terminated strings that live as long as the backend.
        unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
    }
}

fn backends() -> Vec<String> {
    // SAFETY: plain registry queries; indices are within the reported count.
    unsafe { (0..sys::ggml_backend_reg_count()).map(|i| string(sys::ggml_backend_reg_name(sys::ggml_backend_reg_get(i)))).collect() }
}

fn devices() -> Vec<Device> {
    let mut out = Vec::new();
    // SAFETY: as above; ggml_backend_dev_memory writes two usize values.
    unsafe {
        for i in 0..sys::ggml_backend_dev_count() {
            let dev = sys::ggml_backend_dev_get(i);
            if dev.is_null() {
                continue;
            }
            let kind = match sys::ggml_backend_dev_type(dev) {
                sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_CPU => "cpu",
                sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU => "gpu",
                sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU => "igpu",
                _ => "accel",
            };
            let (mut free, mut total) = (0usize, 0usize);
            sys::ggml_backend_dev_memory(dev, &mut free, &mut total);
            let reg = sys::ggml_backend_dev_backend_reg(dev);
            out.push(Device {
                name: string(sys::ggml_backend_dev_name(dev)),
                description: string(sys::ggml_backend_dev_description(dev)),
                kind,
                backend: if reg.is_null() { String::new() } else { string(sys::ggml_backend_reg_name(reg)) },
                memory_free: (total > 0).then_some(free as u64),
                memory_total: (total > 0).then_some(total as u64),
            });
        }
    }
    out
}
