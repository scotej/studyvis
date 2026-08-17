// Curated MQTT-over-WSS brokers for trystero room rendezvous.
//
// @trystero-p2p/mqtt otherwise takes the first four entries from its bundled
// list. That makes the package's first entry (test.mosquitto.org) a shipped
// dependency even when it is unavailable. Passing relayConfig.urls makes
// trystero use this entire list instead, and also lets the release health check
// exercise the exact endpoints installs will use.
//
// Every entry below passed a public-access subscribe -> publish -> receive
// round-trip on 2026-08-13. Shiftr uses its documented shared `public:public`
// credential; this is not a private StudyVis secret. broker.hivemq.com:8884 is
// deliberately omitted: repeated secure-WebSocket probes timed out, so its
// general public-broker availability is not enough evidence that trystero's
// browser transport works.
export const DEFAULT_MQTT_BROKER_URLS: string[] = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://public:public@public.cloud.shiftr.io',
  'wss://broker-cn.emqx.io:8084/mqtt',
]
