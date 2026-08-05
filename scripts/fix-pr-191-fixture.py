from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"missing fixture anchor in {path}")
    file.write_text(text.replace(old, new, 1))


replace(
    "tests/unit/session-images.test.ts",
    "const VALID_PNG_BYTES = new Uint8Array([\n  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,\n  1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68,\n  65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 5, 131, 2, 127, 150, 31,\n  89, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,\n])",
    "const VALID_PNG_BYTES = new Uint8Array([\n  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,\n  1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68,\n  65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153,\n  61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,\n])",
)
replace(
    "src/stories/SessionImageViewer.stories.tsx",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lh9ZAAAAAElFTkSuQmCC",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
)
