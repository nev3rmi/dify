# PDF Matching Test Plan

## Test PDFs (from MinIO: n8n-document-ingestion)

Downloaded to `/tmp/test-pdfs/`:

1. **page37.pdf** (214 KB)
   - Source: ccc/inbox/page37.pdf

2. **hospital.pdf** (399 KB)
   - Source: hospital/inbox/IM-0065805 - BOLTON, Tracey LOI (Dr Manolopoulos).pdf

3. **Tropical.pdf** (449 KB)
   - Source: tropical/inbox/Tropical.pdf

## Testing Process

### Step 1: Fetch Chunk Info

```bash
# Test each chunk ID
node scripts/test-all-pdfs.js --chunkId=1
node scripts/test-all-pdfs.js --chunkId=2
node scripts/test-all-pdfs.js --chunkId=3
```

This shows:
- Page number where content should be
- Chunk blocks to match
- Expected coverage

### Step 2: Test in Browser

1. Open http://localhost:3000
2. Click citation with specific chunkId
3. Check console output:

```
[PDF] API page number: 2              ← Correct page from n8n
[PDF] 📄 Extracting text from page 2  ← Extracting correct page
[PDF] 📦 ALL sentence boxes            ← All PDF lines on that page

[PDF] 📊 QUALITY METRICS
==================================================
[PDF] Block Match Rate:  3/4 (75.0%)     ← % of blocks matched
[PDF] Average Score:     0.892            ← Similarity score
[PDF] Coverage:          82.5% of chunk chars
[PDF] Matched Rects:     8
==================================================
```

### Step 3: Validate Quality

**Check for false positives:**
- ✓ Only highlight text that exists in chunk
- ✗ If highlighting text NOT in chunk = FALSE POSITIVE

**Check for good coverage:**
- ✓ Most chunk text is highlighted (≥75%)
- ✗ If <50% highlighted = POOR COVERAGE

**Check for consecutive matches:**
- ✓ Highlighted lines should be together
- ✗ If scattered random lines = BAD MATCHING

## Quality Targets

### Good Matching ✓
- Block Match Rate: **≥ 80%** (8/10 blocks matched)
- Average Score: **≥ 0.85** (high similarity)
- Coverage: **≥ 75%** (most chunk text highlighted)
- **No false positives** (nothing extra highlighted)

### Poor Matching ✗
- Block Match Rate: < 60%
- Average Score: < 0.75
- Coverage: < 50%
- False positives present

## Test Matrix

| Chunk ID | PDF | Page | Blocks | Expected Match Rate | Notes |
|----------|-----|------|--------|---------------------|-------|
| 1 | ? | ? | ? | ≥80% | Test first |
| 2 | ? | 1 | 4 | ≥80% | Already tested |
| 3 | ? | ? | ? | ≥80% | Test next |

## How to Run Full Test

```bash
# Terminal 1: Run dev server
cd /home/nev3r/projects/dify/web
pnpm dev

# Terminal 2: Test each chunk
node scripts/test-all-pdfs.js --chunkId=1
node scripts/test-all-pdfs.js --chunkId=2
node scripts/test-all-pdfs.js --chunkId=3

# Browser: Test each citation
# Open console (F12) and check quality metrics for each
```

## Success Criteria

Before implementing any new matching algorithm:

1. ✓ Test chunks 1-5 in browser
2. ✓ All have Block Match Rate ≥ 80%
3. ✓ All have Average Score ≥ 0.85
4. ✓ No false positives in any chunk
5. ✓ Highlights appear automatically (no click needed)

If any chunk fails these criteria, we know what to improve.
