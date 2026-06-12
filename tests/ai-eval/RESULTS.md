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
