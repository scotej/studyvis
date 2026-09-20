#!/usr/bin/env python3
"""Exercise media using the caller's isolated AppImage libraries and plugins."""

import ctypes
import pathlib
import sys


class GError(ctypes.Structure):
    _fields_ = [
        ("domain", ctypes.c_uint),
        ("code", ctypes.c_int),
        ("message", ctypes.c_char_p),
    ]


libdir = pathlib.Path(sys.argv[1]).resolve(strict=True)
gst = ctypes.CDLL(str(libdir / "libgstreamer-1.0.so.0"))
app = ctypes.CDLL(str(libdir / "libgstapp-1.0.so.0"))
glib = ctypes.CDLL(str(libdir / "libglib-2.0.so.0"))
gobject = ctypes.CDLL(str(libdir / "libgobject-2.0.so.0"))
nss = ctypes.CDLL(str(libdir / "libnss3.so"))
nss.NSS_NoDB_Init.argtypes = [ctypes.c_char_p]
nss.NSS_NoDB_Init.restype = ctypes.c_int
nss.NSS_Shutdown.argtypes = []
nss.NSS_Shutdown.restype = ctypes.c_int

# Noble's libsrtp opens NSS's soft-token/freebl modules lazily. DT_NEEDED and
# element discovery both pass when those modules are absent (#312).
if nss.NSS_NoDB_Init(None) != 0:
    sys.exit("packaged NSS cannot load its encrypted-media modules")
if nss.NSS_Shutdown() != 0:
    sys.exit("packaged NSS initialization did not shut down cleanly")

gst.gst_init.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
gst.gst_version.argtypes = [ctypes.POINTER(ctypes.c_uint)] * 4
gst.gst_parse_launch.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.POINTER(GError))]
gst.gst_parse_launch.restype = ctypes.c_void_p
gst.gst_bin_get_by_name.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
gst.gst_bin_get_by_name.restype = ctypes.c_void_p
gst.gst_element_set_state.argtypes = [ctypes.c_void_p, ctypes.c_int]
gst.gst_element_set_state.restype = ctypes.c_int
gst.gst_object_unref.argtypes = [ctypes.c_void_p]
gst.gst_sample_unref.argtypes = [ctypes.c_void_p]
gst.gst_sample_get_buffer.argtypes = [ctypes.c_void_p]
gst.gst_sample_get_buffer.restype = ctypes.c_void_p
gst.gst_buffer_get_size.argtypes = [ctypes.c_void_p]
gst.gst_buffer_get_size.restype = ctypes.c_size_t
gst.gst_buffer_extract.argtypes = [
    ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t
]
gst.gst_buffer_extract.restype = ctypes.c_size_t
gst.gst_element_factory_make.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
gst.gst_element_factory_make.restype = ctypes.c_void_p
gst.gst_caps_from_string.argtypes = [ctypes.c_char_p]
gst.gst_caps_from_string.restype = ctypes.c_void_p
gst.gst_caps_unref.argtypes = [ctypes.c_void_p]
gst.gst_element_get_pad_template.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
gst.gst_element_get_pad_template.restype = ctypes.c_void_p
gst.gst_element_request_pad.argtypes = [
    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p
]
gst.gst_element_request_pad.restype = ctypes.c_void_p
gst.gst_element_release_request_pad.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
gobject.g_signal_emit_by_name.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
gobject.g_object_get.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
app.gst_app_sink_try_pull_sample.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
app.gst_app_sink_try_pull_sample.restype = ctypes.c_void_p
glib.g_error_free.argtypes = [ctypes.POINTER(GError)]

gst.gst_init(None, None)
if len(sys.argv) > 2:
    version = [ctypes.c_uint() for _ in range(4)]
    gst.gst_version(*(ctypes.byref(part) for part in version))
    actual_version = ".".join(str(part.value) for part in version[:3])
    if actual_version != sys.argv[2] or version[3].value != 0:
        sys.exit(f"packaged GStreamer version mismatch: {actual_version}")


def decode(label, description, expected_pixels=None):
    error = ctypes.POINTER(GError)()
    pipeline = gst.gst_parse_launch(description.encode(), ctypes.byref(error))
    sink = None
    try:
        if error:
            raise RuntimeError(error.contents.message.decode())
        if not pipeline:
            raise RuntimeError("GStreamer returned no pipeline")
        sink = gst.gst_bin_get_by_name(pipeline, b"decoded")
        if not sink or gst.gst_element_set_state(pipeline, 4) == 0:
            raise RuntimeError("could not start the decode pipeline")
        # Pull decoded buffers, not just EOS: an empty but loadable pipeline
        # cannot prove that WebRTC's codec chain produces media (#312).
        for _ in range(3):
            sample = app.gst_app_sink_try_pull_sample(sink, 5_000_000_000)
            if not sample:
                raise RuntimeError("no decoded sample within five seconds")
            try:
                buffer = gst.gst_sample_get_buffer(sample)
                if not buffer or gst.gst_buffer_get_size(buffer) == 0:
                    raise RuntimeError("decoded sample has no media payload")
                if expected_pixels is not None:
                    pixels = ctypes.create_string_buffer(len(expected_pixels))
                    count = gst.gst_buffer_extract(buffer, 0, pixels, len(expected_pixels))
                    if count != len(expected_pixels) or pixels.raw != expected_pixels:
                        raise RuntimeError("GPU conversion changed the expected pixels")
            finally:
                gst.gst_sample_unref(sample)
        print(f"Packaged GStreamer {label}: produced three samples")
    finally:
        if pipeline:
            gst.gst_element_set_state(pipeline, 1)
        if sink:
            gst.gst_object_unref(sink)
        if pipeline:
            gst.gst_object_unref(pipeline)
        if error:
            glib.g_error_free(error)


def check_transceiver_reuse():
    connection = gst.gst_element_factory_make(b"webrtcbin", None)
    caps = gst.gst_caps_from_string(
        b"application/x-rtp,media=video,encoding-name=VP8,clock-rate=90000,payload=96"
    )
    expected = ctypes.c_void_p()
    actual = ctypes.c_void_p()
    pad = None
    try:
        if not connection or not caps:
            raise RuntimeError("cannot construct a WebRTC transceiver")
        gobject.g_signal_emit_by_name(
            connection, b"add-transceiver", ctypes.c_int(4),
            ctypes.c_void_p(caps), ctypes.byref(expected)
        )
        template = gst.gst_element_get_pad_template(connection, b"sink_%u")
        if not expected or not template:
            raise RuntimeError("cannot create the sending transceiver")
        pad = gst.gst_element_request_pad(connection, template, None, caps)
        if not pad:
            raise RuntimeError("cannot request a WebRTC sending pad")
        gobject.g_object_get(pad, b"transceiver", ctypes.byref(actual), None)
        # The stock Noble predicate creates an unnegotiated second transceiver
        # even when the existing one supports exactly these caps (#312).
        if actual.value != expected.value:
            raise RuntimeError("outgoing video attached to a different transceiver")
        print("Packaged GStreamer WebRTC: reused the negotiated video transceiver")
    finally:
        if actual:
            gst.gst_object_unref(actual)
        if expected:
            gst.gst_object_unref(expected)
        if pad:
            gst.gst_element_release_request_pad(connection, pad)
            gst.gst_object_unref(pad)
        if caps:
            gst.gst_caps_unref(caps)
        if connection:
            gst.gst_object_unref(connection)


try:
    decode(
        "VP8/RTP",
        "videotestsrc num-buffers=6 pattern=ball ! "
        "video/x-raw,width=320,height=180,framerate=10/1 ! videoconvert ! "
        "vp8enc deadline=1 ! rtpvp8pay ! rtpvp8depay ! vp8dec ! "
        "appsink name=decoded sync=false max-buffers=6",
    )
    decode(
        "Opus/RTP",
        "audiotestsrc num-buffers=12 wave=sine ! "
        "audio/x-raw,rate=48000,channels=1 ! audioconvert ! "
        "opusenc ! rtpopuspay ! rtpopusdepay ! opusdec ! "
        "appsink name=decoded sync=false max-buffers=12",
    )
    decode(
        "SRTP encryption",
        "videotestsrc num-buffers=6 ! "
        "video/x-raw,width=320,height=180,framerate=10/1 ! videoconvert ! "
        "vp8enc deadline=1 ! rtpvp8pay ! "
        "srtpenc key=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d ! "
        "appsink name=decoded sync=false max-buffers=6",
    )
    decode(
        "GL upload/conversion/download",
        "videotestsrc num-buffers=6 pattern=white ! "
        "video/x-raw,format=RGBA,width=16,height=16,framerate=1/1 ! "
        "glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=RGBA ! "
        "gldownload ! video/x-raw,format=RGBA ! "
        "appsink name=decoded sync=false max-buffers=6",
        expected_pixels=bytes([255]) * 1024,
    )
    check_transceiver_reuse()
except RuntimeError as error:
    sys.exit(f"packaged GStreamer media failed: {error}")
