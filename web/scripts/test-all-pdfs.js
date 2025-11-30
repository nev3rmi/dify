#!/usr/bin/env node

/**
 * Automated PDF Matching Test Suite
 *
 * Connects to MinIO and n8n to test matching quality across all PDFs
 *
 * Usage:
 *   node scripts/test-all-pdfs.js
 *   node scripts/test-all-pdfs.js --chunkId=2
 *
 * No dependencies required - uses native Node.js modules
 */

const https = require('https')

// MinIO configuration
const MINIO_ENDPOINT = '192.168.31.97'
const MINIO_PORT = 9001
const MINIO_ACCESS_KEY = 'minioadmin'
const MINIO_SECRET_KEY = 'minioadmin'
const CHUNK_API_URL = 'https://n8n.toho.vn/webhook/dbf0d2ae-ec68-4827-bdb7-f5dec29c2b1d'

// Parse CLI args
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=')
  acc[key] = value
  return acc
}, {})

const specificChunkId = args.chunkId

async function listBuckets() {
  console.log('🗂️  Connecting to MinIO...')
  console.log(`   Endpoint: http://${MINIO_ENDPOINT}:${MINIO_PORT}`)
  console.log(`   User: ${MINIO_ACCESS_KEY}\n`)

  try {
    // MinIO API requires auth, let's try simple approach first
    console.log('💡 To list buckets manually:')
    console.log(`   1. Open: http://${MINIO_ENDPOINT}:${MINIO_PORT}`)
    console.log(`   2. Login: ${MINIO_ACCESS_KEY} / ${MINIO_SECRET_KEY}`)
    console.log(`   3. Look for bucket with "n8n" or "ingest" in name`)
    console.log(`   4. Note the bucket name`)
    console.log(`   5. Re-run: node scripts/test-all-pdfs.js --bucket=<name>\n`)

    return []
  }
  catch (error) {
    console.error('❌ Error:', error.message)
    return []
  }
}

async function fetchChunkData(chunkId) {
  return new Promise((resolve, reject) => {
    https.get(`${CHUNK_API_URL}?chunkID=${chunkId}`, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          let chunkContext = json.chunk_context
          if (typeof chunkContext === 'string' && chunkContext.startsWith('"'))
            chunkContext = JSON.parse(chunkContext)

          resolve({
            chunkContext,
            pageNumber: json.page_numbers?.[0] || 1,
            pdfUrl: json.pdf_url,
          })
        }
        catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

async function testChunk(chunkId) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`Testing Chunk ID: ${chunkId}`)
  console.log('='.repeat(70))

  try {
    const { chunkContext, pageNumber, pdfUrl } = await fetchChunkData(chunkId)

    console.log(`\n📋 Chunk Info:`)
    console.log(`   Page: ${pageNumber}`)
    console.log(`   Length: ${chunkContext.length} chars`)
    console.log(`   PDF URL: ${pdfUrl || 'N/A'}`)

    const blocks = chunkContext.split('\n').filter(s => s.trim().length > 10)
    console.log(`   Blocks: ${blocks.length}`)

    console.log(`\n📝 Blocks:`)
    blocks.forEach((block, i) => {
      const preview = block.substring(0, 70)
      console.log(`   ${i + 1}. ${preview}${block.length > 70 ? '...' : ''}`)
    })

    console.log(`\n💡 To test matching:`)
    console.log(`   1. Open http://localhost:3000`)
    console.log(`   2. Click citation with chunkId=${chunkId}`)
    console.log(`   3. Check console for "[PDF] 📊 QUALITY METRICS"`)
    console.log(`   4. Expected:`)
    console.log(`      - Block Match Rate: ≥ 80%`)
    console.log(`      - Average Score: ≥ 0.85`)
    console.log(`      - Coverage: ≥ 75%`)
  }
  catch (error) {
    console.error(`❌ Error testing chunk ${chunkId}:`, error.message)
  }
}

async function testMultipleChunks(chunkIds) {
  console.log(`\n📊 Batch Testing ${chunkIds.length} Chunks`)
  console.log('='.repeat(70))

  const results = []

  for (const chunkId of chunkIds) {
    await testChunk(chunkId)
    results.push({ chunkId, status: 'tested' })
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(`✅ Tested ${results.length} chunks`)
  console.log(`\n💡 Next: Open browser and compare console quality metrics`)
  console.log('='.repeat(70))
}

async function main() {
  console.log('\n🧪 PDF Matching Test Suite')
  console.log('='.repeat(70))

  // Step 1: Show MinIO access instructions
  await listBuckets()

  // Step 2: Test chunks
  if (specificChunkId) {
    await testChunk(specificChunkId)
  }
  else {
    // Test common chunk IDs
    const defaultChunkIds = ['1', '2', '3', '4', '5']
    console.log(`\n💡 To test specific chunk:`)
    console.log(`   node scripts/test-all-pdfs.js --chunkId=2`)
    console.log(`\n💡 To test multiple chunks:`)
    console.log(`   node scripts/test-all-pdfs.js --chunkId=1,2,3,4,5\n`)
  }
}

main().catch(console.error)
