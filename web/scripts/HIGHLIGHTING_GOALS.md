# PDF Highlighting Goals & Validation

## What We're Trying to Achieve

### Goal: Accurate Citation Highlighting

When user clicks a citation:
1. **PDF opens to correct page** (from n8n page_numbers)
2. **Exact chunk text is highlighted** in yellow
3. **ONLY chunk text is highlighted** (no extra content = no false positives)
4. **ALL chunk text is highlighted** (high coverage = no missing parts)
5. **Highlights appear automatically** (no manual click needed)

---

## Current Implementation

### Data Flow

```
n8n API
  ↓
Returns:
  - chunk_context: "The owner device can manage..."
  - page_numbers: [1]
  - pdf_url: "ccc/inbox/page37.pdf"
  ↓
PDF Viewer:
  1. Extract text from page 1 ONLY → group into lines with boxes
  2. Match chunk blocks to PDF lines (sliding window + Levenshtein)
  3. Highlight matched line boxes
  4. scrollTo() page to trigger rendering
```

### Matching Algorithm

**Sliding Window (1-5 lines):**
```
Block: "The owner device can manage secure keys"

Try:
  Window [Line 1]: "The owner"
    → Levenshtein: 0.45
  Window [Lines 1-2]: "The owner device can"
    → Levenshtein: 0.78
  Window [Lines 1-3]: "The owner device can manage secure"
    → Levenshtein: 0.92 ✓ BEST MATCH

Highlight Lines 1-3
```

---

## Validation Requirements

### Test 1: Correct Page ✓
```
Expected: Chunk on page 2 → extract from page 2 → highlight on page 2
Console: "[PDF] API page number: 2"
Console: "[PDF] 📄 Extracting text from page 2..."
```

### Test 2: High Match Rate ✓
```
Expected: ≥80% of chunk blocks find matches
Console: "Block Match Rate: 8/10 (80.0%)"
```

### Test 3: High Similarity Score ✓
```
Expected: Matched windows have ≥0.75 similarity
Console: "Average Score: 0.892"
```

### Test 4: High Coverage ✓
```
Expected: ≥75% of chunk characters get highlighted
Console: "Coverage: 85.3% of chunk chars"
```

### Test 5: No False Positives ⚠️ (MANUAL CHECK REQUIRED)
```
Expected: Highlighted text should ONLY be text that appears in chunk
Manual: Read chunk → Read highlighted text → Verify they match

Example:
  Chunk: "The owner device can manage"
  Highlighted: "The owner device can manage"  ✓ GOOD
  Highlighted: "The owner device can manage encryption protocols"  ✗ BAD (extra text)
```

### Test 6: Highlights Appear Automatically ✓
```
Expected: Highlights show without clicking PDF
Manual: Load page → See highlights immediately
```

---

## Testing Process (For Each Chunk)

### Preparation
```bash
node scripts/test-all-pdfs.js --chunkId=2
```

Shows:
- Page number: 1
- Blocks: 4
- Block content preview

### Browser Test

1. Open http://localhost:3000
2. Click citation (chunkId=2)
3. **Wait for highlights** (should appear automatically)

### Console Validation

Check console for:

```
✓ [PDF] API page number: 1
✓ [PDF] 📄 Extracting text from page 1...
✓ [PDF] 📝 4 chunk blocks to match

✓ [PDF]   Block 1: "Figure 2-1..."
✓ [PDF]       ✓ Matched 1 consecutive lines (score: 0.95)

✓ [PDF] 📊 QUALITY METRICS
✓ Block Match Rate:  4/4 (100.0%)     ← Target: ≥80%
✓ Average Score:     0.905             ← Target: ≥0.85
✓ Coverage:          92.3% of chunk    ← Target: ≥75%
```

### Manual Validation (CRITICAL)

**Step 1: Copy chunk text** (from test script output)
```
Block 1: "Figure 2-1: Digital Key Architecture..."
Block 2: "In the system, the vehicle is linked..."
Block 3: "The vehicle is equipped with NFC..."
Block 4: "The owner device communicates..."
```

**Step 2: Read highlighted text in PDF**
- Select highlighted text
- Copy it
- Compare to chunk blocks

**Step 3: Verify**
- ✓ Is highlighted text IN the chunk? → GOOD
- ✗ Is highlighted text NOT in chunk? → FALSE POSITIVE (FAIL)

---

## Test Results Template

| Chunk | PDF | Page | Match Rate | Avg Score | Coverage | False Positives? | Auto-show? | Pass/Fail |
|-------|-----|------|------------|-----------|----------|------------------|------------|-----------|
| 2 | page37 | 1 | ?/4 (?%) | ? | ?% | ☐ Yes ☐ No | ☐ Yes ☐ No | ☐ Pass ☐ Fail |
| 3 | page37 | 1 | ?/3 (?%) | ? | ?% | ☐ Yes ☐ No | ☐ Yes ☐ No | ☐ Pass ☐ Fail |
| 4 | Tropical | 1 | ?/2 (?%) | ? | ?% | ☐ Yes ☐ No | ☐ Yes ☐ No | ☐ Pass ☐ Fail |
| 6 | Tropical | 1 | ?/2 (?%) | ? | ?% | ☐ Yes ☐ No | ☐ Yes ☐ No | ☐ Pass ☐ Fail |
| 9 | Tropical | 2 | ?/2 (?%) | ? | ?% | ☐ Yes ☐ No | ☐ Yes ☐ No | ☐ Pass ☐ Fail |

**ALL must be Pass before we change anything.**

---

## Current Concerns

### Issue 1: Sliding Window May Over-Match
```
Chunk block: "The owner device"
PDF has: "The owner device can manage encryption keys"

Window [Lines 1-2]: "The owner device can manage encryption keys"
  → Contains chunk block ✓
  → Highlights ENTIRE window
  → Includes extra text: "can manage encryption keys"
  → FALSE POSITIVE ✗
```

**Solution:** Match window must be ≤ chunk block length (or very close)

### Issue 2: Multi-Page Chunks Not Handled
```
Chunk 7: page_numbers: [1, 2]
Current: Only extracts page 1
Result: Missing content from page 2
```

**Solution:** Extract text from ALL pages in page_numbers array

---

## Next Steps

1. **Test current implementation** (chunks 2, 3, 4, 6, 9)
2. **Record actual results** in table above
3. **Identify failures** (false positives, poor coverage)
4. **Fix issues** before adding new features
5. **Re-test** to confirm fixes work

**Start testing now - fill in the results table!**
