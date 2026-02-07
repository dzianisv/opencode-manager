#!/usr/bin/env bun

import { writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {ENV} from '../backend/src/config'


const __dirname = dirname(fileURLToPath(import.meta.url))

const API_URL = process.env.VITE_API_URL || 'http://localhost:8001'
const OPENCODE_URL = API_URL + '/api/opencode'

async function generateOpenAPISpec() {
  console.log(`📥 Fetching OpenAPI spec from ${OPENCODE_URL}/doc`)
  
  try {
    const response = await fetch(`${OPENCODE_URL }/doc`, {
      headers: {
        'Accept': 'application/json'
      }
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const spec = await response.json()
    const outputPath = join(__dirname, '../frontend/src/api/opencode-spec.json')
    
    await writeFile(outputPath, JSON.stringify(spec, null, 2))
    console.log(`✅ OpenAPI spec saved to ${outputPath}`)
    
    return outputPath
  } catch (error) {
    console.error('❌ Failed to fetch OpenAPI spec:', error)
    console.error('\n💡 Make sure an OpenCode server is running.')
    console.error('   You can start one by opening a repo in the WebUI.')
    process.exit(1)
  }
}

async function generateTypeScript(specPath: string) {
  console.log('\n📝 Generating TypeScript types...')
  
  const outputPath = join(__dirname, '../frontend/src/api/opencode-types.ts')
  const { spawnSync } = await import('child_process')
  
  try {
    const result = spawnSync('npx', ['openapi-typescript', specPath, '-o', outputPath], {
      cwd: join(__dirname, '..'),
      stdio: 'inherit'
    })
    
    if (result.status !== 0) {
      throw new Error(`openapi-typescript exited with code ${result.status}`)
    }
    
    console.log(`✅ TypeScript types generated at ${outputPath}`)
  } catch (error) {
    console.error('❌ Failed to generate TypeScript types:', error)
    process.exit(1)
  }
}

async function main() {
  console.log('🚀 Generating OpenCode API types...\n')
  
  const specPath = await generateOpenAPISpec()
  await generateTypeScript(specPath)
  
  console.log('\n✨ Done!')
}

main()
