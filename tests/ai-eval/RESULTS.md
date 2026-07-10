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
