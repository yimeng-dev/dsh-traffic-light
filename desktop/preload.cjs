const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshTrafficLight', {
  onSnapshot(listener) {
    const handler = (_event, message) => { listener(message) }
    ipcRenderer.on('traffic-light:snapshot', handler)
    ipcRenderer.send('traffic-light:ready')
    return () => { ipcRenderer.removeListener('traffic-light:snapshot', handler) }
  },
  closeSession(sessionId) {
    ipcRenderer.send('traffic-light:close-session', sessionId)
  },
  quit() {
    ipcRenderer.send('traffic-light:quit')
  },
})
