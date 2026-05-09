import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'

const isDev = import.meta.env.DEV

export function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-base text-text-primary">
      <div className="flex flex-col items-center gap-6">
        <Logo size="xl" />
        <h1 className="text-2xl font-semibold tracking-tight">StudyVis</h1>
        <Button>Get started</Button>
        {isDev ? (
          <Link to="/style" className="text-sm text-text-secondary underline">
            /style
          </Link>
        ) : null}
      </div>
    </main>
  )
}
