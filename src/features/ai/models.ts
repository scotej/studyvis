// Registry of supported vision models per ARCHITECTURE.md §8. Update both
// this file and the doc table together: the manifest below is consulted
// at download time (Content-Length HEAD-check + post-download SHA256
// verification), so a stale entry breaks every install of the affected tier
// until the entry is refreshed.
//
// SHA256s come from the Hugging Face Hub LFS oid (which is the SHA256 of the
// raw bytes). Regenerate via `curl https://huggingface.co/api/models/<repo>/tree/main`.
//
// #47 D3 — downloads resolve against `hfRevision` (a repo commit hash), not
// `main`: the manifest hard-pins sizeBytes + sha256, so an upstream re-upload
// to main would break every new install of that tier with "sha256 mismatch"
// until someone cuts a release. Pinning the revision makes the URL immutable.
// To refresh a tier: take the repo's current commit from
// `curl https://huggingface.co/api/models/<repo>` (.sha) and update
// hfRevision + sizeBytes + sha256 together (verified 2026-07-10 for all four
// tiers: LFS oids at each pinned revision match the sha256 below).

export type ModelTier = 'fastest' | 'balanced' | 'best' | 'heaviest'

export type ModelFileSpec = {
  // Filename inside the HF repo at /resolve/<hfRevision>/.
  filename: string
  // Bytes (matches the HF API tree's lfs.size field).
  sizeBytes: number
  // SHA256 hex (matches HF's LFS oid).
  sha256: string
  // Local filename inside $APP_DATA/studyvis/models/<id>/ (renamed so a
  // future quant swap doesn't strand a confusingly-named file).
  localFilename: 'model.gguf' | 'mmproj.gguf'
}

export type ModelSpec = {
  id: string
  displayName: string
  hfRepo: string
  // Repo commit hash the manifest was verified against; both download URL
  // builders resolve at this revision so an upstream re-upload to main can't
  // invalidate the pinned sizeBytes/sha256 (#47 D3).
  hfRevision: string
  // The literal quant tag (e.g. 'Q4_K_M', 'f16') for display only — the
  // actual filenames are in `model` / `mmproj`.
  quantLabel: string
  modelFile: ModelFileSpec
  mmprojFile: ModelFileSpec
  approxSizeMB: number
  ramRequiredGB: number
  license: string
  // True if the HF repo is gated and a personal access token + accepted
  // terms are required to download.
  gated: boolean
  defaultTier: ModelTier
  // One-sentence positioning copy for the picker card.
  blurb: string
}

const FASTEST: ModelSpec = {
  id: 'moondream2',
  displayName: 'Moondream 2',
  hfRepo: 'ggml-org/moondream2-20250414-GGUF',
  hfRevision: '97d0efa4667189aea70998d0b1ee36a7a3214fcb',
  // moondream2-20250414-GGUF only publishes f16 weights at the time of
  // V2-P2 (2026-05-10). ARCHITECTURE.md §8's earlier "Q4_K_M ~1.5 GB" claim
  // was aspirational; the repo never carried a Q4 quant. The doc was
  // corrected to f16 alongside this file.
  quantLabel: 'f16',
  modelFile: {
    filename: 'moondream2-text-model-f16_ct-vicuna.gguf',
    sizeBytes: 2_839_535_072,
    sha256: '925bcb666baf69ed747e26121af287b16ae7764483be9548b1382f29783689a5',
    localFilename: 'model.gguf',
  },
  mmprojFile: {
    filename: 'moondream2-mmproj-f16-20250414.gguf',
    sizeBytes: 909_777_984,
    sha256: '4cc1cb3660d87ff56432ebeb7884ad35d67c48c7b9f6b2856f305e39c38eed8f',
    localFilename: 'mmproj.gguf',
  },
  approxSizeMB: 3576,
  ramRequiredGB: 6,
  license: 'Apache-2.0',
  gated: false,
  defaultTier: 'fastest',
  blurb:
    'Smallest vision model. Best for older laptops; descriptions are terse.',
}

const BALANCED: ModelSpec = {
  id: 'qwen2_5-vl-3b',
  displayName: 'Qwen 2.5-VL 3B',
  hfRepo: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
  hfRevision: '5037fcf163dd95d1e41d1974465f0898ed108ca2',
  quantLabel: 'Q4_K_M + mmproj-Q8_0',
  modelFile: {
    filename: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 1_929_901_056,
    sha256: 'd02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12',
    localFilename: 'model.gguf',
  },
  mmprojFile: {
    filename: 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
    sizeBytes: 844_757_728,
    sha256: '980c9b2f78c04e6cff93d277ada09e768394f112d75db3b4e9dea8a69f9fb904',
    localFilename: 'mmproj.gguf',
  },
  approxSizeMB: 2645,
  ramRequiredGB: 8,
  license: 'Apache-2.0',
  gated: false,
  defaultTier: 'balanced',
  blurb:
    'Recommended default. Good vision quality with steady cadence on M-series Macs.',
}

const BEST: ModelSpec = {
  id: 'gemma3-4b',
  displayName: 'Gemma 3 4B',
  hfRepo: 'ggml-org/gemma-3-4b-it-GGUF',
  hfRevision: 'd0976223747697cb51e056d85c532013931fe52e',
  quantLabel: 'Q4_K_M',
  modelFile: {
    filename: 'gemma-3-4b-it-Q4_K_M.gguf',
    sizeBytes: 2_489_757_856,
    sha256: '882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863',
    localFilename: 'model.gguf',
  },
  mmprojFile: {
    filename: 'mmproj-model-f16.gguf',
    sizeBytes: 851_251_104,
    sha256: '8c0fb064b019a6972856aaae2c7e4792858af3ca4561be2dbf649123ba6c40cb',
    localFilename: 'mmproj.gguf',
  },
  approxSizeMB: 3187,
  ramRequiredGB: 10,
  license: 'Gemma terms (accept on Hugging Face)',
  gated: true,
  defaultTier: 'best',
  blurb:
    'Highest-quality 4B vision model. Requires accepting Gemma terms on Hugging Face and pasting your access token.',
}

const HEAVIEST: ModelSpec = {
  id: 'qwen2_5-vl-7b',
  displayName: 'Qwen 2.5-VL 7B',
  hfRepo: 'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF',
  hfRevision: '508edd0afaa66bb9e9f40587acc2184f02daf1f6',
  quantLabel: 'Q4_K_M + mmproj-Q8_0',
  modelFile: {
    filename: 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf',
    sizeBytes: 4_683_072_032,
    sha256: '9258bf05b12686d097ff3b6b18d968ab393649780aa2b3cd67fec43d50554392',
    localFilename: 'model.gguf',
  },
  mmprojFile: {
    filename: 'mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf',
    sizeBytes: 853_119_712,
    sha256: '2ddb555391bae966e412deab9e07b58afa18bcc06930ba0f1c78a3695ab9e506',
    localFilename: 'mmproj.gguf',
  },
  approxSizeMB: 5283,
  ramRequiredGB: 16,
  license: 'Apache-2.0',
  gated: false,
  defaultTier: 'heaviest',
  blurb:
    'Strongest vision quality, but slow on consumer CPUs. Pick this only if you have ≥16 GB free RAM and aren’t on battery.',
}

export const SUPPORTED_MODELS: ReadonlyArray<ModelSpec> = [
  FASTEST,
  BALANCED,
  BEST,
  HEAVIEST,
]

export function getModel(id: string): ModelSpec | undefined {
  return SUPPORTED_MODELS.find((m) => m.id === id)
}

export function tierLabel(tier: ModelTier): string {
  switch (tier) {
    case 'fastest':
      return 'Fastest'
    case 'balanced':
      return 'Balanced'
    case 'best':
      return 'Best'
    case 'heaviest':
      return 'Heaviest'
  }
}

export function huggingfaceResolveUrl(
  repo: string,
  filename: string,
  revision = 'main'
): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${filename}`
}

export function modelDownloadUrls(spec: ModelSpec): {
  model: string
  mmproj: string
} {
  return {
    model: huggingfaceResolveUrl(
      spec.hfRepo,
      spec.modelFile.filename,
      spec.hfRevision
    ),
    mmproj: huggingfaceResolveUrl(
      spec.hfRepo,
      spec.mmprojFile.filename,
      spec.hfRevision
    ),
  }
}

export function totalDownloadBytes(spec: ModelSpec): number {
  return spec.modelFile.sizeBytes + spec.mmprojFile.sizeBytes
}
