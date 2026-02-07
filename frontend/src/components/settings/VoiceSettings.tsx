import { TTSSettings } from './TTSSettings'
import { STTSettings } from './STTSettings'

export function VoiceSettings() {
  return (
    <div className="space-y-6">
      <TTSSettings />
      <STTSettings />
    </div>
  )
}
