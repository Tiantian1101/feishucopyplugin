// ===== offscreen.js - PDF 生成处理（优化版）=====

console.log('Offscreen document loaded');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  if (message.type === 'generatePDF') {
    
    console.log('Generating PDF with', message.pages.length, 'pages');
    
    generatePDFFromPages(message.pages, message.title)
      .then(result => {
        sendResponse({ success: true, ...result });
      })
      .catch(error => {
        console.error('PDF generation error:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true;
  }
});

async function generatePDFFromPages(pages, title) {
  
  if (!pages || pages.length === 0) {
    throw new Error('No pages to generate PDF');
  }

  const { jsPDF } = window.jspdf;
  
  // 使用 A4 尺寸 (210mm x 297mm)
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true  // 启用 PDF 压缩
  });

  const pageWidth = 210;
  const pageHeight = 297;

  const images = [];
  for (let i = 0; i < pages.length; i++) {
    const img = await loadImage(pages[i].dataUrl);
    images.push({
      img,
      sourceY: 0,
      index: i + 1
    });
  }

  const imgWidth = images[0].img.width;
  const mmPerPx = pageWidth / imgWidth;
  const pageHeightPx = Math.floor(pageHeight / mmPerPx);
  let imageIndex = 0;
  let isFirstPage = true;

  while (imageIndex < images.length) {
    if (!isFirstPage) {
      pdf.addPage();
    }

    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = imgWidth;
    pageCanvas.height = pageHeightPx;
    const pageCtx = pageCanvas.getContext('2d');
    pageCtx.imageSmoothingEnabled = false;

    pageCtx.fillStyle = '#ffffff';
    pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

    let targetY = 0;
    const usedSegments = [];

    while (targetY < pageHeightPx && imageIndex < images.length) {
      const item = images[imageIndex];
      const remainingSourceHeight = item.img.height - item.sourceY;
      const remainingPageHeight = pageHeightPx - targetY;
      const sliceHeight = Math.min(remainingSourceHeight, remainingPageHeight);

      pageCtx.drawImage(
        item.img,
        0, item.sourceY, imgWidth, sliceHeight,
        0, targetY, imgWidth, sliceHeight
      );

      usedSegments.push(`${item.index}:${Math.round(item.sourceY)}+${Math.round(sliceHeight)}`);
      item.sourceY += sliceHeight;
      targetY += sliceHeight;

      if (item.sourceY >= item.img.height - 1) {
        imageIndex++;
      }
    }

    const outputCanvas = targetY < pageHeightPx
      ? document.createElement('canvas')
      : pageCanvas;

    if (outputCanvas !== pageCanvas) {
      outputCanvas.width = imgWidth;
      outputCanvas.height = Math.ceil(targetY);
      const outputCtx = outputCanvas.getContext('2d');
      outputCtx.imageSmoothingEnabled = false;
      outputCtx.drawImage(
        pageCanvas,
        0, 0, imgWidth, outputCanvas.height,
        0, 0, imgWidth, outputCanvas.height
      );
    }

    const fragmentHeightMm = outputCanvas.height * mmPerPx;
    const fragmentDataUrl = outputCanvas.toDataURL('image/png');
    pdf.addImage(fragmentDataUrl, 'PNG', 0, 0, pageWidth, fragmentHeightMm, undefined, 'FAST');
    console.log(`PDF page: ${fragmentHeightMm.toFixed(1)}mm from ${usedSegments.join(', ')}`);

    isFirstPage = false;
  }

  const pdfBlob = pdf.output('blob');
  console.log('PDF generated, size:', pdfBlob.size, 'bytes');

  const url = URL.createObjectURL(pdfBlob);

  return {
    url: url,
    size: pdfBlob.size
  };
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}
