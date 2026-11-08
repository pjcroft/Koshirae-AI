import './api' // must run first: installs window.api before App reads it
import { createRoot } from 'react-dom/client'
import { App as CapApp } from '@capacitor/app'
import App from '../src/renderer/App'
import '../src/renderer/styles.css'
import './mobile.css'

function Shell() {
  return (
    <>
      <button
        className="drawer-btn"
        aria-label="Menu"
        onClick={() => document.body.classList.toggle('drawer')}
      >
        ☰
      </button>
      <div className="scrim" onClick={() => document.body.classList.remove('drawer')} />
      <App />
    </>
  )
}

// Close the drawer after picking a chat / starting one / opening settings.
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement
  if (t.closest('.side .conv, .side .btn, .side .usage-line') && !t.closest('.x')) {
    document.body.classList.remove('drawer')
  }
})

// Android back: close the drawer or a modal first, then leave the app.
void CapApp.addListener('backButton', () => {
  if (document.body.classList.contains('drawer')) return void document.body.classList.remove('drawer')
  const back = document.querySelector<HTMLElement>('.modal-back')
  if (back) return back.click()
  void CapApp.minimizeApp()
})

createRoot(document.getElementById('root')!).render(<Shell />)
