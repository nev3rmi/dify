
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfUrl = 'https://minio.toho.vn/n8n-document-ingestion/tropical/inbox/Tropical.pdf';
const searchText = 'Science News Article';

async function inspectGeometry() {
    try {
        console.log('🚀 Analyzing PDF Geometry...');
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });

        console.log('Page 1 Viewport:', {
            width: viewport.width,
            height: viewport.height,
            scale: viewport.scale,
            offsetX: viewport.offsetX,
            offsetY: viewport.offsetY
        });

        const textContent = await page.getTextContent();
        const items = textContent.items;

        const normalize = (s) => s.replace(/\s+/g, ' ').toLowerCase();
        const searchNormalized = normalize(searchText);

        console.log(`\nSearching for "${searchText}"...`);

        items.forEach((item) => {
            const itemStr = normalize(item.str);
            // Check for partial match to find the words
            if (['science', 'news', 'article'].some(w => itemStr.includes(w))) {
                console.log('\n--------------------------------------------------');
                console.log(`Found Item: "${item.str}"`);
                console.log('Transform:', item.transform);
                console.log('Item Width:', item.width);
                console.log('Item Height:', item.height);

                const [scaleX, skewY, skewX, scaleY, x, y] = item.transform;

                // Calculate dimensions
                const fontHeight = Math.abs(scaleY);
                const calculatedWidth = item.width;

                // PDF Coordinates (Bottom-Left Origin)
                // x, y is usually the bottom-left of the text baseline
                const pdfBox = {
                    x: x,
                    y: y,
                    w: calculatedWidth,
                    h: fontHeight
                };
                console.log('PDF Coords (Baseline):', pdfBox);

                // Convert to Viewport (Top-Left Origin)
                // y_top = viewport_height - (y_pdf + height)
                // y_bottom = viewport_height - y_pdf
                const viewY1 = viewport.height - (y + fontHeight);
                const viewY2 = viewport.height - y;

                console.log('Calculated Viewport Coords:', {
                    x1: x,
                    y1: viewY1,
                    x2: x + calculatedWidth,
                    y2: viewY2,
                    width: calculatedWidth,
                    height: fontHeight
                });
            }
        });

    } catch (error) {
        console.error('❌ Error:', error);
    }
}

inspectGeometry();
