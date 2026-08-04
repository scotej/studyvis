from pathlib import Path

path = Path('tests/unit/session-images.test.ts')
text = path.read_text()
old = """  test('rejects forged dimensions and excessive decoded resources', async () => {
    const { payload } = await fixture()
    const forged = payload.bytes.slice()
    forged[19] = 2
    expect(inspectImageBytes(forged, 'image/png')).toBeNull()

    const huge = payload.bytes.slice()
"""
new = """  test('rejects forged dimensions and excessive decoded resources', async () => {
    const { signer, payload } = await fixture()
    const forged = payload.bytes.slice()
    forged[19] = 2
    expect(inspectImageBytes(forged, 'image/png')).toEqual({
      width: 2,
      height: 1,
      frameCount: 1,
    })
    expect(
      verifyIncomingImage(
        forged,
        payload.metadata,
        signer.edHex,
        TOPIC
      )
    ).toBeNull()

    const huge = payload.bytes.slice()
"""
if text.count(old) != 1:
    raise SystemExit(f'Expected one security test assertion, found {text.count(old)}')
path.write_text(text.replace(old, new))

for temporary in [
    Path('.github/workflows/pr-191-remediation-reopen-v4.yml'),
    Path('scripts/pr-191-remediate-fix-v4.py'),
]:
    temporary.unlink(missing_ok=True)
