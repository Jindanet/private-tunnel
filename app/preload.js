const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig:     ()       => ipcRenderer.invoke('get-config'),
  saveServerUrl: (url)    => ipcRenderer.invoke('save-server-url', url),
  saveToken:     (token)  => ipcRenderer.invoke('save-token', token),
  addTunnel:     (data)   => ipcRenderer.invoke('add-tunnel', data),
  deleteTunnel:  (id)     => ipcRenderer.invoke('delete-tunnel', id),
  startTunnel:   (id)     => ipcRenderer.invoke('start-tunnel', id),
  stopTunnel:    (id)     => ipcRenderer.invoke('stop-tunnel', id),
  openExternal:  (url)    => ipcRenderer.invoke('open-external', url),
  copyText:      (text)   => ipcRenderer.invoke('copy-text', text),

  onTunnelStatus:  (cb) => ipcRenderer.on('tunnel-status',  (_, d) => cb(d)),
  onTunnelRequest: (cb) => ipcRenderer.on('tunnel-request', (_, d) => cb(d)),
});
