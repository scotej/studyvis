//! I79 — teach the webview's UI delegate to answer WebKit's display-capture
//! request, which is what makes `navigator.mediaDevices.getDisplayMedia()`
//! work at all on macOS.
//!
//! Since macOS 13 WebKit resolves a `getDisplayMedia()` call one of two ways:
//!
//!   - the app implements **no** capture delegate → WebKit performs the
//!     default action and prompts for a capture surface itself, or
//!   - the app implements
//!     `webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:`
//!     → WebKit stops using the default action and instead asks the *private*
//!     `_webView:requestDisplayCapturePermissionForOrigin:initiatedByFrame:withSystemAudio:decisionHandler:`
//!     delegate, **denying the request outright when that one is absent**.
//!
//! wry implements the first selector (it grants camera/mic) and not the
//! second, so every `getDisplayMedia()` in a Tauri app is rejected with
//! `NotAllowedError` on macOS regardless of user gesture or the app's Screen
//! Recording grant. Upstream: tauri-apps/wry#1195 (open) and #1196
//! (unmerged); an earlier attempt, #1111, was reverted by #1186.
//!
//! Rather than fork wry, we add the missing method to its already-registered
//! delegate class at startup. wry keeps handling every selector it owns; the
//! runtime just gains one more. `WKDisplayCapturePermissionDecisionScreenPrompt`
//! hands the surface choice back to the OS picker, which is the behaviour the
//! rest of the AI capture path is written against (see
//! `src/features/ai/README.md` §"Acquire strategy").
//!
//! Fail-safe by construction: if the selector is ever renamed or the delegate
//! can't be reached, `install` logs and returns, leaving the pre-fix behaviour
//! (`getDisplayMedia` rejects) rather than breaking anything that works.

use std::ffi::CString;

use block2::Block;
use objc2::encode::{Encode, Encoding};
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};
use tauri::{Manager, Runtime};

// WKDisplayCapturePermissionDecision, from WebKit's WKUIDelegatePrivate.h:
// Deny = 0, ScreenPrompt = 1, WindowPrompt = 2. ScreenPrompt is the one that
// reproduces the no-delegate default action.
const DECISION_SCREEN_PROMPT: isize = 1;

// Objective-C method type encoding for the added method — return, then self,
// _cmd, WKWebView*, WKSecurityOrigin*, WKFrameInfo*, BOOL withSystemAudio and
// the decision-handler block. Built from objc2's own `Encode` impls rather
// than spelled out, because `BOOL` encodes as `B` on arm64 and `c` on x86_64
// and a mismatch here corrupts the stack the first time WebKit calls in.
fn method_type_encoding() -> CString {
    let types = format!(
        "{}{}{}{}{}{}{}{}",
        Encoding::Void,
        <*mut AnyObject as Encode>::ENCODING,
        Encoding::Sel,
        <*mut AnyObject as Encode>::ENCODING,
        <*mut AnyObject as Encode>::ENCODING,
        <*mut AnyObject as Encode>::ENCODING,
        <Bool as Encode>::ENCODING,
        Encoding::Block,
    );
    CString::new(types).expect("objc type encodings contain no interior nul")
}

extern "C-unwind" fn request_display_capture_permission(
    _this: *mut AnyObject,
    _cmd: Sel,
    _webview: *mut AnyObject,
    _origin: *mut AnyObject,
    _frame: *mut AnyObject,
    _with_system_audio: Bool,
    decision_handler: *mut Block<dyn Fn(isize)>,
) {
    // WebKit always passes a handler; dropping the call without invoking it
    // would hang the JS promise forever, so treat a null as "nothing to do".
    if decision_handler.is_null() {
        return;
    }
    unsafe { (*decision_handler).call((DECISION_SCREEN_PROMPT,)) };
}

/// Patch the webview UI delegate class so `getDisplayMedia()` resolves.
///
/// Called once during setup. The delegate class is shared by every wry
/// webview in the process, so patching it from the main window also covers
/// the V2-P7 AI dialog window created later.
pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[display-capture] no main window; getDisplayMedia stays denied");
        return;
    };
    if let Err(err) = window.with_webview(|webview| {
        let wk = webview.inner() as *mut AnyObject;
        if wk.is_null() {
            eprintln!("[display-capture] null WKWebView; getDisplayMedia stays denied");
            return;
        }
        unsafe { patch_ui_delegate(wk) };
    }) {
        eprintln!("[display-capture] with_webview failed: {err}");
    }
}

/// # Safety
///
/// `webview` must be a live `WKWebView`.
unsafe fn patch_ui_delegate(webview: *mut AnyObject) {
    let delegate: *mut AnyObject = unsafe { msg_send![webview, UIDelegate] };
    if delegate.is_null() {
        eprintln!("[display-capture] webview has no UIDelegate; getDisplayMedia stays denied");
        return;
    }
    let class: &AnyClass = unsafe { (*delegate).class() };
    let selector = sel!(_webView:requestDisplayCapturePermissionForOrigin:initiatedByFrame:withSystemAudio:decisionHandler:);
    // Already answered — either a newer wry implements it, or install() ran
    // twice. class_addMethod would no-op anyway; returning keeps the log quiet.
    if class.instance_method(selector).is_some() {
        return;
    }
    let imp: Imp = unsafe {
        std::mem::transmute::<
            extern "C-unwind" fn(
                *mut AnyObject,
                Sel,
                *mut AnyObject,
                *mut AnyObject,
                *mut AnyObject,
                Bool,
                *mut Block<dyn Fn(isize)>,
            ),
            Imp,
        >(request_display_capture_permission)
    };
    let types = method_type_encoding();
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            imp,
            types.as_ptr(),
        )
    };
    if !added.as_bool() {
        eprintln!("[display-capture] class_addMethod failed; getDisplayMedia stays denied");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The shipped macOS target. Pinning the expected string here is what turns
    // an objc2 ABI change into a red test rather than a stack smash inside
    // WebKit; Intel dev machines encode BOOL as `c` and are left alone.
    #[cfg(target_arch = "aarch64")]
    #[test]
    fn method_type_encoding_is_the_arm64_signature() {
        assert_eq!("v@:@@@B@?", method_type_encoding().to_str().unwrap());
    }

    // The selector spelling is the whole fix: WebKit only consults a delegate
    // that responds to this exact name (an earlier upstream attempt shipped
    // `ForSecurityOrigin` and silently did nothing).
    #[test]
    fn selector_matches_wkuidelegateprivate() {
        let selector = sel!(_webView:requestDisplayCapturePermissionForOrigin:initiatedByFrame:withSystemAudio:decisionHandler:);
        assert_eq!(
            selector.name(),
            c"_webView:requestDisplayCapturePermissionForOrigin:initiatedByFrame:withSystemAudio:decisionHandler:"
        );
    }
}
