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
const fs = require('fs')
const { execSync } = require('child_process')

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

        // Check substring in BOTH directions
        const isSubstring = windowText.includes(blockNormalized) || blockNormalized.includes(windowText)

        let score = isSubstring ? 1.0 : similarity

        // Special handling for short blocks: word-bag matching
        if (blockNormalized.length < 60 && score < 0.75) {
          const blockWords = blockNormalized.split(' ').filter(w => w.length >= 3)
          const windowWords = windowText.split(' ').filter(w => w.length >= 3)

          const allWordsPresent = blockWords.length > 0
            && blockWords.every(w => windowWords.some(ww => ww.includes(w) || w.includes(ww)))

          // SAFEGUARD: Prevent false positives - window max 2x block length
          const lengthRatio = windowText.length / blockNormalized.length
          const acceptableLength = lengthRatio <= 2.0

          if (allWordsPresent && acceptableLength) {
            score = 0.85
          }
        }

        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            windowSize,
            startLineIdx: startIdx,
            endLineIdx: startIdx + windowSize - 1,
            lines: windowLines,
            score,
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
            pageNumbers: json.page_numbers || [1],
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

function extractRealPDFLines(pdfPath, pageNumbers) {
  console.log(`\n📄 Extracting REAL PDF text using pdfjs-dist...`)
  console.log(`   Pages: [${pageNumbers.join(', ')}]`)

  try {
    if (pageNumbers.length === 1) {
      // Single page extraction
      const outputPath = `/tmp/pdf-lines-p${pageNumbers[0]}.json`
      const cmd = `node scripts/extract-pdf-lines.js --pdf="${pdfPath}" --page=${pageNumbers[0]} --output="${outputPath}" 2>/dev/null`
      execSync(cmd)

      if (!fs.existsSync(outputPath))
        throw new Error(`Failed to extract PDF lines`)

      const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      console.log(`✅ Extracted ${data.lines.length} real PDF lines\n`)

      return data.lines
    }
    else {
      // Multi-page extraction
      const outputPath = `/tmp/pdf-multi-lines-p${pageNumbers.join('-')}.json`
      const cmd = `node scripts/extract-multi-page.js --pdf="${pdfPath}" --pages=${pageNumbers.join(',')} --output="${outputPath}" 2>/dev/null`
      execSync(cmd)

      if (!fs.existsSync(outputPath))
        throw new Error(`Failed to extract multi-page PDF lines`)

      const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      console.log(`✅ Extracted ${data.lines.length} real PDF lines from ${pageNumbers.length} pages\n`)

      return data.lines
    }
  }
  catch (error) {
    console.error(`⚠️  Could not extract real PDF text: ${error.message}`)
    console.log('   Falling back to mock lines\n')

    return []
  }
}

async function testChunk(chunkId) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`🧪 Testing Matching Logic for Chunk ${chunkId}`)
  console.log('='.repeat(70))

  try {
    // Fetch chunk
    const { type, chunkContext, pageNumbers, pageNumber, projectCode, pdfPath } = await fetchChunkData(chunkId)

    if (type !== 'text') {
      console.log(`\n⚠️  Skipping: Chunk type is "${type}" (only text chunks supported)`)
      return
    }

    console.log(`\n📋 Chunk Info:`)
    console.log(`   Project: ${projectCode}`)
    console.log(`   PDF: ${pdfPath}`)
    console.log(`   Pages: [${pageNumbers.join(', ')}]`)
    console.log(`   Length: ${chunkContext.length} chars`)

    // Extract REAL PDF lines from actual PDF (all pages)
    let pdfFileName = pdfPath.split('/').pop()
    // Map long filenames to simplified ones
    if (pdfFileName.includes('IM-0065805')) pdfFileName = 'hospital.pdf'
    const pdfFilePath = `/tmp/test-pdfs/${pdfFileName}`
    const pdfLines = extractRealPDFLines(pdfFilePath, pageNumbers)

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
