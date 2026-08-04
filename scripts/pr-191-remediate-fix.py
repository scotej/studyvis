from pathlib import Path

images = Path('src/features/session/images.ts')
text = images.read_text()
old = '  let offset = PNG_SIGNATURE.length'
new = '  let offset: number = PNG_SIGNATURE.length'
if text.count(old) != 1:
    raise SystemExit(f'Expected one PNG offset declaration, found {text.count(old)}')
images.write_text(text.replace(old, new))

story = Path('src/stories/SessionImageViewer.stories.tsx')
text = story.read_text()
old = "import { tokens } from '@/design/tokens'\n"
if text.count(old) != 1:
    raise SystemExit(f'Expected one unused tokens import, found {text.count(old)}')
story.write_text(text.replace(old, ''))

for temporary in [
    Path('.github/workflows/pr-191-remediation-reopen-v2.yml'),
    Path('scripts/pr-191-remediate-fix.py'),
]:
    temporary.unlink(missing_ok=True)
