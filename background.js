// 全局状态
let state = 'idle'; // idle, recording, replaying, paused
let currentRecordingName = '';
let recordings = [];
let replayIndex = 0; // 当前回放的索引
let currentRecording = null; // 当前正在回放的录制内容
let startRecordingDomain = ""; // 开始录制时的域名
let enabledX = false;
let currentRepeatCount = 1; // 循环回放总轮次
let currentRepeatInterval = 1; // 每轮之间的间隔（秒）
let completedRounds = 0; // 已完成轮次数（循环回放用）

// 初始化
init();

function init() {
  // 加载已保存的录制
  loadRecordings();

  // 加载回放状态
  loadReplayState();

  // 监听来自content script和popup的消息
  chrome.runtime.onMessage.addListener(handleMessage);

  // 监听插件图标点击事件
  chrome.action.onClicked.addListener(() => {
    // 获取当前活动标签页
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length > 0) {

        // 打开侧边栏，传入当前标签页ID
        chrome.sidePanel.setOptions({ path: 'sidebar.html', enabled: true });
        chrome.sidePanel.open({ tabId: tabs[0].id });

        // // 切换侧边栏状态
        // console.log('切换侧边栏状态');
        // chrome.sidePanel.getOptions({}, function (options) {
        //   enabledX = options.enabled;
        //   console.log('当前侧边栏状态111:', enabledX);
        // });

        // console.log('当前侧边栏状态222:', enabledX);
        // if (enabledX) {
        //   console.log('侧边栏已启用，关闭它');
        //   chrome.sidePanel.setOptions({ enabled: false });
        //   enabledX = false;
        // } else {
        //   console.log('侧边栏未启用，打开它');
        //   enabledX = true;
        //   chrome.sidePanel.setOptions({ enabled: true });
        //   // 打开侧边栏，传入当前标签页ID
        //   chrome.sidePanel.open({ tabId: tabs[0].id });
        // }
      }
    });
  });

  // 设置侧边栏默认打开
  chrome.sidePanel.setOptions({
    enabled: true,
    path: 'sidebar.html'
  });

  // 监听标签页更新事件
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete') {
      // 只有在相应状态下才发送消息
      if (state === 'recording') {
        chrome.tabs.sendMessage(tabId, {
          action: 'startRecording',
          recordingName: currentRecordingName
        });
      } else if (state === 'replaying') {
        chrome.tabs.sendMessage(tabId, {
          action: 'startReplay',
          recording: currentRecording,
          replayIndex: replayIndex,
          taskName: currentRecordingName,
          repeatCount: currentRepeatCount,
          repeatInterval: currentRepeatInterval,
          isResume: true, // 页面刷新后续跑，不要重置轮次计数
        });
      } else if (state === 'paused') {
        chrome.tabs.sendMessage(tabId, {
          action: 'pauseReplay',
          recording: currentRecording,
          replayIndex: replayIndex
        });
      } else {
        // 注意：不能在这里无差别广播 stopReplay。
        // 页面加载完成事件（含 startReplay 触发的 reload、侧边栏加载）会频繁触发，
        // 而 state 在状态切换的瞬间可能不是 replaying，一旦误发 stopReplay
        // 会把正在循环的回放直接掐断。这里只发一个「同步当前状态」的查询，
        // 由 content 根据自己掌握的循环轮次自行决定是否停止。
        chrome.tabs.sendMessage(tabId, { action: 'syncReplayState', state: state });
      }
    }
  });
}

// 加载回放状态
function loadReplayState() {
  chrome.storage.local.get(['replayState', 'replayIndex', 'currentRecording', 'currentRecordingName'], function (data) {
    if (data.replayState) {
      state = data.replayState;
      replayIndex = data.replayIndex || 0;
      currentRecording = data.currentRecording || null;
      currentRecordingName = data.currentRecordingName || '';
      console.log('从存储中恢复回放状态:', state, replayIndex);
    }
  });
}

// 保存回放状态
function saveReplayState() {
  chrome.storage.local.set({
    replayState: state,
    replayIndex: replayIndex,
    currentRecording: currentRecording,
    currentRecordingName: currentRecordingName,
  });

  console.log('保存回放状态:', state, replayIndex);
}

// 处理消息
function handleMessage(message, sender, sendResponse) {
  switch (message.action) {
    case 'startRecording':
      startRecording(message.recordingName);
      sendResponse({ success: true });
      break;

    case 'stopRecording':
      stopRecording();
      sendResponse({ success: true });
      break;

    case 'recordAction':
      console.log('收到录制的动作:', message.recordedAction);
      recordAction(message.recordedAction);
      sendResponse({ success: true });
      break;

    case 'startReplay':
      startReplay(message.recordingName, message.repeatCount, message.repeatInterval);
      sendResponse({ success: true });
      break;

    case 'stopReplay':
      // content 在自己的收尾流程里发来 stopReplay 时带 finished 标记：
      // 循环跑完（finished=true）或用户主动结束（force=true）才真正停止
      stopReplay(Boolean(message.finished || message.force));
      sendResponse({ success: true });
      break;

    case 'pauseReplay':
      pauseReplay();
      sendResponse({ success: true });
      break;

    case 'resumeReplay':
      resumeReplay();
      sendResponse({ success: true });
      break;

    case 'stepReplay':
      stepReplay();
      sendResponse({ success: true });
      break;

    case 'updateReplayIndex':
      updateReplayIndex(message.replayIndex);
      sendResponse({ success: true });
      break;

    case 'replayComplete':
      replayComplete();
      sendResponse({ success: true });
      break;

    case 'getState':
      sendResponse({
        state: state,
        recordingName: currentRecordingName,

      });
      break;

    case 'getRecordings':
      sendResponse({ recordings: recordings });
      break;

    case 'getRecording':
      const recording = getRecording(message.recordingName);
      sendResponse({ recording: recording });
      break;

    case 'saveRecording':
      if (message.recordingName && message.recording) {
        saveRecording(message.recordingName, message.recording);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: '缺少录制名称或数据' });
      }
      break;

    case 'importRecording':
      // 导入他人分享的录制。校验通过即入库，名称冲突自动改名避免覆盖
      if (message.recording && Array.isArray(message.recording.actions)) {
        const ok = importRecording(message.recording);
        sendResponse(ok ? { success: true, name: ok } : { success: false, error: '录制数据不合法' });
      } else {
        sendResponse({ success: false, error: '缺少录制数据或 actions' });
      }
      break;

    case 'deleteRecording':
      deleteRecording(message.recordingName);
      notifyRecordingsChanged();
      sendResponse({ success: true });
      break;

    case 'updateRecordingDisplayName':
      const recordingToUpdate = recordings.find(r => r.name === message.recordingName);
      if (recordingToUpdate) {
        recordingToUpdate.displayName = message.displayName;
        saveRecordings();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: '未找到指定的录制' });
      }
      break;

    case 'getReplayState':
      sendResponse({
        state: state,
        recordingName: currentRecordingName,
        recording: currentRecording,
        replayIndex: replayIndex
      });
      break;

    case 'saveRecordedActions':
      if (currentRecordingName && message.actions) {
        saveRecording(currentRecordingName, message.actions);
        notifyRecordingsChanged();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: '缺少录制名称或数据' });
      }
      break;
  }

  return true; // 保持消息通道开放，以便异步响应
}

// 开始录制
function startRecording(recordingName) {
  state = 'recording';
  currentRecordingName = recordingName;

  // 获取当前活动标签页的域名
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length > 0) {
      const domain = tabs[0].url;
      startRecordingDomain = domain;

      // 创建新录制记录
      recordings.push({
        name: recordingName,
        domain: domain,
        actions: [],
        createdAt: Date.now()
      });
      saveRecordings();
    }
  });

  // // 通知所有标签页开始录制
  // chrome.tabs.query({}, function (tabs) {
  //   tabs.forEach(tab => {
  //     chrome.tabs.sendMessage(tab.id, {
  //       action: 'startRecording',
  //       recordingName: recordingName
  //     });
  //   });
  // });
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length > 0) {
      const currentTab = tabs[0];

      // 先刷新页面，确保从原始状态开始
      chrome.tabs.reload(currentTab.id, function () {
        chrome.tabs.sendMessage(currentTab.id, {
          action: 'startRecording',
          recordingName: recordingName
        });
      });

    }
  });

  // 通知popup状态变化
  notifyStateChanged();
  // 录制中，关闭侧边栏
  chrome.sidePanel.setOptions({ path: 'sidebar.html', enabled: false });
}

// 停止录制
function stopRecording() {
  console.log('停止录制，当前状态:', state);
  state = 'idle';

  // 通知所有标签页停止录制
  chrome.tabs.query({}, function (tabs) {
    console.log('通知所有标签页停止录制')
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'stopRecording' });
    });
  });

  // 获取当前活动标签页
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length > 0) {
      const currentTab = tabs[0];
      // // 跳转到 startRecordingDomain
      // if (startRecordingDomain) {
      //   chrome.tabs.update(currentTab.id, { url: startRecordingDomain });
      // }

      // 打开侧边栏，传入当前标签页ID
      chrome.sidePanel.setOptions({ path: 'sidebar.html', enabled: true });
      chrome.sidePanel.open({ tabId: currentTab.id });
    }
  });

  // 通知popup状态变化
  notifyStateChanged();
}

// 记录操作
function recordAction(action) {
  // 查找当前录制
  const recordingIndex = recordings.findIndex(r => r.name === currentRecordingName);

  if (recordingIndex >= 0) {
    console.log('已经有录制，添加新操作')
    // 更新现有录制
    recordings[recordingIndex].actions.push(action);
    console.log('更新后的录制:', recordings)
  } else {
    console.log('未找到现有录制，创建新录制')
    // 创建新录制
    recordings.push({
      name: currentRecordingName,
      actions: [action],
      createdAt: Date.now()
    });
    console.log('创建新录制:', recordings)
  }

  // 保存录制
  saveRecordings();
}

// 开始回放
function startReplay(recordingName, repeatCount = 1, repeatInterval = 1) {
  const recording = getRecording(recordingName);

  if (!recording) {
    console.error('未找到录制:', recordingName);
    return;
  }

  state = 'replaying';
  currentRecordingName = recordingName;
  currentRecording = recording.actions;
  replayIndex = 0;
  currentRepeatCount = Math.max(1, parseInt(repeatCount, 10) || 1);
  // 间隔允许 0（不等待），非法/负值回落到 1 秒
  currentRepeatInterval = Number.isFinite(parseFloat(repeatInterval)) && parseFloat(repeatInterval) >= 0
    ? parseFloat(repeatInterval)
    : 1;
  completedRounds = 0;

  // 清空待删除步骤列表
  chrome.storage.local.set({ deleteIndexes: [] });

  // 标记「等待用户点开始」：初次启动的回放要暂停等用户点击，
  // 页面刷新后 content 靠这个标志区分「初次启动」和「轮内刷新续跑」。
  // 用户点【开始】时由 content 清除。
  chrome.storage.local.set({ replayAwaitingStart: true });

  // 保存回放状态
  saveReplayState();

  // 获取当前活动标签页
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length > 0) {
      const currentTab = tabs[0];
      const firstAction = currentRecording[0];

      // // 跳转到任务页
      // // 不跳转，因为需要支持多页面
      // chrome.tabs.update(currentTab.id, { url: recording.domain });
      // console.log('跳转到任务页:', recording.domain);

      // 先刷新页面，确保从原始状态开始
      chrome.tabs.reload(currentTab.id, function () {
        // 直接在当前页面开始回放
        chrome.tabs.sendMessage(currentTab.id, {
          action: 'startReplay',
          recording: currentRecording,
          replayIndex: replayIndex,
          taskName: currentRecordingName,
          repeatCount: currentRepeatCount,
          repeatInterval: currentRepeatInterval,
        });
      });
      // 关闭侧边栏
      chrome.sidePanel.setOptions({ path: 'sidebar.html', enabled: false });
    }
  });

  // 通知popup状态变化
  notifyStateChanged();
}

// 删除待删除的索引
function applyWaitDeleteSteps() {
  // 处理待删除的操作步骤
  chrome.storage.local.get(['deleteIndexes'], function (result) {
    const deleteIndexes = result.deleteIndexes || [];
    if (deleteIndexes.length > 0) {
      console.log('待删除的操作步骤索引:', deleteIndexes);
      // 找到当前正在回放的录制
      let currentRecording = recordings.find(r => r.name === currentRecordingName);
      console.log('当前录制的操作步骤:', currentRecording);
      if (currentRecording) {
        // 过滤掉待删除的操作步骤
        const filteredActions = currentRecording.actions.filter((_, index) => !deleteIndexes.includes(index));
        currentRecording.actions = filteredActions;
        // recordings = currentRecording;
        console.log('更新后的操作步骤:', currentRecording);
        // 更新存储
        chrome.storage.local.set({ recordings: recordings }, function () {
          console.log('已删除选中的操作步骤');
          // 清空待删除列表
          chrome.storage.local.remove('deleteIndexes');
          // 通知content.js显示提示
          chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs.length > 0) {
              chrome.tabs.sendMessage(tabs[0].id, {
                action: 'showDeleteStepsToast',
                message: `本轮调试，丢弃了 ${deleteIndexes.length} 个操作步骤: ${deleteIndexes.join(',')}`,
              });
            }
          });
        });
      }
    }
  });
}

// 停止回放
// force: true 时无条件停止（用户主动点「结束」）；否则循环未跑完时不停止
function stopReplay(force = false) {
  // 删除待删除的索引
  applyWaitDeleteSteps();

  // 循环回放尚未跑完时，不允许被动停止（例如页面加载完成误触发的停止）
  if (!force && currentRepeatCount > 1 && state !== 'idle') {
    console.log(`循环回放进行中（已完成 ${completedRounds}/${currentRepeatCount} 轮），忽略停止请求`);
    return;
  }

  if (state !== 'replaying' && state !== 'paused') return;

  console.log('停止回放，当前状态:', state);

  state = 'idle';
  replayIndex = 0;
  currentRecording = null;
  completedRounds = 0;
  currentRepeatCount = 1;

  // 通知所有标签页停止回放
  chrome.tabs.query({}, function (tabs) {
    tabs.forEach(tab => {
      try {
        chrome.tabs.sendMessage(tab.id, { action: 'stopReplay' });
      } catch (e) {
        console.error('向标签页发送停止消息失败:', e);
      }
    });
  });

  // 清除存储中的回放状态
  chrome.storage.local.remove(['replayState', 'replayIndex', 'currentRecording', 'currentRecordingName', 'replayAwaitingStart'], function () {
    console.log('已清除存储中的回放状态');
  });

  // 保存空状态
  saveReplayState();

  // 通知popup状态变化
  notifyStateChanged();
  // 获取当前活动标签页
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length > 0) {
      const currentTab = tabs[0];
      // 打开侧边栏，传入当前标签页ID
      chrome.sidePanel.setOptions({ path: 'sidebar.html', enabled: true });
      chrome.sidePanel.open({ tabId: currentTab.id });
    }
  });
}

// 暂停回放
function pauseReplay() {
  if (state !== 'replaying') return;

  state = 'paused';

  // 保存回放状态
  saveReplayState();

  // 通知所有标签页暂停回放
  chrome.tabs.query({}, function (tabs) {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'pauseReplay' });
    });
  });

  // 通知popup状态变化
  notifyStateChanged();
}

// 继续回放
function resumeReplay() {
  if (state !== 'paused') return;

  state = 'replaying';

  // 保存回放状态
  saveReplayState();

  // 通知所有标签页继续回放
  chrome.tabs.query({}, function (tabs) {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'resumeReplay' });
    });
  });

  // 通知popup状态变化
  notifyStateChanged();
}

// 步进回放
function stepReplay() {
  if (state !== 'paused') return;

  // 通知当前标签页执行下一步
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'stepReplay' });
    }
  });
}

// 更新回放索引
function updateReplayIndex(index) {
  replayIndex = index;

  // 保存回放状态
  saveReplayState();

  // 一整轮跑完了
  if (currentRecording && replayIndex >= currentRecording.length) {
    // 循环回放：还有剩余轮次时不判定为「回放完成」，只累计轮次
    if (currentRepeatCount > 1 && completedRounds + 1 < currentRepeatCount) {
      completedRounds++;
      console.log(`第 ${completedRounds}/${currentRepeatCount} 轮完成，继续下一轮`);
      // 索引归零，等待 content 开始下一轮
      replayIndex = 0;
      saveReplayState();
      return;
    }
    replayComplete();
    return;
  }

  // 通知所有标签页更新进度
  chrome.tabs.query({}, function (tabs) {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'updateProgress',
        replayIndex: replayIndex,
        totalSteps: currentRecording ? currentRecording.length : 0
      });
    });
  });
}

// 回放完成
function replayComplete() {
  // 删除待删除的索引
  applyWaitDeleteSteps();
  console.log('回放完成');

  // 循环回放跑完时不要强开侧边栏：content 会保留控制面板并标记完成，
  // 弹侧边栏会把用户在看的页面顶掉
  if (currentRepeatCount <= 1) {
    // 获取当前活动标签页
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      console.log('获取当前活动标签页，并打开侧边栏')
      if (tabs.length > 0) {
        const currentTab = tabs[0];
        // 打开侧边栏，传入当前标签页ID
        chrome.sidePanel.setOptions({ path: 'sidebar.html', enabled: true });
        chrome.sidePanel.open({ tabId: currentTab.id });
      }
    });
  } else {
    console.log('循环回放完成，不打开侧边栏');
  }


  state = 'idle';
  replayIndex = 0;
  currentRecording = null;

  // 清除存储中的回放状态
  chrome.storage.local.remove(['replayState', 'replayIndex', 'currentRecording', 'currentRecordingName', 'replayAwaitingStart']);

  // 保存空状态
  saveReplayState();

  // 通知popup状态变化
  notifyStateChanged();

  // 通知所有标签页回放已完成
  chrome.tabs.query({}, function (tabs) {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'stopReplay' });
    });
  });
}

// 获取录制
function getRecording(recordingName) {
  const recording = recordings.find(r => r.name === recordingName);
  return recording || null;
}

// 获取当前录制
function getCurrentRecording() {
  return getRecording(currentRecordingName);
}

// 保存录制
function saveRecording(name, actions) {
  // 检查是否已存在同名录制
  const existingIndex = recordings.findIndex(r => r.name === name);

  if (existingIndex >= 0) {
    // 更新现有录制
    recordings[existingIndex].actions = actions;
    recordings[existingIndex].timestamp = Date.now(); // 更新时间戳
  } else {
    // 添加新录制
    recordings.push({
      name: name,
      actions: actions,
      timestamp: Date.now() // 添加时间戳
    });
  }

  // 保存到存储
  saveRecordings();

  console.log('录制已保存:', name, actions.length);
}

// 导入录制：名称冲突时追加后缀，避免覆盖已有任务。返回最终使用的名称
function importRecording(rec) {
  if (!rec || !Array.isArray(rec.actions) || rec.actions.length === 0) return null;
  let name = rec.name || ('导入_' + Date.now());
  // 名称冲突就改名，最多兜底几次
  if (recordings.some(r => r.name === name)) {
    name = `${name}_导入${Date.now()}`;
  }
  recordings.push({
    name: name,
    displayName: rec.displayName || rec.name || name,
    domain: rec.domain || '',
    actions: rec.actions,
    createdAt: rec.createdAt || Date.now(),
    imported: true
  });
  saveRecordings();
  console.log('已导入录制:', name, '共', rec.actions.length, '步');
  return name;
}

// 删除录制
function deleteRecording(recordingName) {
  const index = recordings.findIndex(r => r.name === recordingName);

  if (index >= 0) {
    recordings.splice(index, 1);
    saveRecordings();

    // 通知popup录制列表变化
    notifyRecordingsChanged();
  }
}

// 加载录制列表
function loadRecordings() {
  chrome.storage.local.get('recordings', function (data) {
    if (data.recordings) {
      recordings = data.recordings;
    }
  });
}

// 保存录制列表
function saveRecordings() {
  chrome.storage.local.set({ recordings: recordings }, function () {
    // 保存成功后通知录制列表变化
    notifyRecordingsChanged();
  });
}

// 通知状态变化
function notifyStateChanged() {
  chrome.runtime.sendMessage({
    action: 'stateChanged',
    state: state,
    recordingName: currentRecordingName,
    replayIndex: replayIndex,
    totalSteps: currentRecording ? currentRecording.length : 0
  });

  // 更新扩展图标状态
  // updateExtensionIcon();
}

// 通知录制列表变化
function notifyRecordingsChanged() {
  // 通知所有标签页录制列表已更改
  chrome.tabs.query({}, function (tabs) {
    tabs.forEach(function (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'updateTaskDrawer' })
        .catch(function (error) {
          // 忽略无法发送消息的错误
          console.log('无法发送消息到标签页:', tab.id, error);
        });
    });
  });

  // 通知弹出窗口录制列表已更改
  chrome.runtime.sendMessage({ action: 'recordingsChanged', recordings: recordings })
    .catch(function (error) {
      // 忽略无法发送消息的错误
      console.log('无法发送消息到弹出窗口:', error);
    });
}

// 添加更新扩展图标状态的函数
function updateExtensionIcon() {
  let iconPath = '';

  switch (state) {
    case 'recording':
      iconPath = 'icons/recording.png';
      break;
    case 'replaying':
      iconPath = 'icons/replaying.png';
      break;
    case 'paused':
      iconPath = 'icons/paused.png';
      break;
    default:
      iconPath = 'icons/idle.png';
  }

  // 如果有图标资源，则更新图标
  try {
    chrome.action.setIcon({ path: iconPath });
  } catch (e) {
    console.log('无法更新图标，可能是图标资源不存在');
  }
}