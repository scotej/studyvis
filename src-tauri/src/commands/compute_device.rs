use std::fs;

use tauri::{AppHandle, Manager, Runtime};

const AI_HARDWARE_FILE: &str = "ai-hardware.json";
const AI_COMPUTE_DEVICE_KEY: &str = "selection";
const MAX_DEVICE_ID_LEN: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ComputeDeviceSelection {
    Auto,
    Cpu,
    Device(String),
}

pub(crate) fn valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_DEVICE_ID_LEN
        && !value.chars().any(|c| c.is_control() || c == ',')
}

pub(crate) fn parse_selection(value: &str) -> Option<ComputeDeviceSelection> {
    match value {
        "auto" => Some(ComputeDeviceSelection::Auto),
        "cpu" => Some(ComputeDeviceSelection::Cpu),
        _ => value
            .strip_prefix("device:")
            .filter(|id| valid_device_id(id))
            .map(|id| ComputeDeviceSelection::Device(id.to_owned())),
    }
}

pub(crate) fn read_selection<R: Runtime>(app: &AppHandle<R>) -> ComputeDeviceSelection {
    let read = || -> Option<ComputeDeviceSelection> {
        let dir = app.path().app_data_dir().ok()?;
        let bytes = fs::read(dir.join(AI_HARDWARE_FILE)).ok()?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        parse_selection(value.get(AI_COMPUTE_DEVICE_KEY)?.as_str()?)
    };
    read().unwrap_or(ComputeDeviceSelection::Auto)
}

pub(crate) fn gpu_layers(selection: &ComputeDeviceSelection) -> &'static str {
    if matches!(selection, ComputeDeviceSelection::Cpu) {
        return "0";
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        "99"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "0"
    }
}

pub(crate) fn device_arg(selection: &ComputeDeviceSelection) -> Option<&str> {
    match selection {
        ComputeDeviceSelection::Auto => None,
        ComputeDeviceSelection::Cpu => Some("none"),
        ComputeDeviceSelection::Device(id) => Some(id.as_str()),
    }
}

pub(crate) fn selection_log_label(selection: &ComputeDeviceSelection) -> &str {
    match selection {
        ComputeDeviceSelection::Auto => "auto",
        ComputeDeviceSelection::Cpu => "cpu",
        ComputeDeviceSelection::Device(_) => "explicit",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_compute_selections() {
        assert_eq!(parse_selection("auto"), Some(ComputeDeviceSelection::Auto));
        assert_eq!(parse_selection("cpu"), Some(ComputeDeviceSelection::Cpu));
        assert_eq!(
            parse_selection("device:Vulkan1"),
            Some(ComputeDeviceSelection::Device("Vulkan1".to_string()))
        );
    }

    #[test]
    fn rejects_unsafe_or_malformed_device_ids() {
        assert!(parse_selection("device:").is_none());
        assert!(parse_selection("device:Vulkan0,Vulkan1").is_none());
        assert!(parse_selection("device:Vulkan0\n--model").is_none());
        assert!(parse_selection(&format!("device:{}", "x".repeat(129))).is_none());
        assert!(parse_selection("gpu").is_none());
    }

    #[test]
    fn cpu_selection_disables_all_offload() {
        let cpu = ComputeDeviceSelection::Cpu;
        assert_eq!(gpu_layers(&cpu), "0");
        assert_eq!(device_arg(&cpu), Some("none"));
    }

    #[test]
    fn explicit_selection_is_passed_as_one_device_argument() {
        let selection = ComputeDeviceSelection::Device("Vulkan0".to_string());
        assert_eq!(device_arg(&selection), Some("Vulkan0"));
        assert_eq!(selection_log_label(&selection), "explicit");
    }
}
