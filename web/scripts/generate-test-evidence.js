#!/usr/bin/env node

/**
 * Generate Full Test Evidence Report
 *
 * For each chunk, shows:
 * 1. Exact chunk text from n8n
 * 2. Exact PDF text extracted
 * 3. What matched to what
 * 4. Whether match is correct or false positive
 */

const https = require('https')
const fs = require('fs')
const { execSync } = require('child_process')

const CHUNK_API_URL = 'https://n8n.toho.vn/webhook/dbf0d2ae-ec68-4827-bdb7-f5dec29c2b1d'

// Matching logic (same as component)
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
  try {
    if (pageNumbers.length === 1) {
      const outputPath = `/tmp/pdf-lines-${pdfPath.split('/').pop()}-p${pageNumbers[0]}.json`
      const cmd = `node scripts/extract-pdf-lines.js --pdf="${pdfPath}" --page=${pageNumbers[0]} --output="${outputPath}" 2>/dev/null`
      execSync(cmd)

      if (!fs.existsSync(outputPath))
        throw new Error(`Failed to extract PDF lines`)

      const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      return data.lines
    }
    else {
      const outputPath = `/tmp/pdf-multi-lines-p${pageNumbers.join('-')}.json`
      const cmd = `node scripts/extract-multi-page.js --pdf="${pdfPath}" --pages=${pageNumbers.join(',')} --output="${outputPath}" 2>/dev/null`
      execSync(cmd)

      if (!fs.existsSync(outputPath))
        throw new Error(`Failed to extract multi-page PDF lines`)

      const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      return data.lines
    }
  }
  catch (error) {
    throw new Error(`Cannot extract PDF: ${error.message}`)
  }
}

async function generateEvidenceReport(chunkId) {
  console.log(`\n${'='.repeat(80)}`)
  console.log(`EVIDENCE REPORT: Chunk ${chunkId}`)
  console.log('='.repeat(80))

  try {
    // Fetch chunk
    const { type, chunkContext, pageNumbers, projectCode, pdfPath } = await fetchChunkData(chunkId)

    if (type !== 'text') {
      console.log(`\nSKIPPED: Type is "${type}" (not text)`)
      return null
    }

    console.log(`\nCHUNK INFO:`)
    console.log(`  Project: ${projectCode}`)
    console.log(`  PDF: ${pdfPath}`)
    console.log(`  Pages: [${pageNumbers.join(', ')}]`)
    console.log(`  Length: ${chunkContext.length} chars`)

    // Extract PDF from ALL pages
    let pdfFileName = pdfPath.split('/').pop()
    // Map long filenames to simplified ones
    if (pdfFileName.includes('IM-0065805')) pdfFileName = 'hospital.pdf'
    const pdfFilePath = `/tmp/test-pdfs/${pdfFileName}`
    const pdfLines = extractRealPDFLines(pdfFilePath, pageNumbers)

    // Split chunk into blocks
    const chunkBlocks = chunkContext
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 10)

    console.log(`\n${'─'.repeat(80)}`)
    console.log(`CHUNK TEXT (${chunkBlocks.length} blocks):`)
    console.log('─'.repeat(80))
    chunkBlocks.forEach((block, i) => {
      console.log(`\nBlock ${i + 1} (${block.length} chars):`)
      console.log(`"${block}"`)
    })

    console.log(`\n${'─'.repeat(80)}`)
    console.log(`PDF TEXT (${pdfLines.length} lines on page ${pageNumber}):`)
    console.log('─'.repeat(80))
    pdfLines.forEach((line, i) => {
      console.log(`${(i + 1).toString().padStart(3)}. ${line}`)
    })

    // Run matching
    console.log(`\n${'─'.repeat(80)}`)
    console.log(`MATCHING RESULTS:`)
    console.log('─'.repeat(80))

    const results = []

    for (let i = 0; i < chunkBlocks.length; i++) {
      const block = chunkBlocks[i]
      const blockNormalized = normalizeWithSpaces(block)

      let bestMatch = null

      // Try sliding window
      for (let windowSize = 1; windowSize <= Math.min(5, pdfLines.length); windowSize++) {
        for (let startIdx = 0; startIdx <= pdfLines.length - windowSize; startIdx++) {
          const windowLines = pdfLines.slice(startIdx, startIdx + windowSize)
          const windowText = normalizeWithSpaces(windowLines.join(' '))

          const similarity = calculateLevenshteinSimilarity(blockNormalized, windowText)
          const windowContainsBlock = windowText.includes(blockNormalized)
            && windowText.length >= blockNormalized.length * 0.9

          let score = windowContainsBlock ? 1.0 : similarity

          // Word-bag for short blocks
          if (blockNormalized.length < 60 && score < 0.75) {
            const blockWords = blockNormalized.split(' ').filter(w => w.length >= 3)
            const windowWords = windowText.split(' ').filter(w => w.length >= 3)

            const allWordsPresent = blockWords.length > 0
              && blockWords.every(w => windowWords.some(ww => ww.includes(w) || w.includes(ww)))

            const lengthRatio = windowText.length / blockNormalized.length
            const acceptableLength = lengthRatio <= 2.0

            if (allWordsPresent && acceptableLength)
              score = 0.85
          }

          if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
              startIdx,
              endIdx: startIdx + windowSize - 1,
              windowLines,
              windowText,
              score,
            }
          }
        }
      }

      const threshold = 0.75
      const matched = bestMatch && bestMatch.score >= threshold

      console.log(`\nBlock ${i + 1}: ${matched ? '✅ MATCHED' : '❌ NO MATCH'}`)
      console.log(`  Chunk text: "${block.substring(0, 70)}${block.length > 70 ? '...' : ''}"`)

      if (matched) {
        console.log(`  Matched to: PDF Lines ${bestMatch.startIdx + 1}-${bestMatch.endIdx + 1}`)
        console.log(`  PDF text:   "${bestMatch.windowText.substring(0, 70)}${bestMatch.windowText.length > 70 ? '...' : ''}"`)
        console.log(`  Score:      ${bestMatch.score.toFixed(3)}`)

        // FALSE POSITIVE CHECK
        const chunkNorm = normalizeWithSpaces(block)
        const pdfNorm = bestMatch.windowText

        // Check if PDF has significantly more text than chunk
        if (pdfNorm.length > chunkNorm.length * 1.5) {
          console.log(`  ⚠️  WARNING: PDF text is ${(pdfNorm.length / chunkNorm.length).toFixed(1)}x longer than chunk`)
          console.log(`     Possible false positive (highlighting extra text)`)
        }

        // Check if all chunk words are in PDF match
        const chunkWords = new Set(chunkNorm.split(' '))
        const pdfWords = new Set(pdfNorm.split(' '))
        const missingWords = [...chunkWords].filter(w => w.length >= 4 && !pdfWords.has(w))

        if (missingWords.length > 0) {
          console.log(`  ⚠️  WARNING: ${missingWords.length} chunk words NOT in PDF match`)
          console.log(`     Missing: ${missingWords.slice(0, 5).join(', ')}`)
        }
      }
      else {
        console.log(`  Best score: ${bestMatch?.score.toFixed(3) || '0.000'} (threshold: ${threshold})`)
        if (bestMatch) {
          console.log(`  Closest:    PDF Lines ${bestMatch.startIdx + 1}-${bestMatch.endIdx + 1}`)
          console.log(`  PDF text:   "${bestMatch.windowText.substring(0, 70)}..."`)
        }
      }

      results.push({ block: i + 1, matched, score: bestMatch?.score || 0 })
    }

    // Summary
    const totalBlocks = results.length
    const matchedBlocks = results.filter(r => r.matched).length
    const matchRate = totalBlocks > 0 ? matchedBlocks / totalBlocks : 0
    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length

    console.log(`\n${'='.repeat(80)}`)
    console.log(`SUMMARY:`)
    console.log(`  Match Rate:   ${matchedBlocks}/${totalBlocks} (${(matchRate * 100).toFixed(1)}%)`)
    console.log(`  Average Score: ${avgScore.toFixed(3)}`)
    console.log(`  Result:        ${matchRate >= 0.8 ? '✅ PASS' : '❌ FAIL'}`)
    console.log('='.repeat(80))

    return { chunkId, totalBlocks, matchedBlocks, matchRate, avgScore, passed: matchRate >= 0.8 }
  }
  catch (error) {
    console.error(`\n❌ ERROR: ${error.message}`)
    return null
  }
}

// Main
const chunkId = process.argv[2]?.replace('--chunkId=', '') || '2'
generateEvidenceReport(chunkId)
