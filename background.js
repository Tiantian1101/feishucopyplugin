// ===== background.js - Offscreen Document 版本 =====

console.log('Background service worker started');

let currentSession = null;

function createSession(tabId) {
  return {
    tabId: tabId,
    isCapturing: true,
    cancelled: false,
    scrollAttemptsWithoutMove: 0,
    captureCount: 0,
    canvasList: [],
    currentCanvas: null,
    currentCtx: null,
    currentCanvasHeight: 0,
    pageIndex: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    maxPageHeight: 14000
  };
}

function clearSession() {
  if (currentSession && currentSession.canvasList) {
    currentSession.canvasList = [];
  }
  currentSession = null;
}

chrome.runtime.onInstalled.addListener(function(details) {
  console.log('Extension installed:', details.reason);
});

chrome.runtime.onMessage.addListener(function(msg, sender, respond) {
  console.log('Background received message:', msg.type);

  if (msg.type === 'startFullCapture') {
    if (currentSession && currentSession.isCapturing) {
      respond({ success: false, error: '已有截图任务正在进行' });
      return false;
    }
    handleFullCapture(msg.tabId, respond);
    return true;
  }

  if (msg.type === 'cancelFullCapture') {
    if (currentSession) {
      currentSession.cancelled = true;
    }
    respond({ success: true });
    return false;
  }

  return false;
});

async function handleFullCapture(tabId, respond) {
  try {
    currentSession = createSession(tabId);
    await runFullCaptureLoop();

    const tab = await chrome.tabs.get(tabId);
    const title = await getDocumentTitle(tabId, tab.title);
    const pages = await convertCanvasesToDataUrls();

    await setupOffscreenDocument();

    const pdfResult = await chrome.runtime.sendMessage({
      type: 'generatePDF',
      pages: pages,
      title: title
    });

    if (!pdfResult.success) {
      throw new Error(pdfResult.error || 'PDF 生成失败');
    }

    const downloadFilename = sanitizeDownloadFilename(title);
    try {
      await chrome.downloads.download({
        url: pdfResult.url,
        filename: downloadFilename,
        saveAs: false
      });
    } catch (downloadError) {
      console.warn('Download with document title failed, using fallback filename:', downloadError);
      await chrome.downloads.download({
        url: pdfResult.url,
        filename: `feishu_document_${Date.now()}.pdf`,
        saveAs: false
      });
    }

    await closeOffscreenDocument();

    respond({
      success: true,
      totalCaptures: currentSession.captureCount,
      totalPages: currentSession.canvasList.length,
      pdfSize: pdfResult.size
    });

  } catch (error) {
    console.error('Full capture error:', error);
    await closeOffscreenDocument();
    respond({ success: false, error: error.message });
  } finally {
    clearSession();
  }
}

async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Generate PDF from canvas data'
  });
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {}
}

async function convertCanvasesToDataUrls() {
  const pages = [];

  for (let i = 0; i < currentSession.canvasList.length; i++) {
    const canvasItem = currentSession.canvasList[i];
    const canvas = canvasItem.canvas;

    const actualHeight = i === currentSession.canvasList.length - 1
      ? currentSession.currentCanvasHeight
      : canvas.height;

    let finalCanvas = canvas;

    if (actualHeight < canvas.height) {
      finalCanvas = new OffscreenCanvas(canvas.width, actualHeight);
      const ctx = finalCanvas.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
    }

    const blob = await finalCanvas.convertToBlob({ type: 'image/png' });
    const dataUrl = await blobToDataURL(blob);

    pages.push({
      width: finalCanvas.width,
      height: actualHeight,
      dataUrl: dataUrl
    });
  }

  return pages;
}

async function runFullCaptureLoop() {
  console.log('=== Full Capture Started ===');
  const tabId = currentSession.tabId;

  // 隐藏 fixed/sticky 元素和飞书常见浮层
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      window.__hiddenElements = [];

      const floatingClassPattern = /(float|floating|toolbar|sidebar|side-bar|comment|reaction|collab|guide|tour|popover|tooltip|bubble)/i;
      const floatingSelectors = [
        '[class*="floating"]',
        '[class*="Float"]',
        '[class*="toolbar"]',
        '[class*="Toolbar"]',
        '[class*="comment"]',
        '[class*="Comment"]',
        '[class*="reaction"]',
        '[class*="Reaction"]',
        '[class*="collab"]',
        '[class*="Collab"]',
        '[class*="popover"]',
        '[class*="Popover"]',
        '[class*="tooltip"]',
        '[class*="Tooltip"]',
        '[data-testid*="comment"]',
        '[data-testid*="toolbar"]',
        '[data-testid*="float"]'
      ];

      function rememberAndHide(el) {
        if (!el || window.__hiddenElements.some(item => item.el === el)) return;
        window.__hiddenElements.push({
          el: el,
          originalVisibility: el.style.visibility
        });
        el.style.visibility = 'hidden';
      }

      function isLikelyFloatingControl(el, style) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.width > window.innerWidth * 0.7 || rect.height > window.innerHeight * 0.7) return false;

        const className = typeof el.className === 'string' ? el.className : '';
        const id = el.id || '';
        const role = el.getAttribute('role') || '';
        const testId = el.getAttribute('data-testid') || '';
        const text = `${className} ${id} ${role} ${testId}`;
        const nearRightEdge = rect.right > window.innerWidth - 140;
        const nearViewportEdge = nearRightEdge || rect.left < 80 || rect.top < 80 || rect.bottom > window.innerHeight - 80;

        return floatingClassPattern.test(text) && nearViewportEdge && style.position !== 'static';
      }

      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el);
        const position = style.position;
        if (position === 'fixed' || position === 'sticky' || isLikelyFloatingControl(el, style)) {
          rememberAndHide(el);
        }
      });

      floatingSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
          const style = window.getComputedStyle(el);
          if (isLikelyFloatingControl(el, style)) {
            rememberAndHide(el);
          }
        });
      });

      console.log('Hidden fixed/sticky elements:', window.__hiddenElements.length);
    }
  });

  await sleep(500);

  // 滚动到顶部
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      document.querySelectorAll('*').forEach(el => {
        if (el.scrollTop > 0) el.scrollTop = 0;
      });
    }
  });

  await sleep(1000);

  // 先截第一张
  const firstScreenshot = await captureVisibleTab();
  await stitchScreenshot(firstScreenshot, null, true);
  currentSession.captureCount++;
  console.log('First screenshot captured');

  await sleep(500);

  // 循环滚动截图
  while (currentSession && currentSession.isCapturing && !currentSession.cancelled) {

    const scrollResult = await performScroll(tabId);
    console.log('Scroll result:', scrollResult);

    if (!scrollResult.success || scrollResult.actualScrolled < 5) {
      currentSession.scrollAttemptsWithoutMove++;
      console.log('No movement, attempt:', currentSession.scrollAttemptsWithoutMove);
      if (currentSession.scrollAttemptsWithoutMove >= 3) {
        console.log('Reached bottom');
        break;
      }
      await sleep(400);
      continue;
    }

    currentSession.scrollAttemptsWithoutMove = 0;

    await sleep(400);

    const screenshotDataUrl = await captureVisibleTab();
    const stitchOk = await stitchScreenshot(screenshotDataUrl, scrollResult, false);

    if (!stitchOk) {
      console.log('Stitch skipped');
      break;
    }

    currentSession.captureCount++;

    try {
      chrome.runtime.sendMessage({
        type: 'captureProgress',
        count: currentSession.captureCount,
        scrollTop: scrollResult.afterScroll,
        currentPage: currentSession.pageIndex + 1
      });
    } catch (e) {}

    await sleep(600);

    if (currentSession.captureCount >= 300) {
      console.log('Safety limit reached');
      break;
    }
  }

  // 恢复隐藏的元素
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      if (window.__hiddenElements) {
        window.__hiddenElements.forEach(item => {
          item.el.style.visibility = item.originalVisibility;
        });
        window.__hiddenElements = [];
      }
    }
  });

  console.log('=== Full Capture Finished ===');
  console.log('Total captures:', currentSession.captureCount);
}

async function stitchScreenshot(dataUrl, scrollResult, isFirstCapture) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  if (currentSession.viewportWidth === 0) {
    currentSession.viewportWidth = imageBitmap.width;
    currentSession.viewportHeight = imageBitmap.height;
  }

  let cropTop = 0;
  let cropHeight = imageBitmap.height;

  if (isFirstCapture) {
    const headerHeight = Math.floor(imageBitmap.height * 0.08);
    cropTop = headerHeight;
    cropHeight = imageBitmap.height - headerHeight;
    console.log('First capture: cropped header', headerHeight, 'px');
  } else {
    const viewportHeight = scrollResult.viewportHeight || imageBitmap.height;
    const pixelRatio = imageBitmap.height / viewportHeight;
    const actualScrolledCss = scrollResult.actualScrolled;
    const actualScrolledPx = Math.round(actualScrolledCss * pixelRatio);

    cropHeight = Math.min(actualScrolledPx, imageBitmap.height);
    cropTop = imageBitmap.height - cropHeight;

    if (cropTop < 0 || cropHeight < 10 || cropTop >= imageBitmap.height) {
      console.warn('Invalid crop, skipping. cropTop:', cropTop, 'cropHeight:', cropHeight);
      imageBitmap.close();
      return false;
    }

    const minValidHeight = 10;
    if (cropHeight < minValidHeight) {
      console.warn('cropHeight too small, skipping:', cropHeight);
      imageBitmap.close();
      return false;
    }

    if (actualScrolledPx >= imageBitmap.height) {
      cropTop = 0;
      cropHeight = imageBitmap.height;
    }
  }

  if (!currentSession.currentCanvas) {
    createNewCanvasPage(cropHeight);
  }

  if (currentSession.currentCanvasHeight + cropHeight > currentSession.maxPageHeight) {
    createNewCanvasPage(cropHeight);
  }

  if (currentSession.currentCanvasHeight + cropHeight > currentSession.currentCanvas.height) {
    expandCanvas(currentSession.currentCanvasHeight + cropHeight);
  }

  currentSession.currentCtx.drawImage(
    imageBitmap,
    0, cropTop, imageBitmap.width, cropHeight,
    0, currentSession.currentCanvasHeight, imageBitmap.width, cropHeight
  );

  currentSession.currentCanvasHeight += cropHeight;

  console.log('Stitched:', {
    cropTop,
    cropHeight,
    currentHeight: currentSession.currentCanvasHeight,
    viewportHeight: scrollResult ? scrollResult.viewportHeight : imageBitmap.height
  });

  imageBitmap.close();
  return true;
}

async function getDocumentTitle(tabId, fallbackTitle) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const selectors = [
          '[data-testid="doc-title"]',
          '[data-testid="space-title"]',
          '.doc-title',
          '.suite-title',
          '.wiki-title',
          '.docs-title',
          '.document-title',
          '[class*="doc-title"]',
          '[class*="DocTitle"]'
        ];

        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const text = el && el.textContent ? el.textContent.trim() : '';
          if (text && text.length > 1 && text.length < 120) {
            return text;
          }
        }

        const titleText = document.title || '';
        return titleText
          .replace(/\s*[-|—]\s*(飞书|Feishu|Lark).*$/i, '')
          .replace(/\s*[-|—]\s*(Docs|文档).*$/i, '')
          .trim();
      }
    });

    const title = results && results[0] && results[0].result;
    if (title) return title;
  } catch (error) {
    console.warn('Failed to read document title:', error);
  }

  return (fallbackTitle || 'feishu_document')
    .replace(/\s*[-|—]\s*(飞书|Feishu|Lark).*$/i, '')
    .trim();
}

function createNewCanvasPage(initialHeight) {
  const height = Math.min(initialHeight || 1000, currentSession.maxPageHeight);
  const canvas = new OffscreenCanvas(currentSession.viewportWidth || 1280, height);
  const ctx = canvas.getContext('2d');

  currentSession.currentCanvas = canvas;
  currentSession.currentCtx = ctx;
  currentSession.currentCanvasHeight = 0;

  currentSession.canvasList.push({ canvas, actualHeight: 0 });
  currentSession.pageIndex = currentSession.canvasList.length - 1;

  console.log('Created new canvas page:', currentSession.pageIndex + 1);
}

function expandCanvas(newHeight) {
  if (newHeight > currentSession.maxPageHeight) newHeight = currentSession.maxPageHeight;

  const oldCanvas = currentSession.currentCanvas;
  if (newHeight <= oldCanvas.height) return;

  const newCanvas = new OffscreenCanvas(oldCanvas.width, newHeight);
  const newCtx = newCanvas.getContext('2d');
  newCtx.drawImage(oldCanvas, 0, 0);

  currentSession.currentCanvas = newCanvas;
  currentSession.currentCtx = newCtx;
  currentSession.canvasList[currentSession.pageIndex].canvas = newCanvas;

  console.log('Expanded canvas to', newHeight);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function sanitizeDownloadFilename(name) {
  const fallback = 'feishu_document';
  let cleaned = (name || fallback)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!cleaned) cleaned = fallback;
  if (cleaned.length > 80) cleaned = cleaned.substring(0, 80).replace(/[. ]+$/g, '');
  return `${cleaned || fallback}.pdf`;
}

async function performScroll(tabId) {
  const scrollResults = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const viewportHeight = window.innerHeight;
      const centerX = Math.floor(window.innerWidth / 2);
      const centerY = Math.floor(window.innerHeight / 2);
      const centerElement = document.elementFromPoint(centerX, centerY);
      let scrollContainer = null;

      let parent = centerElement;
      while (parent && parent !== document.body) {
        if (parent.scrollHeight > parent.clientHeight + 10) {
          scrollContainer = parent;
          break;
        }
        parent = parent.parentElement;
      }

      if (!scrollContainer) {
        let maxScrollHeight = 0;
        document.querySelectorAll('*').forEach(el => {
          if (
            el.scrollHeight > el.clientHeight + 10 &&
            el.scrollHeight > maxScrollHeight &&
            el.clientHeight > viewportHeight * 0.5
          ) {
            maxScrollHeight = el.scrollHeight;
            scrollContainer = el;
          }
        });
      }

      const baseDistance = Math.floor(viewportHeight * 0.75);
      const minOverlap = 150;
      const maxScrollDistance = Math.max(100, viewportHeight - minOverlap);
      const scrollDistance = Math.min(baseDistance, maxScrollDistance);
      let beforeScroll = 0;
      let afterScroll = 0;

      if (scrollContainer) {
        beforeScroll = scrollContainer.scrollTop;
        scrollContainer.scrollTop += scrollDistance;
        scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
        afterScroll = scrollContainer.scrollTop;
      } else {
        beforeScroll = window.scrollY;
        window.scrollBy(0, scrollDistance);
        afterScroll = window.scrollY;
      }

      return {
        success: (afterScroll - beforeScroll) > 0,
        actualScrolled: afterScroll - beforeScroll,
        beforeScroll,
        afterScroll,
        viewportHeight,
        scrollDistance,
        overlapPixels: viewportHeight - scrollDistance
      };
    }
  });

  return scrollResults[0].result;
}

async function captureVisibleTab() {
  const screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  return screenshot;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
