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
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeNoSpaces(text) {
  return text
    .toLowerCase()
    .replace(/[^\w]/g, '') // Remove all non-alphanumeric
}

function wordBagMatch(lineText, blockText) {
  // Filter out common short words
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out'])
  const lineWords = lineText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w))
  const blockWords = blockText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w))

  if (lineWords.length === 0) return 0

  // Count how many line words appear in block
  let matchedWords = 0
  for (const word of lineWords) {
    // Require exact match or very similar length substring (within 1.5x ratio)
    const exactMatch = blockWords.some(bw => bw === word)
    const substringMatch = blockWords.some(bw => {
      const shorter = Math.min(bw.length, word.length)
      const longer = Math.max(bw.length, word.length)
      return shorter >= 5 && longer / shorter <= 1.5 && (bw.includes(word) || word.includes(bw))
    })
    if (exactMatch || substringMatch) matchedWords++
  }

  return matchedWords / lineWords.length
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

  // SEQUENTIAL PARAGRAPH MATCHING: Find ALL lines that belong to each block
  let lastMatchedLineIdx = -1

  for (let blockIdx = 0; blockIdx < chunkBlocks.length; blockIdx++) {
    const block = chunkBlocks[blockIdx]
    const blockNormalized = normalizeWithSpaces(block)

    // Find ALL PDF lines whose text appears in this chunk block
    const matchingLines = []

    for (let lineIdx = lastMatchedLineIdx + 1; lineIdx < pdfLines.length; lineIdx++) {
      const line = pdfLines[lineIdx]
      const lineNormalized = normalizeWithSpaces(line)

      // Skip very short lines
      if (lineNormalized.length < 8) continue

      // Check if this PDF line's text appears in the chunk block
      const lineInBlock = blockNormalized.includes(lineNormalized)

      // Also check if block appears in line (for short blocks)
      const blockInLine = lineNormalized.includes(blockNormalized)

      // Check with no spaces (handles "sciencenewst oday" vs "sciencenewstoday")
      const lineNoSpaces = normalizeNoSpaces(line)
      const blockNoSpaces = normalizeNoSpaces(block)
      const lineInBlockNoSpaces = blockNoSpaces.includes(lineNoSpaces)
      const blockInLineNoSpaces = lineNoSpaces.includes(blockNoSpaces)

      // Word-bag matching (handles word order differences)
      // Stricter threshold for short blocks to avoid false positives
      const lengthRatio = Math.max(lineNormalized.length, blockNormalized.length) / Math.min(lineNormalized.length, blockNormalized.length)
      const wordBagScore = lengthRatio <= 3 ? wordBagMatch(line, block) : 0
      const wordBagThreshold = blockNormalized.length < 60 ? 0.95 : 0.8

      // Fallback: high Levenshtein similarity
      const similarity = calculateLevenshteinSimilarity(lineNormalized, blockNormalized)

      if (lineInBlock || blockInLine || lineInBlockNoSpaces || blockInLineNoSpaces || wordBagScore >= wordBagThreshold || similarity >= 0.75) {
        matchingLines.push({ line, lineIdx })
      }
    }

    // Update last matched position to maintain sequential order
    if (matchingLines.length > 0) {
      lastMatchedLineIdx = Math.max(lastMatchedLineIdx, ...matchingLines.map(m => m.lineIdx))
    }

    const matched = matchingLines.length > 0

    results.push({
      blockIndex: blockIdx,
      blockText: block,
      blockLength: block.length,
      matched,
      linesMatched: matchingLines.length,
      matchedLines: matchingLines.map(m => m.line),
      lineIndices: matched ? matchingLines.map(m => m.lineIdx).join(',') : 'none',
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
      console.log(`   Lines: ${r.lineIndices} | Matched: ${r.linesMatched} PDF lines`)
      if (r.matched && r.matchedLines.length > 0) {
        r.matchedLines.forEach((line, i) => {
          console.log(`      Line: "${line.substring(0, 50)}..."`)
        })
      }
    })

    // Calculate metrics
    const totalBlocks = results.length
    const matchedBlocks = results.filter(r => r.matched).length
    const matchRate = totalBlocks > 0 ? matchedBlocks / totalBlocks : 0
    const totalLinesMatched = results.reduce((sum, r) => sum + r.linesMatched, 0)

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
    console.log(`Total Lines:       ${totalLinesMatched} PDF lines highlighted`)
    console.log(`Coverage:          ${(coverage * 100).toFixed(1)}%`)
    console.log('='.repeat(70))

    // Pass/Fail - simplified criteria
    const pass = matchRate >= 0.8 && coverage >= 0.75
    console.log(`\n${pass ? '✅ PASS' : '❌ FAIL'}`)

    if (!pass) {
      console.log('\nFailure reasons:')
      if (matchRate < 0.8) console.log(`  - Match rate too low: ${(matchRate * 100).toFixed(1)}% < 80%`)
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
