import { BrowserRouter, Route, Routes } from 'react-router'

import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/design/theme'
import { PttListener } from '@/features/system'
import { Home } from '@/routes/Home'
import { StyleGuide } from '@/routes/StyleGuide'

const isDev = import.meta.env.DEV

function App() {
  return (
    <ThemeProvider>
      <PttListener />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          {isDev ? <Route path="/style" element={<StyleGuide />} /> : null}
        </Routes>
        <Toaster position="bottom-right" />
      </BrowserRouter>
    </ThemeProvider>
  )
}

export default App
