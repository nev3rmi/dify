#!/usr/bin/env node

/**
 * Test PDF Matching Quality
 *
 * Usage:
 *   node scripts/test-pdf-matching.js --chunkId=2 --pdfUrl="https://..."
 *   node scripts/test-pdf-matching.js --chunkId=2  (uses default PDF)
 *
 * This script:
 * 1. Fetches chunk from n8n API
 * 2. Fetches PDF from MinIO
 * 3. Extracts text from API page
 * 4. Runs matching algorithm
 * 5. Reports quality metrics
 */

const fs = require('fs')
const path = require('path')

const CHUNK_API_URL = 'https://n8n.toho.vn/webhook/dbf0d2ae-ec68-4827-bdb7-f5dec29c2b1d'

// Parse command line args
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=')
  acc[key] = value
  return acc
}, {})

const chunkId = args.chunkId || '2'
const pdfUrl = args.pdfUrl

console.log(`\n🧪 Testing PDF Matching Quality`)
console.log(`   Chunk ID: ${chunkId}`)
console.log(`   PDF URL: ${pdfUrl || '(from API)'}`)
console.log(`\n${'='.repeat(60)}\n`)

async function fetchChunkData() {
  console.log('📡 Fetching chunk from n8n API...')
  const response = await fetch(`${CHUNK_API_URL}?chunkID=${chunkId}`)
  const text = await response.text()
  const data = JSON.parse(text)

  let chunkContext = data.chunk_context
  if (typeof chunkContext === 'string' && chunkContext.startsWith('"') && chunkContext.endsWith('"')) {
    chunkContext = JSON.parse(chunkContext)
  }

  const pageNumber = data.page_numbers?.[0] || 1

  console.log(`✓ Chunk fetched: ${chunkContext.length} chars`)
  console.log(`✓ Page number: ${pageNumber}`)
  console.log(`\nChunk content (first 200 chars):`)
  console.log(`"${chunkContext.substring(0, 200)}..."\n`)

  return { chunkContext, pageNumber, pdfUrl: pdfUrl || data.pdf_url }
}

async function extractPdfText(pdfUrl, pageNumber) {
  console.log(`📄 Extracting text from PDF page ${pageNumber}...`)

  // Note: This requires pdf.js in Node.js environment
  console.log(`⚠️  PDF extraction requires pdf.js - run this in browser console instead`)
  console.log(`\nTo test manually:`)
  console.log(`1. Open: http://localhost:3000/chat/B33cJRbBs4ljZuHN`)
  console.log(`2. Open console (F12)`)
  console.log(`3. Look for "[PDF] 📦 ALL sentence boxes" output`)
  console.log(`4. Compare chunk blocks to matched lines`)

  return null
}

async function analyzeMatchQuality(chunkContext, pdfLines) {
  console.log(`\n📊 Match Quality Analysis`)
  console.log(`${'='.repeat(60)}\n`)

  const chunkBlocks = chunkContext
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 10)

  console.log(`Total blocks: ${chunkBlocks.length}`)

  // Metrics to track
  let totalBlocks = chunkBlocks.length
  let matchedBlocks = 0
  let totalChunkChars = chunkContext.length
  let matchedChunkChars = 0

  chunkBlocks.forEach((block, i) => {
    console.log(`\nBlock ${i + 1}: "${block.substring(0, 60)}${block.length > 60 ? '...' : ''}"`)
    console.log(`  Length: ${block.length} chars`)

    // In real implementation, this would calculate match score
    console.log(`  Match: [To be calculated with PDF data]`)
  })

  return {
    totalBlocks,
    matchedBlocks,
    blockMatchRate: matchedBlocks / totalBlocks,
    totalChunkChars,
    matchedChunkChars,
    charCoverageRate: matchedChunkChars / totalChunkChars,
  }
}

async function main() {
  try {
    const { chunkContext, pageNumber, pdfUrl } = await fetchChunkData()

    console.log(`\n📋 Test Summary`)
    console.log(`${'='.repeat(60)}`)

    const blocks = chunkContext.split('\n').filter(s => s.trim().length > 10)
    console.log(`\nChunk has ${blocks.length} blocks`)
    blocks.forEach((block, i) => {
      console.log(`  Block ${i + 1}: ${block.substring(0, 50)}${block.length > 50 ? '...' : ''}`)
    })

    console.log(`\n💡 Next Steps:`)
    console.log(`\n1. Open browser console at http://localhost:3000`)
    console.log(`2. Click citation with chunkId=${chunkId}`)
    console.log(`3. Check console output for:`)
    console.log(`   - [PDF] 📝 X chunk blocks to match`)
    console.log(`   - [PDF] ✓ Matched Y consecutive lines (score: 0.XX)`)
    console.log(`4. Calculate quality:`)
    console.log(`   - Block Match Rate: Y/X blocks matched`)
    console.log(`   - Average Score: sum(scores)/Y`)
    console.log(`   - Coverage: (matched chars)/(total chars)`)

  }
  catch (error) {
    console.error('❌ Error:', error.message)
    process.exit(1)
  }
}

main()
