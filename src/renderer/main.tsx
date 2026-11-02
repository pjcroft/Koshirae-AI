import { createRoot } from 'react-dom/client'
import type { Api } from '@shared/types'
import App from './App'
import './styles.css'

declare global {
  interface Window {
    api: Api
  }
}
createRoot(document.getElementById('root')!).render(<App />)
