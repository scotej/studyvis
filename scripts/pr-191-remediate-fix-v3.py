from pathlib import Path

path = Path('src/features/session/SessionView.tsx')
text = path.read_text()
old = """  useEffect(() => {
    if (openSessionImageId !== null && openSessionImage === null) {
      setOpenSessionImageId(null)
    }
  }, [openSessionImageId, openSessionImage])
"""
if text.count(old) != 1:
    raise SystemExit(f'Expected one stale-image cleanup effect, found {text.count(old)}')
path.write_text(text.replace(old, ''))

for temporary in [
    Path('.github/workflows/pr-191-remediation-reopen-v3.yml'),
    Path('scripts/pr-191-remediate-fix-v3.py'),
]:
    temporary.unlink(missing_ok=True)
