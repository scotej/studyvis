// Tell the worker which immutable assets this already-loaded tab still needs.
// Controller changes deliberately do not reload a live companion session.
export function registerMirrorOffline(): void {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return
  const container = navigator.serviceWorker
  const reportBuild = (worker: ServiceWorker | null) => {
    const cache = document.querySelector<HTMLMetaElement>(
      'meta[name="studyvis-mirror-build"]'
    )?.content
    if (cache) worker?.postMessage({ type: 'studyvis-mirror-build', cache })
  }
  container.addEventListener('controllerchange', () =>
    reportBuild(container.controller)
  )
  container.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'studyvis-mirror-build-request')
      reportBuild(event.source as ServiceWorker | null)
  })
  reportBuild(container.controller)
  void container
    .register('/mirror-sw.js', { updateViaCache: 'none' })
    .then(() => reportBuild(container.controller))
    .catch(() => {
      // Trusted HTTPS is required for offline caching; the live UI still works.
    })
}
