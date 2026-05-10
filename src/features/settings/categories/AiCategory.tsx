import { ModelPickerContainer } from '@/features/ai'

// V2-P2 lands the model picker + benchmark inside Settings → AI.
// V2-P9 adds the master "Enable AI features" toggle here above the picker.
export function AiCategory() {
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight text-text-primary">
          AI
        </h2>
        <p className="text-sm text-text-secondary">
          The vision model runs on this machine and judges only your camera and
          screen. Pick a model below and StudyVis will benchmark it once to
          figure out how often it can sample.
        </p>
      </header>
      <ModelPickerContainer />
    </section>
  )
}
