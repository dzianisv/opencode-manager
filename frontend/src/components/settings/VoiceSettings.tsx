import { TTSSettings } from './TTSSettings'
import { STTSettings } from './STTSettings'
import { TalkModeSettings } from './TalkModeSettings'

export function VoiceSettings() {
  return (
    <div className="flex flex-col gap-6">
      <TTSSettings />
      <STTSettings />
      <TalkModeSettings />
    </div>
  )
}
