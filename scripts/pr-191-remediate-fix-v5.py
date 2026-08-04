from pathlib import Path

for temporary in [
    Path('.github/workflows/pr-191-remediation-reopen-v5.yml'),
    Path('scripts/pr-191-remediate-fix-v5.py'),
]:
    temporary.unlink(missing_ok=True)
