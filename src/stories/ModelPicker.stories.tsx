import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Toaster } from '@/components/ui/sonner'
import {
  ModelPicker,
  ModelGuide,
  emptyPickerState,
  INFERENCE_ENGINE_FINGERPRINT,
  SUPPORTED_MODELS,
  type PickerStateForModel,
  type ModelRecord,
} from '@/features/ai'

function makeRecord(p95Sec: number, p50Sec = p95Sec * 0.85): ModelRecord {
  const samplesSec = [p50Sec, p50Sec * 1.05, p95Sec]
  return {
    modelId: 'mock',
    benchmark: {
      samplesSec,
      p50Sec,
      p95Sec,
      sampleIntervalSec: Math.max(5, Math.ceil(p95Sec + 1)),
      completedAtSec: Math.floor(Date.now() / 1000),
      engineFingerprint: INFERENCE_ENGINE_FINGERPRINT,
    },
    installedAt: Date.now(),
  }
}

type StoryArgs = {
  installed: Record<string, ModelRecord | null>
  hfTokenPresent: boolean
  pickerOverrides?: Record<string, Partial<PickerStateForModel>>
  actionsLocked?: boolean
}

function Harness({
  installed,
  hfTokenPresent,
  pickerOverrides,
  actionsLocked,
}: StoryArgs) {
  const [hfPresent, setHfPresent] = useState(hfTokenPresent)
  const baseline = emptyPickerState()
  const perModel: Record<string, PickerStateForModel> = Object.fromEntries(
    SUPPORTED_MODELS.map((spec) => {
      const installState =
        installed[spec.id] != null
          ? { modelExists: true, mmprojExists: true }
          : { modelExists: false, mmprojExists: false }
      return [
        spec.id,
        {
          ...baseline[spec.id],
          installState,
          record: installed[spec.id] ?? null,
          ...(pickerOverrides?.[spec.id] ?? {}),
        } satisfies PickerStateForModel,
      ]
    })
  )
  const records = Object.fromEntries(
    Object.entries(installed)
      .filter((entry): entry is [string, ModelRecord] => entry[1] != null)
      .map(([id, record]) => [id, record])
  )
  return (
    <div className="mx-auto max-w-4xl bg-bg-base p-6 text-text-primary">
      <ModelPicker
        perModel={perModel}
        hfTokenPresent={hfPresent}
        actionsLocked={actionsLocked}
        guide={<ModelGuide records={records} />}
        actions={{
          onSelect: () => undefined,
          onRebenchmark: () => undefined,
          onCancel: () => undefined,
          onRemove: () => undefined,
          onSaveHfToken: () => setHfPresent(true),
          onClearHfToken: () => setHfPresent(false),
        }}
      />
      <Toaster position="bottom-right" />
    </div>
  )
}

const meta = {
  title: 'Features/ModelPicker',
  component: Harness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>

export default meta
type Story = StoryObj<typeof meta>

// ── Variants ──────────────────────────────────────────────────────────

export const NothingInstalled: Story = {
  args: {
    installed: {},
    hfTokenPresent: false,
  },
}

export const OneInstalled: Story = {
  args: {
    installed: {
      'qwen2_5-vl-3b': {
        ...makeRecord(8.4, 7.1),
        modelId: 'qwen2_5-vl-3b',
      },
    },
    hfTokenPresent: false,
  },
}

export const AllInstalledWithSpeeds: Story = {
  args: {
    installed: {
      moondream2: { ...makeRecord(3.2, 2.7), modelId: 'moondream2' },
      'qwen2_5-vl-3b': {
        ...makeRecord(8.4, 7.1),
        modelId: 'qwen2_5-vl-3b',
      },
      'gemma3-4b': { ...makeRecord(12.8, 11.2), modelId: 'gemma3-4b' },
      'qwen2_5-vl-7b': {
        ...makeRecord(24.6, 21.3),
        modelId: 'qwen2_5-vl-7b',
      },
    },
    hfTokenPresent: true,
  },
}

// A benchmark persisted before the current engine (no/other fingerprint —
// e.g. CPU-era numbers after the Metal-offload update) renders with the
// re-measure hint instead of presenting the speed as current.
export const StaleBenchmark: Story = {
  args: {
    installed: {
      'qwen2_5-vl-3b': {
        ...makeRecord(26.0, 22.5),
        modelId: 'qwen2_5-vl-3b',
        benchmark: {
          ...makeRecord(26.0, 22.5).benchmark!,
          engineFingerprint: undefined,
        },
      },
    },
    hfTokenPresent: false,
  },
}

// #47 B2 made Settings reachable mid-session; the picker's mutating actions
// are locked while a session is live so a re-benchmark can't stomp the live
// sample loop's sidecar.
export const LockedDuringSession: Story = {
  args: {
    installed: {
      'qwen2_5-vl-3b': {
        ...makeRecord(8.4, 7.1),
        modelId: 'qwen2_5-vl-3b',
      },
    },
    hfTokenPresent: false,
    actionsLocked: true,
  },
}

export const DownloadingMidway: Story = {
  args: {
    installed: {},
    hfTokenPresent: false,
    pickerOverrides: {
      'qwen2_5-vl-3b': {
        phase: 'downloading-model',
        downloadProgress: 0.42,
      },
    },
  },
}

export const Benchmarking: Story = {
  args: {
    installed: {
      'gemma3-4b': { ...makeRecord(12.0), modelId: 'gemma3-4b' },
    },
    hfTokenPresent: true,
    pickerOverrides: {
      moondream2: {
        installState: { modelExists: true, mmprojExists: true },
        phase: 'benchmark-running',
        benchmarkSampleIndex: 2,
        benchmarkSampleTotal: 3,
      },
    },
  },
}

export const PartiallyInstalled: Story = {
  args: {
    installed: {},
    hfTokenPresent: false,
    pickerOverrides: {
      moondream2: {
        installState: { modelExists: true, mmprojExists: false },
        phase: 'idle',
      },
    },
  },
}

export const GatedNeedsToken: Story = {
  args: {
    installed: {},
    hfTokenPresent: false,
  },
  // Gemma's card auto-shows the token paste field when not installed and
  // no token is present; the user can paste a value to flip the in-story
  // state.
}

export const FailedDownload: Story = {
  args: {
    installed: {},
    hfTokenPresent: false,
    pickerOverrides: {
      'qwen2_5-vl-7b': {
        phase: 'failed',
        errorMessage:
          'Server reported 4683072100 bytes for model but the manifest expects 4683072032. The model manifest may be stale.',
      },
    },
  },
}

// A4 — an interrupted download with a known partial on disk: the primary
// action reads "Resume download" (backend Range-resumes the `.tmp`) and a
// note shows how much already landed.
export const ResumableDownload: Story = {
  args: {
    installed: {},
    hfTokenPresent: false,
    pickerOverrides: {
      'qwen2_5-vl-3b': {
        phase: 'idle',
        record: {
          modelId: 'qwen2_5-vl-3b',
          benchmark: null,
          installedAt: null,
          interruptedDownload: {
            bytesReceived: 2_900_000_000,
            at: Date.now(),
          },
        },
      },
    },
  },
}

// The guide expanded: collapsed <details> content is skipped by axe-core,
// so this story keeps the comparison-table markup inside the a11y gate.
export const GuideExpanded: Story = {
  args: {
    installed: {},
    hfTokenPresent: false,
  },
  render: () => (
    <div className="mx-auto max-w-4xl bg-bg-base p-6 text-text-primary">
      <ModelGuide records={{}} defaultOpen />
    </div>
  ),
}
