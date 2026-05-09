import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const meta = {
  title: 'UI/Card',
  component: Card,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>Studying with Alice</CardTitle>
        <CardDescription>Free-form session, no timer.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-text-secondary">
          Body content sits in the surface variant.
        </p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm">Invite</Button>
        <Button size="sm" variant="ghost">
          Cancel
        </Button>
      </CardFooter>
    </Card>
  ),
}
