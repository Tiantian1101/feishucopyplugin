// ===== popup.js =====

console.log('=== Popup script loaded ===');

const startBtn = document.getElementById('startBtn');
const cancelBtn = document.getElementById('cancelBtn');
const preview = document.getElementById('preview');

function setPreview(type, html) {
  preview.className = type;
  preview.innerHTML = html;
}

startBtn.onclick = async function() {
  startBtn.disabled = true;
  startBtn.textContent = '截图中...';
  cancelBtn.style.display = 'block';

  setPreview('working', '⏳ 正在滚回顶部，准备截图...');

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tabs || tabs.length === 0) throw new Error('未找到活动标签页');

    const tab = tabs[0];

    if (!tab.url.includes('feishu.cn') && !tab.url.includes('larksuite.com')) {
      throw new Error('请在飞书文档页面使用此插件');
    }

    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'startFullCapture', tabId: tab.id }, function(res) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });

    if (!response.success) throw new Error(response.error || '截图失败');

    setPreview('success',
      '✅ 截图完成，PDF 已下载！<br><br>' +
      `<span style="font-size:13px">共截图 ${response.totalCaptures} 张 · ${response.totalPages} 页</span>`
    );

  } catch (err) {
    setPreview('error', '❌ ' + err.message);
  }

  startBtn.disabled = false;
  startBtn.textContent = '开始截图';
  cancelBtn.style.display = 'none';
};

cancelBtn.onclick = async function() {
  await chrome.runtime.sendMessage({ type: 'cancelFullCapture' });
  cancelBtn.style.display = 'none';
  startBtn.disabled = false;
  startBtn.textContent = '开始截图';
  setPreview('', '已取消截图');
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'captureProgress') {
    setPreview('working',
      `🎨 截图中...<br><br>` +
      `<span style="font-size:13px">已截 ${msg.count} 张 · 第 ${msg.currentPage} 页 · 滚动位置 ${msg.scrollTop}px</span>`
    );
  }
});

console.log('=== Popup script ready ===');
