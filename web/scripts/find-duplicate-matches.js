#!/usr/bin/env node

/**
 * Find chunks where text blocks appear multiple times in the PDF
 * This helps identify cases where we need better selection logic
 */

const https = require('https')
const fs = require('fs')
const { execSync } = require('child_process')

const CHUNK_API_URL = 'https://n8n.toho.vn/webhook/dbf0d2ae-ec68-4827-bdb7-f5dec29c2b1d'

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
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
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

function fetchChunkData(chunkId) {
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

function extractPdfLines(pdfPath, pageNumbers) {
  // Get local PDF path
  let pdfFileName = pdfPath.split('/').pop()
  if (pdfFileName.includes('IM-0065805')) pdfFileName = 'hospital.pdf'
  const pdfFilePath = `/tmp/test-pdfs/${pdfFileName}`

  if (!fs.existsSync(pdfFilePath)) {
    throw new Error(`PDF not found: ${pdfFilePath}`)
  }

  if (pageNumbers.length === 1) {
    const outputPath = `/tmp/pdf-dup-check-p${pageNumbers[0]}.json`
    execSync(`node scripts/extract-pdf-lines.js --pdf="${pdfFilePath}" --page=${pageNumbers[0]} --output="${outputPath}" 2>/dev/null`)

    if (!fs.existsSync(outputPath))
      throw new Error(`Failed to extract PDF lines`)

    const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    return data.lines.map((text, idx) => ({ text, lineIndex: idx }))
  }
  else {
    const outputPath = `/tmp/pdf-dup-check-multi.json`
    execSync(`node scripts/extract-multi-page.js --pdf="${pdfFilePath}" --pages=${pageNumbers.join(',')} --output="${outputPath}" 2>/dev/null`)

    if (!fs.existsSync(outputPath))
      throw new Error(`Failed to extract multi-page PDF lines`)

    const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    return data.lines // Already has lineIndex and pageNumber
  }
}

async function findDuplicateMatches(chunkId) {
  let chunkData
  try {
    chunkData = await fetchChunkData(chunkId)
  } catch (e) {
    return { chunkId, type: 'error', reason: `Fetch failed: ${e.message}` }
  }

  const { type, chunkContext, pageNumbers, pdfPath } = chunkData

  if (type === 'image' || !chunkContext || chunkContext.startsWith('![')) {
    return { chunkId, type: 'skip', reason: 'image' }
  }

  // Extract PDF text
  let lines
  try {
    lines = extractPdfLines(pdfPath, pageNumbers)
  } catch (e) {
    return { chunkId, type: 'error', reason: `Extract failed: ${e.message}` }
  }

  if (!lines || lines.length === 0) {
    return { chunkId, type: 'error', reason: 'No PDF lines extracted' }
  }

  // Normalize lines to objects with text
  const pdfLines = lines.map((l, i) => typeof l === 'string' ? { text: l, lineIndex: i } : l)

  // Split chunk into blocks
  const chunkBlocks = chunkContext
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 10)

  const duplicateInfo = []

  for (let i = 0; i < chunkBlocks.length; i++) {
    const block = chunkBlocks[i]
    const blockNormalized = normalizeWithSpaces(block)

    // Find ALL matches above threshold
    const allMatches = []

    for (let windowSize = 1; windowSize <= Math.min(5, pdfLines.length); windowSize++) {
      for (let startIdx = 0; startIdx <= pdfLines.length - windowSize; startIdx++) {
        const windowLines = pdfLines.slice(startIdx, startIdx + windowSize)
        const windowText = normalizeWithSpaces(windowLines.map(l => l.text).join(' '))

        // Calculate similarity
        const similarity = calculateLevenshteinSimilarity(blockNormalized, windowText)

        // Check substring match
        const isSubstring = windowText.includes(blockNormalized) || blockNormalized.includes(windowText)

        let score = isSubstring ? 1.0 : similarity

        // Word-bag matching for short blocks
        if (blockNormalized.length < 60 && score < 0.75) {
          const blockWords = blockNormalized.split(' ').filter(w => w.length >= 3)
          const windowWords = windowText.split(' ').filter(w => w.length >= 3)
          const allWordsPresent = blockWords.length > 0
            && blockWords.every(w => windowWords.some(ww => ww.includes(w) || w.includes(ww)))
          const lengthRatio = windowText.length / blockNormalized.length

          if (allWordsPresent && lengthRatio <= 2.0)
            score = 0.85
        }

        if (score >= 0.75) {
          allMatches.push({
            startIdx,
            windowSize,
            score,
            lineNumbers: windowLines.map((_, j) => startIdx + j + 1),
            text: windowLines.map(l => l.text).join(' ').substring(0, 100),
          })
        }
      }
    }

    // Group matches by unique positions (non-overlapping)
    if (allMatches.length > 1) {
      // Sort by score desc, then by startIdx
      allMatches.sort((a, b) => b.score - a.score || a.startIdx - b.startIdx)

      const uniquePositions = []
      for (const match of allMatches) {
        // Check if this position overlaps with any already selected
        const overlaps = uniquePositions.some(p => {
          const pEnd = p.startIdx + p.windowSize - 1
          const mEnd = match.startIdx + match.windowSize - 1
          return !(match.startIdx > pEnd || mEnd < p.startIdx)
        })

        if (!overlaps) {
          uniquePositions.push(match)
        }
      }

      // Only report if there are multiple DISTINCT positions
      if (uniquePositions.length > 1) {
        duplicateInfo.push({
          blockIndex: i,
          blockText: block.substring(0, 80) + (block.length > 80 ? '...' : ''),
          matchCount: uniquePositions.length,
          matches: uniquePositions.slice(0, 5).map(m => ({
            lineNumbers: m.lineNumbers,
            score: m.score.toFixed(3),
            text: m.text.substring(0, 60) + '...'
          }))
        })
      }
    }
  }

  return {
    chunkId,
    type: duplicateInfo.length > 0 ? 'has_duplicates' : 'no_duplicates',
    blockCount: chunkBlocks.length,
    duplicates: duplicateInfo
  }
}

async function main() {
  console.log('🔍 Finding chunks with duplicate matches...\n')

  const results = []

  // Test chunks 1-43
  for (let i = 1; i <= 43; i++) {
    process.stdout.write(`Chunk ${i}: `)

    const result = await findDuplicateMatches(i)
    results.push(result)

    if (result.type === 'has_duplicates') {
      console.log(`⚠️  ${result.duplicates.length} block(s) with duplicates`)
    } else if (result.type === 'skip') {
      console.log(`⏭️  (${result.reason})`)
    } else if (result.type === 'error') {
      console.log(`❌ ${result.reason}`)
    } else {
      console.log('✅ unique')
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70))
  console.log('DETAILED ANALYSIS: Chunks with duplicate matches')
  console.log('='.repeat(70))

  const duplicateChunks = results.filter(r => r.type === 'has_duplicates')

  if (duplicateChunks.length === 0) {
    console.log('\n✅ No chunks with duplicate matches found.')
    console.log('   All text blocks matched to unique positions.\n')
  } else {
    console.log(`\n⚠️  Found ${duplicateChunks.length} chunks with duplicate matches:\n`)

    for (const result of duplicateChunks) {
      console.log('─'.repeat(70))
      console.log(`📄 Chunk ${result.chunkId} (${result.blockCount} blocks):`)

      for (const dup of result.duplicates) {
        console.log(`\n   Block ${dup.blockIndex + 1}: "${dup.blockText}"`)
        console.log(`   ↳ Found at ${dup.matchCount} different positions:\n`)

        for (let j = 0; j < dup.matches.length; j++) {
          const match = dup.matches[j]
          const marker = j === 0 ? '✓ SELECTED' : `  Option ${j + 1}`
          console.log(`     ${marker} (score=${match.score}): Lines ${match.lineNumbers.join('-')}`)
          console.log(`       "${match.text}"`)
        }
      }
    }

    console.log('\n' + '='.repeat(70))
    console.log('RECOMMENDATION: How to select the best match?')
    console.log('='.repeat(70))
    console.log(`
Current: Takes FIRST match with highest score (arbitrary tie-breaker)

Better strategies:
  1. SEQUENTIAL ORDERING: If block N matched line X, block N+1 should match line Y > X
  2. CONTEXT WINDOW: Match blocks that form a continuous region together
  3. Y-POSITION: Prefer top-to-bottom order when scores are equal
  4. PAGE HINT: Use page_numbers from API as hint for expected location
`)
  }
}

main().catch(console.error)
