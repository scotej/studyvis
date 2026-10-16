#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$script_dir/.."

if [[ ${1:-} == --powershell && $# == 1 ]]; then
  powershell_source=$(cat <<'POWERSHELL'
try {
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module PSScriptAnalyzer -RequiredVersion 1.25.0 -ErrorAction Stop
$files = @(git ls-files --cached --others --exclude-standard -- '*.ps1')
if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { throw 'Could not enumerate PowerShell source files.' }
$failures = 0
foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $pwd $file), [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -ne 0) { $parseErrors | Format-List | Out-Host; $failures += $parseErrors.Count }
    $diagnostics = @(Invoke-ScriptAnalyzer -Path $file -Severity Error)
    if ($diagnostics.Count -ne 0) { $diagnostics | Format-Table -AutoSize | Out-Host; $failures += $diagnostics.Count }
}
if ($failures -ne 0) { throw "PowerShell correctness checks found $failures issue(s)." }
Write-Host "PowerShell syntax and correctness verified ($($files.Count) files)."
} catch {
    [Console]::Error.WriteLine($_)
    exit 1
}
POWERSHELL
  )
  pwsh -NoLogo -NoProfile -NonInteractive -Command "$powershell_source"
  exit
fi
if [[ $# != 0 ]]; then
  echo 'usage: bash scripts/check-scripts.sh [--powershell]' >&2
  exit 2
fi

shell_files=()
python_files=()
javascript_files=()
while IFS= read -r -d '' filename; do
  case "$filename" in
    *.sh) shell_files+=("$filename") ;;
    *.py) python_files+=("$filename") ;;
    *.mjs) javascript_files+=("$filename") ;;
  esac
done < <(git ls-files -z --cached --others --exclude-standard -- '*.sh' '*.py' '*.mjs')

for filename in "${shell_files[@]}"; do bash -n -- "$filename"; done
shellcheck --external-sources --severity=warning -- "${shell_files[@]}"
ruff check --isolated --no-cache --select E9,F -- "${python_files[@]}"
for filename in "${javascript_files[@]}"; do node --check "$filename"; done

# Use the already locked ESLint packages. No npx download or additional npm
# dependency is needed for standalone Node files that also author browser code.
node --input-type=module - "${javascript_files[@]}" <<'JAVASCRIPT'
import { ESLint } from 'eslint'
import js from '@eslint/js'
import globals from 'globals'

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [{
    ...js.configs.recommended,
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  }],
})
const results = await eslint.lintFiles(process.argv.slice(2))
const formatter = await eslint.loadFormatter('stylish')
const output = formatter.format(results)
if (output) process.stdout.write(output)
if (results.some((result) => result.errorCount > 0)) process.exitCode = 1
JAVASCRIPT

echo "Standalone correctness checks passed (${#shell_files[@]} shell, ${#python_files[@]} Python, ${#javascript_files[@]} JavaScript files)."
