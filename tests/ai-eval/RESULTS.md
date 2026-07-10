# Eval results

Append a new "Run N" block here every time the system prompt changes.
Keep prior runs in place so blame shows the prompt's evolution. See
`README.md` for workflow.

Each block records:

- Prompt version (`FOCUS_SYSTEM_PROMPT_VERSION` from
  `src/features/ai/systemPrompt.ts`).
- Model id (registry id from `src/features/ai/models.ts`).
- Dataset count (entries actually run; subtract skips).
- False-positive rate (target < 5 % per PLAN §5).
- False-negative rate.
- Confusion matrix. Includes an `uncertain` predicted column (A2): a parse
  failure now yields an UNCERTAIN skip, not a fabricated `on_task`. Uncertain
  predictions are excluded from BOTH the FP and FN rates — an unparseable
  response is neither a false alarm nor a missed distraction, just a dropped
  sample — so the rates stay honest.
- Optional notes on what changed in the prompt this iteration.

V2 ships when **both** Gemma 3 4B and Qwen 2.5-VL-3B clear the FP < 5 %
bar on a 100-item dataset.

---

## Run 0 — harness landed, no data yet

- **Prompt version**: 1
- **Status**: harness scaffolded; starter 20-entry dataset committed
  without fixtures. Real runs land once fixtures are curated and the
  user invokes the harness against a live sidecar.

The first numbered run starts when an operator has:

1. Populated `dataset/fixtures/case-001-*.jpg` … `case-020-*.jpg` (and any
   custom entries beyond the starter 20).
2. Started the sidecar in-app with the target model.
3. Run `npx tsx tests/ai-eval/run.ts --port <p> --model <id>`.

Paste the harness's report block below this paragraph, prefixed with
`## Run 1 — <model id> — <YYYY-MM-DD>`, and keep this Run 0 block on top.

---

## Run 0.5 — harness hardened, dataset widened; fixtures still owed (2026-07-10, #47 D1)

- **Prompt version**: 2 (the I11 topic-injection hardening bumped it WITHOUT
  a recorded run — flagged here so the debt is visible; the README's
  "re-run before merging" rule applies from the first fixtured run onward).
- **Status**: no model run yet — `dataset/fixtures/` still holds only
  `.gitkeep`. Fixture capture is deliberately human-gated: fixtures must be
  real webcam frames + screenshots encoded with the production constants
  (see README), and synthetic images would skew the eval toward the
  generator, not toward what StudyVis actually sends.
- **What landed instead** (#47 D1 b/c):
  - `evalCore.ts` extraction + `tests/unit/ai-eval-core.test.ts` (12 tests:
    confusion-matrix math incl. the A2 uncertain-exclusion rules, dataset
    validation, fixture-path traversal guard, CLI parsing).
  - Cases 021–028: multi-monitor composite strips (the `snapshotAllScreens`
    format no prior case covered), non-STEM topics, on-topic video lectures.
- **Next (human-gated)**: capture fixtures for the 28 cases, run
  qwen2_5-vl-3b + gemma3-4b via `npm run` / `tsx tests/ai-eval/run.ts`,
  append Run 1 here. Every other AI change (prompt, catalog — see #47 D4)
  stays blind until that run exists.

---

## Catalog-refresh prep — Qwen3-VL generation, verified and ready, gated on Run 1 (2026-07-10, #47 D4)

#47 D4 proposes refreshing the four-tier catalog (`src/features/ai/models.ts`,
verified 2026-05-10) to the Qwen3-VL generation and **gates the swap on eval
data (D1)**. Fixtures don't exist yet (see Run 0.5 above), so the swap is not
shipped; everything mechanical was verified today so it lands as a
copy-paste manifest change the moment Run 1 clears it.

**Verified live on this machine (2026-07-10):**

- The bundled b9095 `llama-server-aarch64-apple-darwin` loads
  Qwen3-VL-2B-Instruct Q4_K_M + its Q8_0 mmproj (`general.architecture =
qwen3vl`), offloads to Metal, and answers a real vision query correctly
  (64×64 red test image → "red"). The pinned sidecar needs **no rebuild**.
- Both HF repos are ungated; manifest data fetched from the HF API and
  size/oid-verified at the revisions below.

**Ready-to-apply manifest (update `hfRevision` + files together, D3 style):**

- Fastest-tier replacement (vs Moondream2 f16's ~3.7 GB pair — this is
  ~1.55 GB, ~41% of the download, with newer-generation vision quality):
  - repo `Qwen/Qwen3-VL-2B-Instruct-GGUF`
    @ `52d6c8ffea26cc873ac5ad116f8631268d7eb503`
  - `Qwen3VL-2B-Instruct-Q4_K_M.gguf` — 1,107,409,952 B —
    sha256 `089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae`
  - `mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf` — 445,053,216 B —
    sha256 `f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82`
- Candidate 7B-tier replacement (reportedly outbenchmarks Qwen2.5-VL-7B at
  roughly half the size):
  - repo `Qwen/Qwen3-VL-4B-Instruct-GGUF`
    @ `1cd86afb9a95c410a6038ab3b40d8b578c892266`
  - `Qwen3VL-4B-Instruct-Q4_K_M.gguf` — 2,497,281,664 B —
    sha256 `66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a`
  - `mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf` — 453,974,304 B —
    sha256 `30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d`

**Swap checklist (once Run 1 exists and includes these models):** new
ModelSpec ids (keep `moondream2` / `qwen2_5-vl-7b` valid — install state is
per-id, so installed models keep working), ARCHITECTURE §8 table in
lockstep, re-benchmark note in the release CHANGELOG.
