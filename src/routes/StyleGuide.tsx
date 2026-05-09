import { useState } from 'react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Toaster } from '@/components/ui/sonner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Logo } from '@/components/Logo'
import { useTheme } from '@/design/theme-context'
import { toast } from 'sonner'

function StatusDot({
  tone,
  label,
}: {
  tone: 'focused' | 'warning' | 'alerted' | 'offline' | 'online'
  label: string
}) {
  const cls = {
    focused: 'bg-status-focused',
    warning: 'bg-status-warning',
    alerted: 'bg-status-alerted',
    offline: 'bg-status-offline',
    online: 'bg-status-online',
  }[tone]
  return (
    <div className="flex items-center gap-2 text-sm text-text-secondary">
      <span className={`inline-block size-2.5 rounded-full ${cls}`} />
      {label}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="flex flex-col gap-4 rounded-lg border border-border-default bg-bg-surface p-6">
        {children}
      </div>
    </section>
  )
}

export function StyleGuide() {
  const { mode, setMode } = useTheme()
  const [progress] = useState(60)

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-bg-base text-text-primary">
        <div className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
          <header className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Logo size="md" />
              <h1 className="text-xl font-semibold tracking-tight">
                /style — design tokens preview
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-secondary">theme</span>
              <Button
                size="sm"
                variant={mode === 'dark' ? 'default' : 'outline'}
                onClick={() => setMode('dark')}
              >
                dark
              </Button>
              <Button
                size="sm"
                variant={mode === 'light' ? 'default' : 'outline'}
                onClick={() => setMode('light')}
              >
                light
              </Button>
              <Button
                size="sm"
                variant={mode === 'auto' ? 'default' : 'outline'}
                onClick={() => setMode('auto')}
              >
                auto
              </Button>
            </div>
          </header>

          <Section title="Buttons — variants">
            <div className="flex flex-wrap gap-3">
              <Button>Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="link">Link</Button>
            </div>
            <Separator />
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">Large</Button>
              <Button size="icon" aria-label="icon">
                ✦
              </Button>
            </div>
          </Section>

          <Section title="Inputs — states">
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="d1">Default</Label>
                <Input id="d1" placeholder="placeholder" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="d2">Disabled</Label>
                <Input id="d2" disabled placeholder="disabled" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="d3">Error</Label>
                <Input id="d3" aria-invalid placeholder="error state" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="d4">Textarea</Label>
                <Textarea id="d4" placeholder="Multi-line input" />
              </div>
            </div>
          </Section>

          <Section title="Badges">
            <div className="flex flex-wrap gap-3">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="ghost">Ghost</Badge>
              <Badge variant="link">Link</Badge>
            </div>
          </Section>

          <Section title="Status dots">
            <div className="flex flex-wrap gap-6">
              <StatusDot tone="focused" label="focused" />
              <StatusDot tone="warning" label="warning" />
              <StatusDot tone="alerted" label="alerted" />
              <StatusDot tone="offline" label="offline" />
              <StatusDot tone="online" label="online" />
            </div>
          </Section>

          <Section title="Avatars">
            <div className="flex items-end gap-6">
              <Avatar size="sm">
                <AvatarFallback>SA</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>AL</AvatarFallback>
              </Avatar>
              <Avatar size="lg">
                <AvatarFallback>BO</AvatarFallback>
              </Avatar>
            </div>
          </Section>

          <Section title="Card example">
            <Card className="max-w-md">
              <CardHeader>
                <CardTitle>Studying with Alice</CardTitle>
                <CardDescription>
                  Free-form session, no timer. 3 friends online.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  Body content sits in the surface variant. The card itself
                  uses radius lg, the page uses radius md.
                </p>
              </CardContent>
              <CardFooter className="gap-2">
                <Button size="sm">Invite</Button>
                <Button size="sm" variant="ghost">
                  Cancel
                </Button>
              </CardFooter>
            </Card>
          </Section>

          <Section title="Toast triggers">
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={() => toast.success('Saved to disk.')}
              >
                Success
              </Button>
              <Button
                variant="outline"
                onClick={() => toast.error("Couldn't reach Alice.")}
              >
                Error
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  toast('Bo has joined the session.', {
                    description: 'Free-form mode.',
                  })
                }
              >
                Default
              </Button>
            </div>
          </Section>

          <Section title="Other primitives">
            <div className="grid grid-cols-2 gap-6">
              <div className="flex flex-col gap-3">
                <Label>Switch</Label>
                <Switch defaultChecked />
              </div>
              <div className="flex flex-col gap-3">
                <Label>Slider</Label>
                <Slider defaultValue={[40]} max={100} step={1} />
              </div>
              <div className="flex flex-col gap-3">
                <Label>Progress</Label>
                <Progress value={progress} />
              </div>
              <div className="flex flex-col gap-3">
                <Label>Kbd</Label>
                <div className="flex items-center gap-1.5">
                  <Kbd>⌘</Kbd>
                  <Kbd>[</Kbd>
                  <span className="text-sm text-text-secondary">
                    push to talk
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <Label>Tooltip</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="outline">
                      Hover me
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Tooltip content</TooltipContent>
                </Tooltip>
              </div>
              <div className="flex flex-col gap-3">
                <Label>Dialog</Label>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline">
                      Open dialog
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add a friend</DialogTitle>
                      <DialogDescription>
                        Paste their 12-word pairing code.
                      </DialogDescription>
                    </DialogHeader>
                    <Input placeholder="ocean ladder cinnamon …" />
                    <DialogFooter showCloseButton />
                  </DialogContent>
                </Dialog>
              </div>
            </div>

            <Separator />

            <Tabs defaultValue="a" className="w-full">
              <TabsList>
                <TabsTrigger value="a">Tab one</TabsTrigger>
                <TabsTrigger value="b">Tab two</TabsTrigger>
                <TabsTrigger value="c">Tab three</TabsTrigger>
              </TabsList>
              <TabsContent
                value="a"
                className="rounded-md border border-border-default p-4 text-sm text-text-secondary"
              >
                First panel content.
              </TabsContent>
              <TabsContent
                value="b"
                className="rounded-md border border-border-default p-4 text-sm text-text-secondary"
              >
                Second panel.
              </TabsContent>
              <TabsContent
                value="c"
                className="rounded-md border border-border-default p-4 text-sm text-text-secondary"
              >
                Third panel.
              </TabsContent>
            </Tabs>
          </Section>

          <Section title="Logo sizes">
            <div className="flex items-end gap-6">
              <Logo size="sm" />
              <Logo size="md" />
              <Logo size="lg" />
              <Logo size="xl" />
              <Logo size="xl" monochrome className="text-text-primary" />
            </div>
          </Section>
        </div>
        <Toaster position="bottom-right" />
      </main>
    </TooltipProvider>
  )
}
