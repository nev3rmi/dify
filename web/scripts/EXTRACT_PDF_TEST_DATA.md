# How to Extract Real PDF Test Data

## Goal

Get actual PDF text (not mock) to test matching logic offline.

## Step 1: Extract PDF Text from Browser

Open browser console and run:

```javascript
// In browser console when PDF is loaded:
copy(JSON.stringify({
  chunkId: 2,
  pdf: 'page37.pdf',
  page: 1,
  lines: pageTextMap.lines.map(l => l.text)
}, null, 2))
```

This copies real PDF lines to clipboard.

## Step 2: Save to Test Data File

Create `scripts/test-data/chunk-2.json`:

```json
{
  "chunkId": 2,
  "pdf": "page37.pdf",
  "page": 1,
  "lines": [
    "Figure 2-1: Digital Key Architecture with Actors and Their Relationships",
    "In the system, the vehicle is linked to the Vehicle OEM Server per Telematics Link (1).",
    "This link provides a secure communication channel...",
    ...
  ]
}
```

## Step 3: Run Logic Test

```bash
node scripts/test-matching-logic.js --chunkId=2 --testData=scripts/test-data/chunk-2.json
```

## Alternative: Quick Manual Extraction

1. Open http://localhost:3000
2. Click citation (chunkId=2)
3. In console, find: `[PDF] 📦 ALL sentence boxes`
4. Copy the line text output
5. Paste into test data file

---

## Simpler Approach: Just Use Console Metrics

Since we already have quality metrics in console:

**Just test in browser and record:**

```
Chunk 2:
  Block Match Rate: ?/?  (??%)
  Average Score: ?
  Coverage: ??%
  False Positives: Yes/No (manual check)

Chunk 3:
  Block Match Rate: ?/? (??%)
  ...
```

**This validates the logic works in real conditions.**

Would you like me to create the test data extraction, or just test directly in browser?
