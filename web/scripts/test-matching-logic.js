#!/usr/bin/env node

/**
 * Pure Matching Logic Test
 *
 * Tests the matching algorithm WITHOUT browser/PDF rendering
 * Just: chunk text + PDF lines → match results
 *
 * Usage:
 *   node scripts/test-matching-logic.js --chunkId=2
 */

const https = require('https')

const CHUNK_API_URL = 'https://n8n.toho.vn/webhook/dbf0d2ae-ec68-4827-bdb7-f5dec29c2b1d'

// Parse CLI args
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=')
  acc[key] = value
  return acc
}, {})

const chunkId = args.chunkId || '2'

// ============ MATCHING LOGIC (copied from component) ============

function normalizeWithSpaces(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function levenshteinDistance(str1, str2) {
  const len1 = str1.length
  const len2 = str2.length
  const matrix = []

  for (let i = 0; i <= len1; i++)
    matrix[i] = [i]

  for (let j = 0; j <= len2; j++)
    matrix[0][j] = j

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost, // substitution
      )
    }
  }

  return matrix[len1][len2]
}

function calculateLevenshteinSimilarity(str1, str2) {
  const distance = levenshteinDistance(str1, str2)
  const maxLength = Math.max(str1.length, str2.length)
  return maxLength === 0 ? 1 : 1 - distance / maxLength
}

function matchChunkToLines(chunkContext, pdfLines) {
  // Split chunk into blocks
  const chunkBlocks = chunkContext
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 10)

  const results = []

  // Match each chunk block using sliding window
  for (let i = 0; i < chunkBlocks.length; i++) {
    const block = chunkBlocks[i]
    const blockNormalized = normalizeWithSpaces(block)

    let bestMatch = null

    // Try windows of 1-5 consecutive PDF lines
    for (let windowSize = 1; windowSize <= Math.min(5, pdfLines.length); windowSize++) {
      for (let startIdx = 0; startIdx <= pdfLines.length - windowSize; startIdx++) {
        const windowLines = pdfLines.slice(startIdx, startIdx + windowSize)
        const windowText = normalizeWithSpaces(windowLines.join(' '))

        // Calculate similarity
        const similarity = calculateLevenshteinSimilarity(blockNormalized, windowText)

        // Check exact substring
        const isSubstring = windowText.includes(blockNormalized) || blockNormalized.includes(windowText)

        // Score: prefer exact match
        const score = isSubstring ? 1.0 : similarity

        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            windowSize,
            startLineIdx: startIdx,
            endLineIdx: startIdx + windowSize - 1,
            lines: windowLines,
            score,
            isSubstring,
          }
        }
      }
    }

    const threshold = 0.75
    const matched = bestMatch && bestMatch.score >= threshold

    results.push({
      blockIndex: i,
      blockText: block,
      blockLength: block.length,
      matched,
      score: bestMatch?.score || 0,
      matchedLines: matched ? bestMatch.lines : [],
      lineIndices: matched ? `${bestMatch.startLineIdx}-${bestMatch.endLineIdx}` : 'none',
    })
  }

  return results
}

// ============ TEST EXECUTION ============

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
            type: json.type,
            chunkContext,
            pageNumber: json.page_numbers?.[0] || 1,
            projectCode: json.project_code,
            pdfPath: json.metadata?.direct_link,
          })
        }
        catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

function mockPDFLines(chunkContext) {
  // For now, create mock PDF lines from the chunk itself
  // In real test, you'd extract these from actual PDF
  console.log('\n⚠️  Using MOCK PDF lines (chunk text split by sentences)')
  console.log('   For real test, need to extract actual PDF text\n')

  const sentences = chunkContext
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  return sentences
}

async function testChunk(chunkId) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`🧪 Testing Matching Logic for Chunk ${chunkId}`)
  console.log('='.repeat(70))

  try {
    // Fetch chunk
    const { type, chunkContext, pageNumber, projectCode, pdfPath } = await fetchChunkData(chunkId)

    if (type !== 'text') {
      console.log(`\n⚠️  Skipping: Chunk type is "${type}" (only text chunks supported)`)
      return
    }

    console.log(`\n📋 Chunk Info:`)
    console.log(`   Project: ${projectCode}`)
    console.log(`   PDF: ${pdfPath}`)
    console.log(`   Page: ${pageNumber}`)
    console.log(`   Length: ${chunkContext.length} chars`)

    // Mock PDF lines (in real test, extract from actual PDF)
    const pdfLines = mockPDFLines(chunkContext)

    console.log(`\n📄 PDF Lines: ${pdfLines.length}`)
    pdfLines.forEach((line, i) => {
      console.log(`   ${i + 1}. ${line.substring(0, 60)}${line.length > 60 ? '...' : ''}`)
    })

    // Run matching
    console.log(`\n🔍 Running matching algorithm...\n`)
    const results = matchChunkToLines(chunkContext, pdfLines)

    // Display results
    results.forEach(r => {
      const status = r.matched ? '✓' : '✗'
      console.log(`${status} Block ${r.blockIndex + 1}: ${r.blockText.substring(0, 50)}...`)
      console.log(`   Score: ${r.score.toFixed(3)} | Lines: ${r.lineIndices} | Matched: ${r.matched}`)
      if (r.matched) {
        console.log(`   Window: ${r.matchedLines.length} lines`)
      }
    })

    // Calculate metrics
    const totalBlocks = results.length
    const matchedBlocks = results.filter(r => r.matched).length
    const matchRate = totalBlocks > 0 ? matchedBlocks / totalBlocks : 0
    const avgScore = results.length > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / results.length
      : 0

    const matchedBlocksText = results
      .filter(r => r.matched)
      .map(r => r.blockText)
      .join(' ')
    const coverage = chunkContext.length > 0
      ? matchedBlocksText.length / chunkContext.length
      : 0

    console.log(`\n${'='.repeat(70)}`)
    console.log('📊 QUALITY METRICS')
    console.log('='.repeat(70))
    console.log(`Block Match Rate:  ${matchedBlocks}/${totalBlocks} (${(matchRate * 100).toFixed(1)}%)`)
    console.log(`Average Score:     ${avgScore.toFixed(3)}`)
    console.log(`Coverage:          ${(coverage * 100).toFixed(1)}%`)
    console.log('='.repeat(70))

    // Pass/Fail
    const pass = matchRate >= 0.8 && avgScore >= 0.85 && coverage >= 0.75
    console.log(`\n${pass ? '✅ PASS' : '❌ FAIL'}`)

    if (!pass) {
      console.log('\nFailure reasons:')
      if (matchRate < 0.8) console.log(`  - Match rate too low: ${(matchRate * 100).toFixed(1)}% < 80%`)
      if (avgScore < 0.85) console.log(`  - Average score too low: ${avgScore.toFixed(3)} < 0.85`)
      if (coverage < 0.75) console.log(`  - Coverage too low: ${(coverage * 100).toFixed(1)}% < 75%`)
    }

    console.log('')
  }
  catch (error) {
    console.error(`❌ Error:`, error.message)
  }
}

// Run test
testChunk(chunkId)
