import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.pjcroft.koshirae',
  appName: 'Koshirae AI',
  webDir: 'mobile/www',
  backgroundColor: '#0b1220',
  // 'http' scheme so calls to http:// endpoints (Ollama / LM Studio over
  // Tailscale or LAN) are not blocked as mixed content.
  server: { androidScheme: 'http', cleartext: true }
}
export default config
