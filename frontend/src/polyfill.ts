import { Buffer } from 'buffer'

console.log('Polyfilling Buffer...')
if (typeof window !== 'undefined') {
  window.Buffer = window.Buffer || Buffer
  console.log('Buffer polyfilled:', !!window.Buffer)
}
