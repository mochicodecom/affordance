// Copyright © 2026 Mochicode LLC — mochicode.com

import { MantineProvider } from '@mantine/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import IntroPage from './intro-page'
import '@mantine/core/styles.css'

// Two pages, one bundle: the console at `/`, the newcomer intro at
// `/intro` (the server answers both routes with this same index.html).
const Page = window.location.pathname === '/intro' ? IntroPage : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Dark mode follows the OS, no toggle. */}
    <MantineProvider defaultColorScheme="auto">
      <Page />
    </MantineProvider>
  </StrictMode>,
)
