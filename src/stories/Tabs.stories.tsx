import type { Meta, StoryObj } from '@storybook/react-vite'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const meta = {
  title: 'UI/Tabs',
  component: Tabs,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="a" className="w-72">
      <TabsList>
        <TabsTrigger value="a">One</TabsTrigger>
        <TabsTrigger value="b">Two</TabsTrigger>
        <TabsTrigger value="c">Three</TabsTrigger>
      </TabsList>
      <TabsContent
        value="a"
        className="rounded-md border border-border-default p-4 text-sm text-text-secondary"
      >
        First panel.
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
  ),
}

export const Line: Story = {
  render: () => (
    <Tabs defaultValue="a" className="w-72">
      <TabsList variant="line">
        <TabsTrigger value="a">One</TabsTrigger>
        <TabsTrigger value="b">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="a" className="p-4 text-sm text-text-secondary">
        First panel.
      </TabsContent>
      <TabsContent value="b" className="p-4 text-sm text-text-secondary">
        Second panel.
      </TabsContent>
    </Tabs>
  ),
}
