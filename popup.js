document.addEventListener('DOMContentLoaded', function () {
  // 获取当前活动标签页
  function getCurrentTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs && tabs.length > 0) {
        callback(tabs[0]);
      }
    });
  }

  // 获取打开任务抽屉按钮
  const openTaskDrawerBtn = document.getElementById('openTaskDrawer');

  // 检查并更新按钮状态
  function updateButtonState(tab) {
    chrome.tabs.sendMessage(tab.id, { action: 'checkTaskDrawerStatus' }, function (response) {
      openTaskDrawerBtn.textContent = response && response.isOpen ? '关闭任务列表' : '打开任务列表';
    });
  }

  // 初始化时获取状态
  getCurrentTab(function (tab) {
    updateButtonState(tab);
  });

  // 添加点击事件监听器
  openTaskDrawerBtn.addEventListener('click', function () {
    // 打开浏览器侧边栏
    chrome.sidePanel.open();
    window.close(); // 关闭弹出窗口
  });
});
