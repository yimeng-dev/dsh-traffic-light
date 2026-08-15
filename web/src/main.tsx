import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { DesktopApp } from './DesktopApp'
import './desktop.css'
import './styles.css'

const surface = new URLSearchParams(window.location.search).get('surface')
const isDesktop = surface === 'desktop'
if (isDesktop) document.documentElement.dataset.surface = 'desktop'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isDesktop ? <DesktopApp /> : <App />}
  </React.StrictMode>,
)
