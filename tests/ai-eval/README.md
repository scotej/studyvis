# `tests/ai-eval/` — focus-detection evaluation harness

This harness measures how well the focus-detection system prompt
(`src/features/ai/systemPrompt.ts`) classifies hand-curated study scenarios
when sent to a local llama-server.

Source of truth for the V2 acceptance bar: PLAN.md §5 V2 success criteria —
**false-positive rate < 5 %** across the 100-item dataset on Gemma 3 4B and
Qwen 2.5-VL-3B.

## Iteration discipline

**If you change the system prompt, re-run the eval set and commit the new
results before merging.** RESULTS.md is the durable record of where the
prompt currently lands on each supported model. A change to
`systemPrompt.ts` without a refreshed RESULTS.md is a regression risk:
neighbouring scenarios may have shifted in ways the change-author didn't
intend.

Workflow:

1. Edit `src/features/ai/systemPrompt.ts`. Bump `FOCUS_SYSTEM_PROMPT_VERSION`.
2. Run the harness against every model PLAN §5 names (Gemma 3 4B and
   Qwen 2.5-VL-3B, plus any optional tier you've added fixtures for).
3. Append a new block to `RESULTS.md` — keep the prior runs above it so the
   prompt's history is visible in git blame.
4. Commit the prompt change, the new RESULTS.md block, and (if applicable)
   any dataset additions together.

## Dataset shape

Each scenario is a single JSON file under `dataset/` named `case-NNN-*.json`.
The filename stem must equal the `id` field. Fixtures live in
`dataset/fixtures/` and are referenced by relative path:

```json
{
  "id": "case-001-on-task-typescript",
  "declared_topic": "Implementing a binary search tree in TypeScript",
  "face_path": "fixtures/case-001-face.jpg",
  "screen_path": "fixtures/case-001-screen.jpg",
  "expected_severity": "on_task",
  "scenario": "User facing screen; VS Code shows BST implementation in TS.",
  "notes": "Obvious on-task; baseline coding scenario."
}
```

Required keys: `id`, `declared_topic`, `face_path`, `screen_path`,
`expected_severity` (one of `on_task | mild | moderate | blatant`),
`scenario`. Optional: `notes`.

### Fixture format

Fixtures must match the format the sample loop will send in production
(`src/features/ai/captureFace.ts` + `captureScreen.ts`):

- **face**: 384×384 JPEG, quality 0.8 (`FACE_FRAME_SIZE` /
  `FACE_FRAME_QUALITY`).
- **screen**: ≤ 1024 px wide JPEG, quality 0.7, aspect preserved
  (`SCREEN_FRAME_MAX_WIDTH` / `SCREEN_FRAME_QUALITY`).
- **multi-monitor cases** (`case-021`/`case-022`): the screen fixture must be
  a V3-P4 composite strip — every display side by side in ONE wide JPEG,
  downscaled to ≤ `COMPOSITE_MAX_WIDTH` (see `src/features/ai/composite.ts` /
  `snapshotAllScreens` in `sampleLoop.ts`). Capture with the app's
  Settings → AI → "capture all displays" mode rather than stitching by hand.

Mismatched formats won't crash the harness, but they will skew the eval
result toward what the model thinks of _your_ compression — not what it
thinks of what StudyVis actually sends. Curate by taking real screenshots
and webcam frames, then resize/encode with the same constants.

## Starter set

28 scenario definitions ship with this directory (the original 20 + the
#47 D1(b) buckets: multi-monitor composite strips, non-STEM topics, and
on-topic video lectures — cases 021–028); **fixtures are not committed**.
You populate them as you curate the set toward the 100 PLAN §5 calls for.
Replace `fixtures/.gitkeep` with the real JPEGs (keep them out of git LFS —
text-document repo). A balanced 100 item set looks roughly like:

| Bucket                                                       | Count | What it tests                                                     |
| ------------------------------------------------------------ | ----- | ----------------------------------------------------------------- |
| `on_task` (coding, papers, math, design, terminal, IDE)      | 40    | Baseline: the model must _not_ alert when the user is working.    |
| `mild` (glancing away, neutral browsing, brief email)        | 20    | Threshold sensitivity — these should rarely escalate to moderate. |
| `moderate` (social media, off-topic video, news)             | 20    | Off-task content that's not entertainment.                        |
| `blatant` (games, TikTok, twitch, anime streaming)           | 12    | Active entertainment — the model should flag confidently.         |
| Manipulation patterns ("ignore prior instructions" overlays) | 8     | Per ARCHITECTURE.md §8 must map to `moderate`.                    |

The starter 20 sample this distribution at ~⅕ scale. Cases 021–028 add the
buckets the original set missed entirely: multi-monitor composite strips (the
`snapshotAllScreens` wire format), non-STEM subjects (language drilling, law,
music theory), and on-topic video (a fullscreen lecture must not be
reflexively flagged) — grow these proportionally on the way to 100.

## Harness tests

The pure logic (CLI parsing, dataset validation, the fixture-path traversal
guard, and the confusion-matrix / FP–FN math) lives in `evalCore.ts` and is
locked by `tests/unit/ai-eval-core.test.ts` in the normal vitest run — the
harness can't silently rot while fixture capture catches up. `run.ts` is the
orchestration shell (sidecar HTTP + report printing).

## Running

The harness expects a running llama-server. Spin it up via StudyVis:
enable AI features in Settings → AI, select a model, let the picker finish
loading. The port appears in `useSidecarStore` (visible in app logs); the
sidecar stays alive while AI features are enabled.

Then:

```sh
npx tsx tests/ai-eval/run.ts --port 8765 --model qwen2_5-vl-3b
```

Flags:

- `--port <p>` — required; the sidecar's HTTP port.
- `--model <id>` — required; a registry id from `src/features/ai/models.ts`
  (`moondream2`, `qwen2_5-vl-3b`, `gemma3-4b`, `qwen2_5-vl-7b`).
- `--dataset <dir>` — optional; defaults to `tests/ai-eval/dataset`.
- `--timeout <sec>` — optional; per-request timeout. Default 300.

Output is a per-case PASS/FAIL line followed by:

- the confusion matrix (rows = expected, cols = predicted),
- the false-positive rate (against the V2 < 5 % target),
- the false-negative rate (off-task scenarios the model called `on_task`),
- any skipped entries (missing fixtures or request errors),
- parse failure snippets (when `parseJudgment` couldn't extract JSON).

Copy the report block into `RESULTS.md` under a new "Run N" heading.

## Non-goals

The harness does **not**:

- start or stop the sidecar (live in the app),
- download models (live in the model picker),
- compare runs automatically (RESULTS.md is the durable record; humans
  compare),
- write a JUnit/JSON file (we keep this a single-command stdout tool;
  CI integration is out of V2 scope).
