import { Button } from '@/components/ui/Button'

function App() {
  return (
    <main className="dark bg-background text-foreground flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        <h1 className="text-4xl font-semibold tracking-tight">StudyVis</h1>
        <Button>Get started</Button>
      </div>
    </main>
  )
}

export default App
