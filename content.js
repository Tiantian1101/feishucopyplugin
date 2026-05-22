// ===== content.js - 只保留监听器 =====

console.log('Content script loaded on Feishu');

chrome.runtime.onMessage.addListener(function(msg, sender, respond) {
  console.log('Content received message:', msg.type);
  
  if (msg.type === 'test') {
    respond({ 
      success: true, 
      message: 'Content script is working' 
    });
  }
  
  if (msg.type === 'getPageInfo') {
    respond({
      success: true,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      scrollTop: document.documentElement.scrollTop
    });
  }
  
  return true;
});
