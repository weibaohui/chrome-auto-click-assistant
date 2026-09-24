// 全局变量
let isRecording = false;
let isReplaying = false;
let isPaused = false;
let recordedActions = [];
let replayIndex = 0;
let replayTimeout = null;
let replayWaitTimer = null; // 等待元素就绪的轮询定时器（auto-wait）
let pageLoadCount = 0;
let controlPanel = null;
let taskDrawer = null; // 任务抽屉组件
let isTaskDrawerOpen = false; // 抽屉是否打开
let recordingIndicator = null; // 录制状态指示器
let recordingStartTime = 0; // 录制开始时间
let recordingTimer = null; // 录制计时器
let currentRecordingName = ''; // 添加当前录制名称
let currentTaskName = ''; // 当前回放任务名称
let mousePointer = null; // 鼠标指针元素
let lastHoveredElement = null; // 上次悬停的元素
let show_all = false; // 是否显示所有任务
let toastTimer = null; // 弱提示定时器
let elementNotFoundCount = 0; // 未找到元素计数

// 自动重复（循环回放）相关
let repeatTotal = 1;        // 总轮次（1 = 不循环，保持原有行为）
let repeatCurrent = 0;      // 已完成的轮次数
let isLooping = false;      // 是否处于循环回放
let loopTaskName = '';      // 循环任务名（跨页面刷新保留）
let loopIntervalMs = 1000;  // 轮次之间的间隔
let pendingRoundStart = false; // 轮间间隔等待中（本轮已计入 repeatCurrent，等待进入下一轮）

// 初始化
init();

function removeValue(array, value) {
  return array.filter(item => item !== value);
}

function init() {
  // 检查是否是页面刷新后的重新加载
  chrome.storage.local.get(['isRecording', 'pageLoadCount', 'recordingName', 'recordingStartTime', 'isPaused', 'repeatTotal', 'repeatCurrent', 'isLooping', 'loopTaskName', 'replayAwaitingStart'], function (data) {
    console.log('检测到页面刷新，缓存的数据', data);
    // replayAwaitingStart：回放已启动但用户还没点过【开始】，
    // 刷新恢复后必须继续暂停等待，不能自动开跑
    isPaused = data.isPaused || data.replayAwaitingStart || false;

    // 恢复循环回放状态（页面刷新后循环不能断）
    repeatTotal = data.repeatTotal || 1;
    repeatCurrent = data.repeatCurrent || 0;
    isLooping = data.isLooping || false;
    loopTaskName = data.loopTaskName || '';

    // 同一个会话，页面刷新了
    pageLoadCount = (data.pageLoadCount || 0) + 1;

    // 如果正在录制，添加页面刷新事件
    if (data.isRecording) {
      isRecording = true;
      recordedActions = [];
      // 恢复录制开始时间
      recordingStartTime = data.recordingStartTime || Date.now();
      recordAction({
        type: 'pageRefresh',
        url: window.location.href,
        timestamp: Date.now()
      });

      // 显示录制状态指示器
      if (data.recordingName) {
        console.log('恢复上次录制状态:', data.recordingName, "录制开始的时间,计时器", recordingStartTime);
        showRecordingIndicator(data.recordingName);
        // 重新启动计时器
        startRecordingTimer();
        // 立即更新计时器显示
        updateRecordingTimer();
      }
    } else {
      // 新的会话
      pageLoadCount = 0;
    }

    // 创建任务抽屉
    createTaskDrawer();

    // 保存当前状态
    // saveState();

    // 检查是否正在回放
    chrome.runtime.sendMessage({ action: 'getReplayState' }, function (response) {
      console.log('获取回放状态:', response);

      if (response) {
        // 只有当状态是 replaying 或 paused 时才继续回放。
        // 若 background 的续跑消息已经先恢复过（isReplaying=true），
        // 这里不能再碰状态，否则会把正在进行的回放重置或清掉面板
        if (response.state === 'replaying' || response.state === 'paused') {
          if (!isReplaying) {
            isReplaying = true;
            recordedActions = response.recording || [];
            replayIndex = response.replayIndex || 0;

            // 恢复任务名（循环时以 loopTaskName 为准，报告标题不丢）
            if (loopTaskName) {
              currentTaskName = loopTaskName;
            }

            // 创建控制面板
            createControlPanel();

            // 等待页面加载完成后继续回放
            window.addEventListener('load', function () {
              setTimeout(continueReplay, 1000);
            });
          }
        } else if (!isReplaying) {
          // 如果状态是 idle 或其他，确保本地状态也是停止的
          console.log('回放已停止，清除本地状态');
          isReplaying = false;
          removeControlPanel();
        }
        saveState();
      }
    });
  });

  // 监听来自background的消息
  chrome.runtime.onMessage.addListener(handleMessage);

  // 添加事件监听器
  setupEventListeners();
}

// 设置事件监听器
function setupEventListeners() {
  // 监听URL变化
  function updateDomainHint() {
    console.log('URL 变化:', window.location.href);
    const domainHint = document.getElementById('airoom-domain-hint');
    if (domainHint) {
      domainHint.textContent = `列出当前页面任务：${window.location.href}`;
      updateTaskDrawer();
    }
  }

  // 监听popstate事件
  window.addEventListener('popstate', updateDomainHint);

  // 监听pushState和replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function () {
    originalPushState.apply(this, arguments);
    updateDomainHint();
  };

  history.replaceState = function () {
    originalReplaceState.apply(this, arguments);
    updateDomainHint();
  };

  // 使用MutationObserver监听DOM变化
  const observer = new MutationObserver(function (mutations) {
    if (mutations.some(mutation => mutation.type === 'childList' || mutation.type === 'attributes')) {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        updateDomainHint();
      }
    }
  });

  let lastUrl = window.location.href;
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true
  });

  // 鼠标点击
  document.addEventListener('click', function (event) {
    if (!isRecording) return;

    // 检查是否点击了停止录制按钮
    if (event.target.textContent === '结束录制') {
      return;
    }

    const selector = getSelector(event.target);
    const elementText = getElementText(event.target);

    if (selector) {
      recordAction({
        type: 'click',
        selector: selector,
        fallbackSelector: getFallbackSelector(event.target),
        fallbackClass: getClassFallback(event.target),
        text: elementText,
        x: event.clientX, // 记录鼠标X坐标
        y: event.clientY, // 记录鼠标Y坐标
        pageX: event.pageX, // 记录页面X坐标
        pageY: event.pageY, // 记录页面Y坐标
        timestamp: Date.now()
      });
    }
  }, true);

  // 输入事件
  document.addEventListener('input', function (event) {
    if (!isRecording) return;

    const selector = getSelector(event.target);

    if (selector) {
      recordAction({
        type: 'input',
        selector: selector,
        fallbackSelector: getFallbackSelector(event.target),
        fallbackClass: getClassFallback(event.target),
        value: event.target.value,
        x: event.target.getBoundingClientRect().left + (event.target.offsetWidth / 2), // 估算输入框中心X坐标
        y: event.target.getBoundingClientRect().top + (event.target.offsetHeight / 2), // 估算输入框中心Y坐标
        pageX: event.target.getBoundingClientRect().left + (event.target.offsetWidth / 2) + window.pageXOffset,
        pageY: event.target.getBoundingClientRect().top + (event.target.offsetHeight / 2) + window.pageYOffset,
        timestamp: Date.now()
      });
    }
  }, true);

  // 键盘按下
  document.addEventListener('keydown', function (event) {
    if (!isRecording) return;

    // 只记录特殊键和组合键
    if (event.key === 'Enter' ||
      event.key === 'Escape' ||
      event.key === 'Tab' ||
      event.key === 'Backspace' ||
      event.key === 'Delete' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight' ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey) {

      const selector = getSelector(event.target);

      recordAction({
        type: 'keydown',
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        selector: selector,
        fallbackSelector: getFallbackSelector(event.target),
        fallbackClass: getClassFallback(event.target),
        x: event.target.getBoundingClientRect().left + (event.target.offsetWidth / 2), // 估算目标元素中心X坐标
        y: event.target.getBoundingClientRect().top + (event.target.offsetHeight / 2), // 估算目标元素中心Y坐标
        pageX: event.target.getBoundingClientRect().left + (event.target.offsetWidth / 2) + window.pageXOffset,
        pageY: event.target.getBoundingClientRect().top + (event.target.offsetHeight / 2) + window.pageYOffset,
        timestamp: Date.now()
      });
    }
  }, true);

  // 表单提交
  document.addEventListener('submit', function (event) {
    if (!isRecording) return;

    const selector = getSelector(event.target);
    const elementText = getElementText(event.target);
    const submitButton = event.target.querySelector('input[type="submit"], button[type="submit"]');
    let x = 0, y = 0, pageX = 0, pageY = 0;

    if (submitButton) {
      const rect = submitButton.getBoundingClientRect();
      x = rect.left + (rect.width / 2);
      y = rect.top + (rect.height / 2);
      pageX = x + window.pageXOffset;
      pageY = y + window.pageYOffset;
    } else {
      const rect = event.target.getBoundingClientRect();
      x = rect.left + (rect.width / 2);
      y = rect.top + (rect.height / 2);
      pageX = x + window.pageXOffset;
      pageY = y + window.pageYOffset;
    }

    if (selector) {
      recordAction({
        type: 'submit',
        selector: selector,
        fallbackSelector: getFallbackSelector(event.target),
        fallbackClass: getClassFallback(event.target),
        text: elementText,
        x: x,
        y: y,
        pageX: pageX,
        pageY: pageY,
        timestamp: Date.now()
      });
    }
  }, true);

  // 滚动事件（节流处理）
  let lastScrollTime = 0;
  document.addEventListener('scroll', function () {
    if (!isRecording) return;

    const now = Date.now();
    if (now - lastScrollTime > 500) { // 每500ms最多记录一次滚动
      lastScrollTime = now;
      recordAction({
        type: 'scroll',
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        x: window.innerWidth / 2, // 使用窗口中心作为坐标
        y: window.innerHeight / 2,
        pageX: window.scrollX + (window.innerWidth / 2),
        pageY: window.scrollY + (window.innerHeight / 2),
        timestamp: now
      });
    }
  }, true);
}

// 处理来自background的消息
function handleMessage(message, sender, sendResponse) {
  console.log('收到消息:', message.action);

  switch (message.action) {
    case 'startRecording':
      startRecording(message.recordingName);
      sendResponse({ success: true });
      break;

    case 'stopRecording':
      stopRecording();
      sendResponse({ success: true });
      break;

    case 'startReplay':
      console.log('收到开始回放消息', message);
      if (message.isResume) {
        // 页面刷新后 background 的续跑广播。content 自己的 init 也会走 getReplayState
        // 恢复，两条通道谁先到谁负责，后到的让路，避免重置状态或重复推进
        if (isReplaying) {
          console.log('本地已在回放，忽略续跑广播');
          sendResponse({ success: true, ignored: true });
          break;
        }
        currentTaskName = message.taskName || currentTaskName;
        startReplay(message.recording, message.replayIndex || 0, message.repeatCount || 1, message.repeatInterval, true);
        sendResponse({ success: true });
        break;
      }
      showToast('点击【开始】按钮执行回放。', 2000);
      currentTaskName = message.taskName; // 保存任务名称
      startReplay(message.recording, message.replayIndex || 0, message.repeatCount || 1, message.repeatInterval, false);
      sendResponse({ success: true });
      break;

    case 'stopReplay':
      console.log('收到停止回放消息');
      // 循环模式下 background 会在某一轮结束时也广播停止，
      // 只要还有剩余轮次就忽略，由 content 在轮次边界自己决定何时结束
      if (isLooping && repeatTotal > 1 && repeatCurrent < repeatTotal) {
        console.log('循环尚未跑完，忽略 background 的停止广播');
        sendResponse({ success: true, ignored: true });
        break;
      }
      // 循环全部跑完：保留面板标记完成，不弹报告
      stopReplay(isLooping && repeatTotal > 1);
      sendResponse({ success: true });
      break;

    case 'syncReplayState':
      // background 在页面加载完成时同步状态。
      // 本地正在循环回放时一律以本地轮次为准，不能被 background 的瞬时状态打断。
      if (isReplaying && isLooping && repeatTotal > 1 && repeatCurrent < repeatTotal) {
        console.log('本地循环进行中，忽略状态同步');
        sendResponse({ success: true, ignored: true });
        break;
      }
      if (message.state === 'idle' && isReplaying) {
        console.log('background 已回到 idle，停止本地回放');
        stopReplay();
      }
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

    case 'updateProgress':
      updateControlPanelProgress(message.replayIndex, message.totalSteps);
      sendResponse({ success: true });
      break;

    case 'showDeleteStepsToast':
      showToast(message.message, 5000);
      sendResponse({ success: true });
      break;

    case 'getState':
      sendResponse({
        isRecording: isRecording,
        isReplaying: isReplaying,
        isPaused: isPaused
      });
      break;

    case 'updateTaskDrawer':
      updateTaskDrawer();
      sendResponse({ success: true });
      break;

    case 'openTaskDrawer':
      if (!isTaskDrawerOpen) {
        toggleTaskDrawer();
      }
      sendResponse({ success: true });
      break;
  }

  return true;
}

// 开始录制
function startRecording(recordingName) {
  isRecording = true;
  recordedActions = [];
  currentRecordingName = recordingName; // 保存当前录制名称

  // 记录初始页面加载
  recordAction({
    type: 'pageLoad',
    url: window.location.href,
    timestamp: Date.now()
  });

  // 收起任务抽屉
  if (isTaskDrawerOpen) {
    toggleTaskDrawer();
  }

  // 显示录制状态指示器
  showRecordingIndicator(recordingName);

  // 保存状态
  saveState();

  console.log('开始录制:', recordingName);
}

// 停止录制
function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  recordingStartTime = 0;

  // 隐藏录制状态指示器
  hideRecordingIndicator();

  // 恢复任务抽屉
  if (!isTaskDrawerOpen) {
    toggleTaskDrawer();
  }

  // 停止计时器并重置显示
  stopRecordingTimer();
  const timerDisplay = document.getElementById('recording-timer');
  if (timerDisplay) {
    timerDisplay.textContent = '00:00';
  }

  // 保存状态
  saveState();

  // 清除当前录制名称
  currentRecordingName = '';
  console.log('停止录制, 共记录', recordedActions.length, '个操作');
}

// 开始回放
// isResume: 页面刷新后由 background 重新下发时为 true，此时不能重置轮次计数
function startReplay(actions, startIndex = 0, repeatCount = 1, repeatInterval = 1, isResume = false) {
  if (isReplaying) return;

  isReplaying = true;
  isPaused = false;
  recordedActions = actions;
  replayIndex = startIndex;

  // 初始化循环回放参数
  repeatTotal = Math.max(1, parseInt(repeatCount, 10) || 1);
  // 续跑时保留已完成的轮次，否则页面每刷新一次轮次就被清零 → 循环永不结束
  if (!isResume) {
    repeatCurrent = 0;
  }
  isLooping = repeatTotal > 1;
  loopTaskName = currentTaskName || '';

  // 轮间间隔：秒 → 毫秒；允许 0（不等待），非法/负值回落到 1 秒
  const intervalSec = parseFloat(repeatInterval);
  loopIntervalMs = Number.isFinite(intervalSec) && intervalSec >= 0 ? intervalSec * 1000 : 1000;

  // 收起任务抽屉
  if (isTaskDrawerOpen) {
    toggleTaskDrawer();
  }

  // 创建鼠标指针
  createMousePointer();

  saveState();

  console.log('开始回放, 共', recordedActions.length, '个操作，从索引', replayIndex, '开始',
    isLooping ? `，循环 ${repeatTotal} 轮` : '');

  // 创建回放控制面板
  createControlPanel();

  if (isResume) {
    // 刷新后续跑：只有用户从未点过【开始】时才保持暂停，其余情况自动继续，
    // 否则循环任务每次页面刷新后都会卡在「等待点开始」
    chrome.storage.local.get(['replayAwaitingStart'], function (d) {
      if (d.replayAwaitingStart) {
        console.log('刷新后恢复回放，仍在等待用户点【开始】');
        pauseReplay();
      } else {
        console.log('刷新后续跑回放，从索引', replayIndex, '继续');
        replayNextAction();
      }
    });
  } else {
    // 全新启动：暂停等待用户点【开始】
    pauseReplay();
  }
}

// 停止回放
// loopsFinished: 循环回放「所有轮次都跑完」时由 enterNextLoopRound 传入 true；
//               此时保留控制面板并标记完成、不弹执行报告
function stopReplay(loopsFinished = false) {
  console.log('执行停止回放，当前状态:', isReplaying, isPaused, 'loopsFinished:', loopsFinished);

  if (!isReplaying) return;

  // 记录本轮是否是「循环全部跑完」——需要在清空 isLooping 之前判断
  const keepPanel = loopsFinished && isLooping && repeatTotal > 1;
  const finishedRounds = repeatCurrent;
  // 是否处于循环回放、以及是否是被用户/收尾主动结束，都要在清空状态前记下来
  const wasLooping = isLooping && repeatTotal > 1;
  const isFinalStop = loopsFinished || !wasLooping;

  isReplaying = false;
  isPaused = false;

  // 清除循环回放状态
  isLooping = false;
  repeatCurrent = 0;
  loopTaskName = '';
  pendingRoundStart = false;

  if (replayTimeout) {
    clearTimeout(replayTimeout);
    replayTimeout = null;
  }
  if (replayWaitTimer) {
    clearInterval(replayWaitTimer);
    replayWaitTimer = null;
  }

  // 如果有上次悬停的元素，触发鼠标离开事件
  if (lastHoveredElement) {
    simulateMouseEvent(lastHoveredElement, 'mouseout');
    simulateMouseEvent(lastHoveredElement, 'mouseleave');
    lastHoveredElement = null;
  }

  // 移除控制面板（循环跑完时保留，只标记完成状态）
  if (keepPanel) {
    markControlPanelFinished(finishedRounds);
  } else {
    removeControlPanel();
  }

  // 移除鼠标指针
  removeMousePointer();

  // 恢复任务抽屉
  if (!isTaskDrawerOpen) {
    toggleTaskDrawer();
  }

  // 清除本地存储中的回放状态
  chrome.storage.local.remove(['isReplaying', 'isPaused', 'replayIndex', 'isLooping', 'repeatCurrent', 'loopTaskName', 'replayAwaitingStart'], function () {
    console.log('已清除本地存储中的回放状态');
  });

  // 通知 background 停止回放。
  // content 走到这里都是确定性收尾（用户点结束 / 全部轮次跑完 / 收到停止通知），
  // 必须带 force 让 background 真正停止；否则用户中途结束后 background 仍认为
  // 「循环未跑完」保持 replaying，下次页面加载会把回放复活。
  // background 已是 idle 时收到该消息会直接忽略，无副作用。
  chrome.runtime.sendMessage({
    action: 'stopReplay',
    finished: isFinalStop,
    force: true
  }, function (response) {
    console.log('通知 background 停止回放:', response);
  });

  saveState();

  console.log('停止回放完成');

  // 循环回放跑完不弹执行报告，只在面板上标记完成
  if (!keepPanel) {
    showReplayReport();
  }
}

// 暂停回放
function pauseReplay() {
  if (!isReplaying || isPaused) return;

  isPaused = true;
  // 暂停状态应该保存到本地存储 getReplayState
  saveState();

  if (replayTimeout) {
    clearTimeout(replayTimeout);
    replayTimeout = null;
  }
  // 停掉元素等待轮询，暂停期间不再推进
  if (replayWaitTimer) {
    clearInterval(replayWaitTimer);
    replayWaitTimer = null;
  }

  updateControlPanel();

  console.log('暂停回放');
}

// 继续回放
function resumeReplay() {
  if (!isReplaying || !isPaused) return;

  isPaused = false;

  updateControlPanel();

  console.log('继续回放');

  if (pendingRoundStart) {
    // 暂停发生在轮间间隔内：本轮已计入 repeatCurrent，
    // 恢复时重新调度进入下一轮即可，不能再次累加轮次
    if (replayTimeout) {
      clearTimeout(replayTimeout);
    }
    replayTimeout = setTimeout(enterNextLoopRound, loopIntervalMs);
  } else {
    // 继续执行下一个操作
    replayNextAction();
  }

  // 用户已正式开始回放，之后页面刷新一律自动续跑
  chrome.storage.local.remove('replayAwaitingStart');

  saveState();
}

// 步进回放（执行下一步）
function stepReplay() {
  if (!isReplaying || !isPaused) return;

  console.log('步进回放');

  // 执行一步操作，但保持暂停状态
  const currentAction = recordedActions[replayIndex];
  if (!currentAction) return;

  // 通知background更新进度
  chrome.runtime.sendMessage({
    action: 'updateReplayIndex',
    replayIndex: replayIndex + 1
  });

  replayIndex++;

  // 更新控制面板
  updateControlPanel();

  console.log('步进执行操作:', currentAction.type, replayIndex, '/', recordedActions.length);

  // 执行操作
  try {
    switch (currentAction.type) {
      case 'click':
        replayClick(currentAction, true);
        break;

      case 'input':
        replayInput(currentAction, true);
        break;

      case 'keydown':
        replayKeydown(currentAction, true);
        break;

      case 'submit':
        replaySubmit(currentAction, true);
        break;

      case 'scroll':
        replayScroll(currentAction);
        break;

      case 'pageLoad':
        // 检查URL是否匹配
        if (currentAction.url !== window.location.href) {
          console.log('页面URL不匹配，导航到:', currentAction.url);
          window.location.href = currentAction.url;
          return; // 等待页面加载完成后继续
        }
        break;

      case 'pageRefresh':
        console.log('执行页面刷新');
        window.location.reload();
        return; // 等待页面加载完成后继续

      default:
        console.warn('未知操作类型:', currentAction.type);
    }
  } catch (error) {
    console.error('步进回放操作失败:', error);
  }

  saveState();
}

// 创建并显示轻量级提示的函数
function showToast(message, time_length = 2000) {
  console.warn("弱提示:", message)
  // 检查是否已存在toast元素
  let toast = document.getElementById('relax-toast');
  if (!toast) {
    // 创建toast元素
    toast = document.createElement('div');
    toast.id = 'relax-toast';
    toast.style.cssText = `
          position: fixed;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          background-color: rgba(0, 0, 0, 0.7);
          color: white;
          padding: 10px 20px;
          border-radius: 4px;
          z-index: 10000;
          font-size: 14px;
          transition: opacity 0.3s ease-in-out;
          pointer-events: none;
        `;
    document.body.appendChild(toast);
  }

  // 更新消息
  toast.textContent = message;
  toast.style.opacity = '1';

  // 3秒后自动消失
  clearInterval(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, time_length);
}

// 等待目标元素就绪：200ms 粒度轮询，元素出现在 DOM 且可见才回调。
// XPath 失配时退回用录制时存的 text 按文本找（click/input 也用上）。
// 默认最多等 3 秒（不再像以前 click 等 10 秒、input 只等 3 次）。
// 暂停/停止时自动停掉轮询，不会在后台继续推进。
function waitForElement(action, callback, timeoutMs, textTagName) {
  const maxWait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
  const intervalMs = 200;
  const start = Date.now();

  if (replayWaitTimer) {
    clearInterval(replayWaitTimer);
    replayWaitTimer = null;
  }

  const probe = function () {
    // 暂停或已停止：停掉轮询，不触发回调（恢复时由 resumeReplay 重新推进）
    if (!isReplaying || isPaused) {
      clearInterval(replayWaitTimer);
      replayWaitTimer = null;
      return;
    }
    let el = querySelector(action.selector);
    // 主选择器（可能是动态 id）失配 → 用录制时存的结构化 XPath 兜底
    if (!el && action.fallbackSelector) {
      el = querySelector(action.fallbackSelector);
    }
    // 结构也失配（页面布局变了）→ 按「class + 同类序号」兜底，
    // 对勾选框图标这类无 id 无文本的元素最有效
    if (!el && action.fallbackClass && action.fallbackClass.selector) {
      try {
        const list = document.querySelectorAll(action.fallbackClass.selector);
        const cand = list[action.fallbackClass.index];
        if (cand) el = cand;
      } catch (e) {}
    }
    // 再失配 → 用录制时存的文本兜底找（submit 限定 form 标签）
    if (!el && action.text && action.text.trim()) {
      el = findElementByText(action.text, textTagName || null);
    }
    if (el && isElementVisible(el)) {
      clearInterval(replayWaitTimer);
      replayWaitTimer = null;
      callback(el);
      return;
    }
    if (Date.now() - start >= maxWait) {
      clearInterval(replayWaitTimer);
      replayWaitTimer = null;
      callback(null);
    }
  };

  replayWaitTimer = setInterval(probe, intervalMs);
  probe(); // 立即探一次，元素已就绪就不必等
}

// 统一的「未找到元素」收尾：循环模式跳过本轮，非循环模式跳过该步继续
function handleElementNotFound(action, isStepMode) {
  elementNotFoundCount += 1;
  if (isStepMode) return;
  const reason = `未找到元素 ${getElementDescription(action.text || action.selector)}`;
  if (!skipCurrentRound(reason)) {
    showToast(`${reason}，已跳过该步骤`, 3000);
    scheduleNextAction(500);
  }
}

// 回放点击操作
function replayClick(action, isStepMode = false) {
  console.log('回放点击操作:', action.selector);

  waitForElement(action, function (element) {
    if (!isReplaying || isPaused) return;
    try {
      if (!element) {
        handleElementNotFound(action, isStepMode);
        return;
      }
      highlightElement(element);

      if (!isElementVisible(element)) {
        // 极端情况：元素在 DOM 但不可见，滚动后重试定位
        console.log('元素不可见，尝试滚动到元素');
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function () {
          if (!isReplaying || isPaused) return;
          const rect = element.getBoundingClientRect();
          moveMousePointer(rect.left + rect.width / 2, rect.top + rect.height / 2, function () {
            simulateClick(element);
            if (!isStepMode) {
              scheduleNextAction(500);
            }
          });
        }, 500);
        return;
      }

      simulateClick(element);
      if (!isStepMode) {
        scheduleNextAction(500);
      }
    } catch (error) {
      console.error('回放点击操作出错:', error);
      if (!isStepMode) {
        scheduleNextAction(1000);
      }
    }
  });
}

// 修改 simulateClick 函数，处理 readonly 输入框
function simulateClick(element) {
  // 检查元素是否是只读输入框
  const isReadonlyInput = (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && element.hasAttribute('readonly');

  // 如果是只读输入框，临时移除 readonly 属性
  let originalReadonly = null;
  if (isReadonlyInput) {
    originalReadonly = element.getAttribute('readonly');
    element.removeAttribute('readonly');
  }

  // 创建并分发鼠标事件
  const mouseDown = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    view: window
  });

  const mouseUp = new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
    view: window
  });

  const click = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window
  });

  // 聚焦元素
  element.focus();
  element.dispatchEvent(mouseDown);
  element.dispatchEvent(mouseUp);
  element.dispatchEvent(click);

  // // 如果是只读输入框，恢复 readonly 属性
  // if (isReadonlyInput && originalReadonly !== null) {
  //   element.setAttribute('readonly', originalReadonly);
  // }
}

// 回放输入操作
function replayInput(action, isStepMode = false) {
  console.log('回放输入操作:', action.selector, action.value);

  waitForElement(action, function (element) {
    if (!isReplaying || isPaused) return;
    try {
      if (!element) {
        handleElementNotFound(action, isStepMode);
        return;
      }
      highlightElement(element);

      if (!isElementVisible(element)) {
        console.log('元素不可见，尝试滚动到元素');
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function () {
          if (!isReplaying || isPaused) return;
          const rect = element.getBoundingClientRect();
          moveMousePointer(rect.left + rect.width / 2, rect.top + rect.height / 2, function () {
            element.focus();
            simulateInput(element, action.value);
            if (!isStepMode) {
              scheduleNextAction(500);
            }
          });
        }, 500);
        return;
      }

      element.focus();
      simulateInput(element, action.value);
      if (!isStepMode) {
        scheduleNextAction(500);
      }
    } catch (error) {
      console.error('回放输入操作出错:', error);
      if (!isStepMode) {
        scheduleNextAction(1000);
      }
    }
  });
}

// 修改 simulateInput 函数，处理 readonly 输入框
function simulateInput(element, value) {
  // 检查元素是否是只读输入框
  const isReadonlyInput = (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && element.hasAttribute('readonly');

  // 如果是只读输入框，临时移除 readonly 属性
  let originalReadonly = null;
  if (isReadonlyInput) {
    originalReadonly = element.getAttribute('readonly');
    element.removeAttribute('readonly');
  }

  // 设置元素值
  element.value = value;

  // 创建并分发输入事件
  const inputEvent = new Event('input', {
    bubbles: true,
    cancelable: true
  });

  const changeEvent = new Event('change', {
    bubbles: true,
    cancelable: true
  });

  element.dispatchEvent(inputEvent);
  element.dispatchEvent(changeEvent);

  // // 如果是只读输入框，恢复 readonly 属性
  // if (isReadonlyInput && originalReadonly !== null) {
  //   element.setAttribute('readonly', originalReadonly);
  // }
}

// 回放键盘按键操作
function replayKeydown(action, isStepMode = false) {
  console.log('回放键盘按键:', action.key, action.selector);

  waitForElement(action, function (element) {
    if (!isReplaying || isPaused) return;
    try {
      if (!element) {
        handleElementNotFound(action, isStepMode);
        return;
      }
      highlightElement(element);

      // 只读输入框临时去 readonly
      const isReadonlyInput = (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && element.hasAttribute('readonly');
      let originalReadonly = null;
      if (isReadonlyInput) {
        originalReadonly = element.getAttribute('readonly');
        element.removeAttribute('readonly');
      }

      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', {
        key: action.key,
        code: action.code,
        ctrlKey: action.ctrlKey || false,
        altKey: action.altKey || false,
        shiftKey: action.shiftKey || false,
        metaKey: action.metaKey || false,
        bubbles: true,
        cancelable: true
      }));

      // Enter 键触发所在表单提交
      if (action.key === 'Enter') {
        const form = element.closest('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      }

      if (!isStepMode) {
        scheduleNextAction(500);
      }
    } catch (error) {
      console.error('回放键盘操作出错:', error);
      if (!isStepMode) {
        scheduleNextAction(1000);
      }
    }
  });
}

// 回放表单提交操作
function replaySubmit(action, isStepMode = false) {
  console.log('回放表单提交:', action.selector);

  // text 兜底限定 form 标签
  waitForElement(action, function (form) {
    if (!isReplaying || isPaused) return;
    try {
      if (!form) {
        handleElementNotFound(action, isStepMode);
        return;
      }
      highlightElement(form);

      const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(submitEvent);
      if (!submitEvent.defaultPrevented) {
        form.submit();
      }
      // 不立即调度下一个操作，等待页面加载
    } catch (error) {
      console.error('回放提交操作出错:', error);
      if (!isStepMode) {
        scheduleNextAction(1000);
      }
    }
  }, undefined, 'form');
}

// 回放滚动操作
function replayScroll(action) {
  window.scrollTo(action.scrollX, action.scrollY);
  scheduleNextAction(500);
}

// 安排下一个操作
function scheduleNextAction(delay) {
  if (replayTimeout) {
    clearTimeout(replayTimeout);
  }

  replayTimeout = setTimeout(replayNextAction, delay);
}

// 高亮显示元素（视觉反馈）
function highlightElement(element) {
  const originalOutline = element.style.outline;
  const originalBoxShadow = element.style.boxShadow;

  element.style.outline = '2px solid red';
  element.style.boxShadow = '0 0 10px rgba(255, 0, 0, 0.5)';

  setTimeout(() => {
    element.style.outline = originalOutline;
    element.style.boxShadow = originalBoxShadow;
  }, 500);
}

// 记录操作
function recordAction(action) {
  recordedActions.push(action);

  // 发送操作到background
  chrome.runtime.sendMessage({
    action: 'recordAction',
    recordedAction: action
  });

  saveState();
}

// 保存当前状态到storage
function saveState() {
  chrome.storage.local.set({
    isRecording: isRecording,
    isReplaying: isReplaying,
    isPaused: isPaused,
    replayIndex: replayIndex,
    pageLoadCount: pageLoadCount,
    recordingName: currentRecordingName,
    recordingStartTime: recordingStartTime, // 保存录制开始时间
    // 循环回放状态，跨页面刷新保留
    repeatTotal: repeatTotal,
    repeatCurrent: repeatCurrent,
    isLooping: isLooping,
    loopTaskName: loopTaskName
  });
}

// 获取元素的唯一选择器
function getSelector(element) {
  if (!element || element === document || element === document.documentElement) {
    return null;
  }

  // 直接使用getXPath函数生成XPath
  return getXPath(element);
}

// 检查辅助UI元素
function isHelperElement(element) {
  if (!element) {
    return false
  }
  if (
    element.id === 'recording-indicator' ||
    element.className === 'mode-switch-button' ||
    element.id === 'task-drawer' ||
    element.id === 'replay-mouse-pointer' ||
    element.id === 'relax-toast' ||
    element.id === 'replay-control-panel' ||
    element.id === 'task-list-container') {
    return true
  }
  return false
}


// 获取元素的XPath
function getXPath(element) {
  if (!element) return null;
  console.log('获取元素的XPath:', element)

  // 如果元素有ID，直接使用ID
  if (element.id) {
    return `/html/body//*[@id="${element.id}"]`;
  }

  return getXPathStructural(element);
}

// 不走 id 捷径，始终按 DOM 结构生成位置 XPath。
// 用途：当元素有 id（选择器走的是 id 路径）时，额外记一份结构化兜底，
// 万一 id 是动态的（如 fly7、ember42 这种每渲染就变的）回放时还能按位置定位。
function getXPathStructural(element) {
  if (!element) return null;
  const paths = [];
  let el = element;
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    let index = 0;
    let currentIndex = 0;
    let hasMatchingSibling = false;
    let sibling = el.parentNode ? el.parentNode.firstChild : null;

    // 遍历所有同级元素
    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE &&
        sibling.tagName === el.tagName) {
        if (!isHelperElement(sibling)) {
          currentIndex++;
          if (sibling === el) {
            index = currentIndex;
            hasMatchingSibling = true;
          }
        }
      }
      sibling = sibling.nextSibling;
    }

    const tagName = el.tagName.toLowerCase();
    // 只有当存在匹配的同级元素时才添加索引
    const pathIndex = hasMatchingSibling ? `[${index}]` : '';
    paths.unshift(tagName + pathIndex);

    // 如果到达了body标签，就停止
    if (tagName === 'body') {
      paths.unshift('html');
      break;
    }

    el = el.parentNode;
  }

  return '/' + paths.join('/');
}

// 当主选择器走的是 id 路径时，返回一份结构化 XPath 作为兜底；否则不需要
function getFallbackSelector(element) {
  if (element && element.id) {
    return getXPathStructural(element);
  }
  return null;
}

// 按 class + 序号兜底：对没有稳定 id、没有文本、结构又动态的元素（比如
// 邮件勾选框图标 <b class="nui-ico-checkbox">），用「同类里的第 N 个」来定位。
// 回放时 document.querySelectorAll(selector)[index] 取回它。
function getClassFallback(element) {
  if (!element || !element.className) return null;
  const cls = element.className.toString().trim();
  if (!cls) return null;
  const tokens = cls.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const selector = '.' + tokens.join('.');
  try {
    const all = document.querySelectorAll(selector);
    if (!all.length) return null;
    const idx = Array.prototype.indexOf.call(all, element);
    if (idx < 0) return null;
    return { selector: selector, index: idx, total: all.length };
  } catch (e) {
    return null;
  }
}

// 根据选择器查找元素
function querySelector(selector) {
  // 只使用XPath定位
  return getElementByXPath(selector);
}

// 根据XPath查找元素
function getElementByXPath(xpath) {
  try {
    // 检查是否是带id的xpath选择器
    if (xpath.includes('@id=')) {
      // 对带id的xpath使用document.evaluate
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue;
    }

    // 解析XPath路径
    const parts = xpath.split('/');
    // 移除空字符串
    parts.shift();

    let currentNode = document;

    for (let part of parts) {
      if (!part) continue;

      // 处理html和body标签
      if (part === 'html') {
        currentNode = document.documentElement;
        continue;
      }
      if (part === 'body') {
        currentNode = document.body;
        continue;
      }

      // 解析标签名和索引
      const match = part.match(/([^\[]+)(?:\[(\d+)\])?/);
      if (!match) continue;

      const [, tagName, index] = match;
      const targetIndex = index ? parseInt(index) : 1;

      // 获取所有匹配的子元素
      let matchingElements = [];
      let currentIndex = 0;

      for (let child of currentNode.children) {
        // 排除辅助UI元素
        if (isHelperElement(child)) {
          continue;
        }

        if (child.tagName.toLowerCase() === tagName.toLowerCase()) {
          currentIndex++;
          if (currentIndex === targetIndex) {
            currentNode = child;
            break;
          }
        }
      }

      // 如果没有找到匹配的元素，返回null
      if (currentIndex < targetIndex) {
        return null;
      }
    }

    return currentNode === document ? null : currentNode;
  } catch (e) {
    console.error('无效的XPath:', xpath, e);
    return null;
  }
}

// 获取元素的文本内容，超过10个字的只记录前10个字
function getElementText(element) {
  if (!element) return '';

  let text = '';

  // 对于输入框和文本区域，获取value或placeholder
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    console.warn("输入框", element.tagName, "文本", element.value, "placeholder:", element.getAttribute('placeholder'))
    text = element.value || element.getAttribute('placeholder') || '';
  }
  // 对于选择框，获取选中选项的文本
  else if (element.tagName === 'SELECT' && element.selectedIndex >= 0) {
    text = element.options[element.selectedIndex].text || '';
  }
  // 对于其他元素，获取innerText或textContent
  else {
    text = element.innerText || element.textContent || '';
  }

  // 去除空白字符
  text = text.trim();

  // 超过10个字的只记录前10个字
  if (text.length > 10) {
    text = text.substring(0, 10);
  }

  return text;
}

// 通过文本内容查找元素
function findElementByText(text, tagName = null) {
  if (!text || text.trim() === '') return null;

  text = text.trim().toLowerCase();

  // 创建XPath查询
  let xpath = '';
  if (tagName) {
    // 如果指定了标签名
    xpath = `//${tagName}[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${text}')]`;
  } else {
    // 查找任何包含该文本的元素
    xpath = `//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${text}')]`;
  }

  try {
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );

    // 遍历找到的元素，找到最匹配的
    let bestMatch = null;
    let bestScore = 0;

    for (let i = 0; i < result.snapshotLength; i++) {
      const element = result.snapshotItem(i);
      const elementText = (element.innerText || element.textContent || '').trim().toLowerCase();

      // 计算匹配分数 (简单实现，可以根据需要改进)
      let score = 0;
      if (elementText === text) {
        score = 100; // 完全匹配
      } else if (elementText.startsWith(text)) {
        score = 80; // 前缀匹配
      } else if (elementText.includes(text)) {
        score = 60; // 包含匹配
      }

      // 检查元素是否可见和可交互
      if (score > 0 && isElementVisible(element)) {
        score += 20; // 可见元素加分
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = element;
      }
    }

    // 如果没有找到文本匹配，尝试查找value属性匹配的输入元素
    if (!bestMatch) {
      const inputXpath = `//input[@value and contains(translate(@value, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${text}')]`;
      const inputResult = document.evaluate(
        inputXpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      bestMatch = inputResult.singleNodeValue;
    }

    return bestMatch;
  } catch (e) {
    console.error('通过文本查找元素失败:', e);
    return null;
  }
}

// 检查元素是否可见
function isElementVisible(element) {
  if (!element) return false;

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }

  return true;
}

// 继续回放（页面刷新后）
function continueReplay() {
  if (!isReplaying) return;

  console.log('页面刷新后继续回放，从索引', replayIndex);

  // 跳过pageRefresh操作
  if (replayIndex < recordedActions.length &&
    recordedActions[replayIndex].type === 'pageRefresh') {
    // 通知background更新进度
    chrome.runtime.sendMessage({
      action: 'updateReplayIndex',
      replayIndex: replayIndex + 1
    });

    replayIndex++;
  }

  // 如果是暂停状态，不自动继续
  if (!isPaused) {
    replayNextAction();
  }
}

// 创建回放控制面板
function createControlPanel() {
  // 如果已经存在控制面板，先移除
  removeControlPanel();

  // 创建控制面板容器
  controlPanel = document.createElement('div');
  controlPanel.id = 'replay-control-panel';
  controlPanel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 300px;
    background-color: rgba(255, 255, 255, 0.9);
    border: 1px solid #ccc;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.2);
    padding: 10px;
    z-index: 9999;
    font-family: Arial, sans-serif;
    font-size: 14px;
  `;

  // 创建标题
  const title = document.createElement('div');
  title.style.cssText = `
    font-weight: bold;
    margin-bottom: 10px;
    text-align: center;
    font-size: 16px;
  `;
  title.textContent = "回放控制面板";
  controlPanel.appendChild(title);

  // 创建进度条容器
  const progressContainer = document.createElement('div');
  progressContainer.style.cssText = `
    width: 100%;
    height: 20px;
    background-color: #f0f0f0;
    border-radius: 10px;
    margin-bottom: 10px;
    overflow: hidden;
  `;

  // 创建进度条
  const progressBar = document.createElement('div');
  progressBar.id = 'replay-progress-bar';
  progressBar.style.cssText = `
    height: 100%;
    width: 0%;
    background-color: #4285f4;
    border-radius: 10px;
    transition: width 0.3s;
  `;
  progressContainer.appendChild(progressBar);
  controlPanel.appendChild(progressContainer);

  // 创建进度文本
  const progressText = document.createElement('div');
  progressText.id = 'replay-progress-text';
  progressText.style.cssText = `
    text-align: center;
    margin-bottom: 10px;
  `;
  progressText.textContent = `0 / ${recordedActions.length}`;
  controlPanel.appendChild(progressText);

  // 创建循环轮次文本（非循环模式下隐藏）
  const repeatText = document.createElement('div');
  repeatText.id = 'replay-repeat-text';
  repeatText.style.cssText = `
    text-align: center;
    margin-bottom: 10px;
    font-weight: bold;
    color: #d46b08;
    display: none;
  `;
  controlPanel.appendChild(repeatText);

  // 创建按钮容器
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = `
    display: flex;
    justify-content: space-between;
    margin-bottom: 10px;
  `;

  // 创建暂停/继续按钮
  const pauseResumeButton = document.createElement('button');
  pauseResumeButton.id = 'replay-pause-resume-button';
  pauseResumeButton.style.cssText = `
    padding: 5px 10px;
    background-color: #4285f4;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    flex: 1;
    margin-right: 5px;
  `;

  if (isPaused) {
    if (replayIndex === 0) {
      pauseResumeButton.textContent = '开始';
      // pauseResumeButton.style.backgroundColor = '#66CC66';
    } else {
      pauseResumeButton.textContent = '继续播放';
    }
  } else {
    pauseResumeButton.textContent = '暂停';
  }
  if (pauseResumeButton.textContent === '开始') {
    pauseResumeButton.style.backgroundColor = '#66CC66';
  } else {
    pauseResumeButton.style.backgroundColor = '#4285f4';
  }

  // pauseResumeButton.textContent = isPaused ? '开始' : '暂停';
  pauseResumeButton.addEventListener('click', function () {
    if (isPaused) {
      resumeReplay();
    } else {
      pauseReplay();
    }
  });
  buttonContainer.appendChild(pauseResumeButton);

  // 创建步进按钮
  const stepButton = document.createElement('button');
  stepButton.id = 'replay-step-button';
  stepButton.style.cssText = `
    padding: 5px 10px;
    background-color: #4285f4;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    flex: 1;
    margin-right: 5px;
  `;
  stepButton.textContent = '单步调试';
  stepButton.addEventListener('click', function () {
    stepReplay();
  });
  buttonContainer.appendChild(stepButton);

  // 创建停止按钮
  const stopButton = document.createElement('button');
  stopButton.style.cssText = `
    padding: 5px 10px;
    background-color: #ea4335;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    flex: 1;
  `;
  stopButton.textContent = '结束';
  stopButton.addEventListener('click', function () {
    // 循环已跑完时 isReplaying 为 false，stopReplay 会直接返回，
    // 此时按钮的作用是关闭这个完成了的面板
    if (!isReplaying) {
      removeControlPanel();
      return;
    }
    stopReplay();
  });
  buttonContainer.appendChild(stopButton);

  controlPanel.appendChild(buttonContainer);

  // 创建即将执行的操作列表标题
  const upcomingTitle = document.createElement('div');
  upcomingTitle.style.cssText = `
    font-weight: bold;
    margin-bottom: 5px;
  `;
  upcomingTitle.textContent = '即将执行的操作:';
  controlPanel.appendChild(upcomingTitle);

  // 创建即将执行的操作列表
  const upcomingActions = document.createElement('div');
  upcomingActions.id = 'replay-upcoming-actions';
  upcomingActions.style.cssText = `
    max-height: 100px;
    overflow-y: auto;
    border: 1px solid #ddd;
    border-radius: 3px;
    padding: 5px;
    background-color: #f9f9f9;
  `;
  controlPanel.appendChild(upcomingActions);

  // 添加到页面
  document.body.appendChild(controlPanel);

  // 更新控制面板
  updateControlPanel();
}

// 更新回放控制面板
function updateControlPanel() {
  if (!controlPanel) return;

  // 更新进度条
  const progressBar = document.getElementById('replay-progress-bar');
  if (progressBar) {
    const progress = (replayIndex / recordedActions.length) * 100;
    progressBar.style.width = `${progress}%`;
  }

  // 更新进度文本
  const progressText = document.getElementById('replay-progress-text');
  if (progressText) {
    progressText.textContent = `${replayIndex} / ${recordedActions.length}`;
  }

  // 更新循环轮次显示
  const repeatText = document.getElementById('replay-repeat-text');
  if (repeatText) {
    if (isLooping && repeatTotal > 1) {
      repeatText.style.display = 'block';
      // repeatCurrent 是「已完成的轮次」，当前正在跑的是 repeatCurrent + 1
      const running = Math.min(repeatCurrent + 1, repeatTotal);
      // 间隔按可读形式展示（整秒不显示小数）
      const intervalText = loopIntervalMs % 1000 === 0
        ? `${loopIntervalMs / 1000} 秒`
        : `${(loopIntervalMs / 1000).toFixed(1)} 秒`;
      repeatText.textContent = `循环第 ${running} / ${repeatTotal} 轮（间隔 ${intervalText}）`;
    } else {
      repeatText.style.display = 'none';
    }
  }

  // 更新暂停/继续按钮
  const pauseResumeButton = document.getElementById('replay-pause-resume-button');
  if (pauseResumeButton) {
    if (isPaused) {
      if (replayIndex === 0) {
        pauseResumeButton.textContent = '开始';
        // pauseResumeButton.style.backgroundColor = '#66CC66';
      } else {
        pauseResumeButton.textContent = '继续播放';
      }
    } else {
      pauseResumeButton.textContent = '暂停';
    }
    if (pauseResumeButton.textContent === '开始') {
      pauseResumeButton.style.backgroundColor = '#66CC66';
    } else {
      pauseResumeButton.style.backgroundColor = '#4285f4';
    }
    // pauseResumeButton.textContent = isPaused ? '继续' : '暂停';
  }

  // 更新步进按钮
  const stepButton = document.getElementById('replay-step-button');
  if (stepButton) {
    // 在非暂停状态下禁用步进按钮
    if (!isPaused) {
      stepButton.disabled = true;
      stepButton.style.backgroundColor = '#cccccc';
      stepButton.style.cursor = 'not-allowed';
    } else {
      stepButton.disabled = false;
      stepButton.style.backgroundColor = '#4285f4';
      stepButton.style.cursor = 'pointer';
    }
  }

  // 更新即将执行的操作列表
  updateUpcomingActions();
}

// 更新控制面板进度（由background调用）
function updateControlPanelProgress(index, totalSteps) {
  if (!controlPanel) return;

  // 更新进度条
  const progressBar = document.getElementById('replay-progress-bar');
  if (progressBar) {
    const progress = (index / totalSteps) * 100;
    progressBar.style.width = `${progress}%`;
  }

  // 更新进度文本
  const progressText = document.getElementById('replay-progress-text');
  if (progressText) {
    progressText.textContent = `${index} / ${totalSteps}`;
  }
}

// 更新即将执行的操作列表
function updateUpcomingActions() {
  const upcomingActions = document.getElementById('replay-upcoming-actions');
  if (!upcomingActions) return;

  upcomingActions.innerHTML = '';

  // 计算显示范围：当前位置前后各5个操作
  const prevCount = 5;
  const nextCount = 5;
  const startIndex = Math.max(0, replayIndex - prevCount);
  const endIndex = Math.min(replayIndex + nextCount, recordedActions.length);

  if (startIndex < endIndex) {
    for (let i = startIndex; i < endIndex; i++) {
      const action = recordedActions[i];
      const actionItem = document.createElement('div');
      actionItem.style.cssText = `
        padding: 8px;
        border-bottom: 1px solid #eee;
        background-color: ${i === replayIndex ? '#f0f7ff' : 'transparent'};
        ${i === replayIndex ? 'font-weight: bold;' : ''}
        display: flex;
        justify-content: space-between;
        align-items: center;
      `;

      const actionContent = document.createElement('div');
      actionContent.style.flexGrow = '1';

      let actionText = '';
      switch (action.type) {
        case 'click':
          actionText = `点击: ${action.text || getElementDescription(action.selector)}`;
          break;
        case 'input':
          actionText = `输入: ${action.text || action.value || getElementDescription(action.selector)}`;
          break;
        case 'keydown':
          actionText = `按键: ${action.key || action.code} (${action.text || getElementDescription(action.selector)})`;
          break;
        case 'submit':
          actionText = `提交表单: ${action.text || getElementDescription(action.selector)}`;
          break;
        case 'scroll':
          actionText = `滚动页面`;
          break;
        case 'pageLoad':
          actionText = `加载页面: ${action.url}`;
          break;
        case 'pageRefresh':
          actionText = `刷新页面`;
          break;
        default:
          actionText = `${action.type}`;
      }

      actionContent.textContent = `${i + 1}. ${actionText}`;
      actionItem.appendChild(actionContent);

      const deleteButton = document.createElement('button');
      deleteButton.style.cssText = `
        padding: 4px 8px;
        margin-left: 8px;
        background-color:rgb(252, 156, 156);
        color: white;
        border: none;
        border-radius: 30%;
        cursor: pointer;
        font-size: 10px;
      `;
      deleteButton.textContent = 'x';
      chrome.storage.local.get(['deleteIndexes'], function (result) {
        let deleteIndexes = result.deleteIndexes || [];
        if (deleteIndexes.includes(i)) {
          actionItem.style.opacity = '0.3';
          actionItem.style.textDecoration = 'line-through';
        }
      });

      // todo 如果操作已经被删除，则现实为 opacity = '0.5' 删除状态
      deleteButton.onclick = () => {
        // 从localStorage获取待删除索引列表
        chrome.storage.local.get(['deleteIndexes'], function (result) {
          let deleteIndexes = result.deleteIndexes || [];
          // 添加当前索引到待删除列表
          if (!deleteIndexes.includes(i)) {
            deleteIndexes.push(i);
            // 保存更新后的待删除列表
            chrome.storage.local.set({ deleteIndexes: deleteIndexes }, function () {
              console.log('新增待删除的索引:', i, deleteIndexes);
            });
            // 更新UI显示
            actionItem.style.opacity = '0.3';
            actionItem.style.textDecoration = 'line-through';
            // deleteButton.disabled = true;
          } else {
            deleteIndexes = removeValue(deleteIndexes, i)
            // 保存更新后的待删除列表
            chrome.storage.local.set({ deleteIndexes: deleteIndexes }, function () {
              console.log('移除待删除的索引:', i, deleteIndexes);
            });
            // 更新UI显示
            actionItem.style.opacity = '1';
            actionItem.style.textDecoration = 'none';
          }
        });
      };
      actionItem.appendChild(deleteButton);
      upcomingActions.appendChild(actionItem);

      // 自动滚动到当前执行的操作
      if (i === replayIndex) {
        actionItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  } else {
    const noActions = document.createElement('div');
    noActions.style.padding = '3px';
    noActions.textContent = '没有更多操作';
    upcomingActions.appendChild(noActions);
  }
}

// 移除回放控制面板
function removeControlPanel() {
  const existingPanel = document.getElementById('replay-control-panel');
  if (existingPanel) {
    existingPanel.remove();
  }
  controlPanel = null;
}

// 循环跑完：保留控制面板，把它标记为完成状态
function markControlPanelFinished(finishedRounds) {
  if (!controlPanel) return;

  // 标题改为完成提示（标题是面板的第一个子 div）
  const title = controlPanel.querySelector('div');
  if (title) {
    title.textContent = `✅ 已完成 ${finishedRounds} 轮`;
    title.style.color = '#52c41a';
  }

  // 轮次文本显示完成态
  const repeatText = document.getElementById('replay-repeat-text');
  if (repeatText) {
    repeatText.style.display = 'block';
    repeatText.textContent = `循环完成：${finishedRounds} / ${repeatTotal} 轮`;
  }

  // 进度条拉满
  const progressBar = document.getElementById('replay-progress-bar');
  if (progressBar) {
    progressBar.style.width = '100%';
    progressBar.style.backgroundColor = '#52c41a';
  }

  // 已完成状态下暂停/单步按钮失去意义，置灰
  const pauseResumeButton = document.getElementById('replay-pause-resume-button');
  if (pauseResumeButton) {
    pauseResumeButton.textContent = '已完成';
    pauseResumeButton.disabled = true;
    pauseResumeButton.style.backgroundColor = '#cccccc';
    pauseResumeButton.style.cursor = 'not-allowed';
  }

  const stepButton = document.getElementById('replay-step-button');
  if (stepButton) {
    stepButton.disabled = true;
    stepButton.style.backgroundColor = '#cccccc';
    stepButton.style.cursor = 'not-allowed';
  }

  // 「结束」按钮保留可用，改为关闭面板
  const stopButton = controlPanel.querySelector('button:last-of-type');
  if (stopButton) {
    stopButton.textContent = '关闭面板';
  }
}

// 获取元素的简短描述
function getElementDescription(selector) {
  if (!selector) return '未知元素';

  // 如果是ID选择器
  if (selector.startsWith('#')) {
    return selector.substring(1);
  }

  // 如果是XPath
  if (selector.startsWith('//')) {
    const parts = selector.split('/');
    return parts[parts.length - 1];
  }

  // 其他情况，返回选择器的简短版本
  return selector.length > 20 ? selector.substring(0, 20) + '...' : selector;
}

// 回放下一个操作
function replayNextAction() {
  if (!isReplaying || isPaused) return;

  // 检查是否已经回放完所有操作
  if (replayIndex >= recordedActions.length) {
    // 循环回放：本轮跑完，判断是否还有下一轮
    if (isLooping && repeatCurrent < repeatTotal) {
      startNextLoopRound();
      return;
    }
    console.log('回放完成');
    // 循环模式下这是最后一轮跑完：保留面板标记完成，不弹执行报告
    stopReplay(isLooping && repeatTotal > 1);
    return;
  }

  const currentAction = recordedActions[replayIndex];

  // 通知background更新进度
  chrome.runtime.sendMessage({
    action: 'updateReplayIndex',
    replayIndex: replayIndex + 1
  });

  replayIndex++;

  // 更新控制面板
  updateControlPanel();

  console.log('执行操作:', currentAction.type, replayIndex, '/', recordedActions.length);

  // 先移动鼠标到操作位置，然后执行操作
  if (currentAction.x !== undefined && currentAction.y !== undefined) {
    moveMousePointer(currentAction.x, currentAction.y, function () {
      // 执行操作
      executeAction(currentAction);
    });
  } else {
    // 如果没有坐标，直接执行操作
    executeAction(currentAction);
  }
}

// 步骤失败时跳过本轮：循环模式下，前面步骤失败往往意味着页面状态已不对，
// 后续步骤大概率跟着失败，不如放弃本轮剩余步骤直接进入下一轮。
// 非循环模式返回 false，由调用方保持原行为（跳过该步继续，不能卡死回放）。
function skipCurrentRound(reason) {
  if (!isReplaying || !isLooping || repeatTotal <= 1) return false;

  const running = Math.min(repeatCurrent + 1, repeatTotal);
  console.log(`步骤失败（${reason}），跳过第 ${running}/${repeatTotal} 轮剩余步骤，进入下一轮`);
  showToast(`步骤失败：${reason}。跳过本轮剩余步骤`, 3000);

  // 与正常跑完一轮的边界路径保持一致：
  // 索引推到末尾并同步 background，让它的轮次计数/恢复状态不脱节
  chrome.runtime.sendMessage({
    action: 'updateReplayIndex',
    replayIndex: recordedActions.length
  });
  replayIndex = recordedActions.length;

  startNextLoopRound();
  return true;
}

// 一轮回放结束：推进轮次计数并延时调度下一轮
// 只在「本轮已跑完且有剩余轮次」时被调用，此处不再重复判断是否继续
function startNextLoopRound() {
  repeatCurrent++;

  // 标记进入轮间等待：此期间暂停再恢复时，必须重新调度 enterNextLoopRound，
  // 不能再次走到这里累加 repeatCurrent（否则实际轮数比设定少）
  pendingRoundStart = true;

  // 重置元素未找到计数，否则报告成功率会被历史轮的失败次数累计拖成负数
  elementNotFoundCount = 0;

  console.log(`循环回放：第 ${repeatCurrent}/${repeatTotal} 轮完成`);

  // 通知控制面板刷新轮次显示
  updateControlPanel();

  // 轮次之间留出间隔，方便用户急停
  if (replayTimeout) {
    clearTimeout(replayTimeout);
  }
  replayTimeout = setTimeout(enterNextLoopRound, loopIntervalMs);
}

// 进入新一轮：索引归零后从第一步重新开始（不刷新页面、不重建面板）
function enterNextLoopRound() {
  pendingRoundStart = false;

  // 延时期间用户可能已暂停或停止，这里必须重新校验
  if (!isReplaying || isPaused) return;

  // 所有轮次都已跑完：保留面板标记完成，不弹执行报告
  if (repeatCurrent >= repeatTotal) {
    stopReplay(true);
    return;
  }

  replayIndex = 0;

  // 同步给 background，页面刷新后靠它恢复索引
  chrome.runtime.sendMessage({
    action: 'updateReplayIndex',
    replayIndex: 0
  });

  saveState();

  console.log(`开始第 ${repeatCurrent + 1}/${repeatTotal} 轮回放`);

  replayNextAction();
}

// 执行操作
function executeAction(action) {
  try {
    switch (action.type) {
      case 'click':
        // 点击鼠标动画
        animateMouseClick();
        replayClick(action);
        break;

      case 'input':
        replayInput(action);
        break;

      case 'keydown':
        replayKeydown(action);
        break;

      case 'submit':
        // 点击鼠标动画
        animateMouseClick();
        replaySubmit(action);
        break;

      case 'scroll':
        replayScroll(action);
        break;

      case 'pageLoad':
        // URL 与录制时不一致，导航过去（与单步调试行为一致）
        if (action.url && action.url !== window.location.href) {
          console.log('页面URL不匹配，导航到:', action.url);
          window.location.href = action.url;
          return; // 等待页面加载完成后继续
        }
        scheduleNextAction(500);
        break;

      case 'pageRefresh':
        // 回放中遇到刷新动作要真的刷新页面（比如「刷新+点击」的循环任务），
        // 刷新后由 init → continueReplay 恢复，跳过本动作继续执行
        console.log('执行页面刷新');
        window.location.reload();
        return; // 等待页面加载完成后继续

      default:
        console.log('未知操作类型:', action.type);
        scheduleNextAction(500);
    }
  } catch (error) {
    console.error('执行操作出错:', error);
    scheduleNextAction(1000);
  }
}

// 创建鼠标指针
function createMousePointer() {
  // 如果已经存在鼠标指针，先移除
  removeMousePointer();

  // 创建鼠标指针元素
  mousePointer = document.createElement('div');
  mousePointer.id = 'replay-mouse-pointer';

  // 使用CSS创建一个白色的斜三角形鼠标指针
  mousePointer.style.cssText = `
    position: fixed;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 0 8px 16px 8px;
    border-color: transparent transparent white transparent;
    z-index: 10000;
    transform: translate(-4px, 0) rotate(-45deg);
    transition: left 0.3s ease-out, top 0.3s ease-out;
    filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.7));
    display: none;
    pointer-events: none;
  `;

  // 添加内部边框，使鼠标指针更加清晰
  const innerPointer = document.createElement('div');
  innerPointer.style.cssText = `
    position: absolute;
    top: 2px;
    left: -6px;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 0 6px 12px 6px;
    border-color: transparent transparent rgba(0, 0, 0, 0.2) transparent;
    transform: rotate(0deg);
    opacity: 0.5;
  `;

  mousePointer.appendChild(innerPointer);

  // 添加到页面
  document.body.appendChild(mousePointer);

  // 添加鼠标指针样式
  const style = document.createElement('style');
  style.textContent = `
    #replay-mouse-pointer.clicking {
      transform: translate(-4px, 0) rotate(-45deg) scale(0.9);
      transition: transform 0.1s ease-out;
    }
    
    @keyframes click-ripple {
      0% { width: 0; height: 0; opacity: 0.8; }
      100% { width: 60px; height: 60px; opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// 显示执行报告弹窗
function showReplayReport() {
  // 创建暗色蒙版
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 10000;
  `;
  document.body.appendChild(overlay);

  // 创建弹窗容器
  const reportDialog = document.createElement('div');
  reportDialog.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 10001;
    min-width: 600px;
    max-width: 80%;
    max-height: 80vh;
    overflow-y: auto;
  `;

  // 获取浏览器和操作系统信息
  const userAgent = navigator.userAgent;
  const browserInfo = {
    name: userAgent.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i)[1],
    version: userAgent.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i)[2]
  };
  const osInfo = {
    name: userAgent.match(/\((.+?)\)/)[1]
  };

  // 计算执行统计
  const totalSteps = recordedActions.length;
  let successfulSteps = recordedActions.filter((_, index) => index < replayIndex).length;
  successfulSteps -= elementNotFoundCount
  const successRate = Math.round((successfulSteps / totalSteps) * 100);

  // 计算总执行时长
  const startTime = recordedActions[0]?.timestamp || 0;
  let endTime = recordedActions[replayIndex - 1]?.timestamp;
  if (replayIndex === 0) {
    endTime = startTime;
  }
  console.log('startTime', startTime, 'endTime', endTime);
  const totalDuration = Math.round((endTime - startTime) / 1000);

  // 统计操作类型分布
  const actionTypes = {};
  recordedActions.forEach(action => {
    actionTypes[action.type] = (actionTypes[action.type] || 0) + 1;
  });

  // 生成操作类型分布(总占比)HTML
  const actionTypeHtml = Object.entries(actionTypes)
    .map(([type, count]) => `
      <div style="display: flex; align-items: center; margin-bottom: 5px;">
        <div style="width: 100px;">${type}:</div>
        <div style="flex-grow: 1; background: #f0f0f0; border-radius: 4px; overflow: hidden;">
          <div style="background: #1890ff; width: ${(count / totalSteps) * 100}%; height: 20px;"></div>
        </div>
        <div style="margin-left: 10px;">${count}次</div>
      </div>
    `).join('');

  // 生成报告内容
  reportDialog.innerHTML = `
    <div style="position: relative;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
      <h2 style="margin: 0; font-size: 18px; color: #333;">${currentTaskName} - 执行报告</h2>
      <button id="closeButton" style="
        background: none;
        border: none;
        color: #666;
        font-size: 28px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      ">×</button>
    </div>
    <div style="margin-bottom: 20px; padding: 15px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 6px;">
      <h3 style="margin: 0 0 10px; font-size: 16px; color: #333;">运行环境</h3>
      <div style="display: flex; gap: 20px;">
        <div>
          <div style="color: #666;">浏览器：</div>
          <div style="font-weight: 500;">${browserInfo.name} ${browserInfo.version}</div>
        </div>
        <div>
          <div style="color: #666;">操作系统：</div>
          <div style="font-weight: 500;">${osInfo.name}</div>
        </div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px;">
      <div style="background: #f6ffed; border: 1px solid #b7eb8f; padding: 15px; border-radius: 6px;">
        <div style="font-size: 24px; color: #52c41a;">${successfulSteps}/${totalSteps}</div>
        <div style="color: #666;">执行步骤</div>
      </div>
      <div style="background: #e6f7ff; border: 1px solid #91d5ff; padding: 15px; border-radius: 6px;">
        <div style="font-size: 24px; color: #1890ff;">${successRate}%</div>
        <div style="color: #666;">成功率</div>
      </div>
      <div style="background: #fff7e6; border: 1px solid #ffd591; padding: 15px; border-radius: 6px;">
        <div style="font-size: 24px; color: #fa8c16;">${totalDuration}s</div>
        <div style="color: #666;">总耗时</div>
      </div>
      <div style="background: #fff1f0; border: 1px solid #ffa39e; padding: 15px; border-radius: 6px;">
        <div style="font-size: 24px; color:rgb(243, 132, 138);">${elementNotFoundCount}</div>
        <div style="color: #666;">元素未找到</div>
      </div>
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="margin: 0 0 10px; font-size: 16px; color: #333;">操作类型分布</h3>
      ${actionTypeHtml}
    </div>

    ${replayIndex < totalSteps ? `
    <div style="margin-bottom: 20px;">
      <h3 style="margin: 0 0 10px; font-size: 16px; color: #333;">未完成步骤</h3>
      <div style="background: #fff2f0; border: 1px solid #ffccc7; padding: 15px; border-radius: 6px;">
        <ul style="margin: 0; padding-left: 20px;">
          ${recordedActions.slice(replayIndex).map((action, index) =>
    `<li style="margin-bottom: 8px;">
        <div style="color: #cf1322;">步骤 ${replayIndex + index + 1}: ${action.type} (${action.text || action.value || action.code || ""})</div>
        ${action.selector ? `<div style="color: #666; font-size: 12px;">${getElementDescription(action.selector)}</div>` : ''}
       </li>`
  ).join('')}
        </ul>
      </div>
    </div>
    ` : ''}

    <div style="display: flex; gap: 10px;">
      <button id="retryButton" style="
        flex: 1;
        background: #52c41a;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      ">重试失败步骤</button>
      <button id="exportButton" style="
        flex: 1;
        background: #1890ff;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      ">导出报告</button>
    </div>
  `;

  // 添加按钮事件
  const retryButton = reportDialog.querySelector('#retryButton');
  retryButton.onclick = () => {
    if (replayIndex < totalSteps) {
      document.body.removeChild(reportDialog);
      document.body.removeChild(overlay);
      // startReplay(recordedActions, replayIndex);
    }
  };

  const exportButton = reportDialog.querySelector('#exportButton');
  exportButton.onclick = () => {
    // 生成HTML报告内容
    const reportContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>执行报告</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; padding: 20px; }
          .container { max-width: 800px; margin: 0 auto; }
          .env-info { margin-bottom: 20px; padding: 15px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 6px; }
          .env-info h3 { margin: 0 0 10px; font-size: 16px; color: #333; }
          .env-info-grid { display: flex; gap: 20px; }
          .env-info-item { flex: 1; }
          .env-info-label { color: #666; }
          .env-info-value { font-weight: 500; }
          .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
          .stat-card { padding: 15px; border-radius: 6px; }
          .stat-value { font-size: 24px; margin-bottom: 5px; }
          .stat-label { color: #666; }
          .action-type { display: flex; align-items: center; margin-bottom: 5px; }
          .action-label { width: 100px; }
          .action-bar { flex-grow: 1; background: #f0f0f0; border-radius: 4px; overflow: hidden; }
          .action-bar-fill { background: #1890ff; height: 20px; }
          .action-count { margin-left: 10px; }
          .section { margin-bottom: 20px; }
          .error-list { background: #fff2f0; border: 1px solid #ffccc7; padding: 15px; border-radius: 6px; }
          .error-step { margin-bottom: 8px; }
          .error-type { color: #cf1322; }
          .error-desc { color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2 style="margin: 0 0 15px; font-size: 18px; color: #333;">${currentTaskName} - 执行报告</h2>
          
          <div class="env-info">
            <h3>运行环境</h3>
            <div class="env-info-grid">
              <div class="env-info-item">
                <div class="env-info-label">浏览器：</div>
                <div class="env-info-value">${browserInfo.name} ${browserInfo.version}</div>
              </div>
              <div class="env-info-item">
                <div class="env-info-label">操作系统：</div>
                <div class="env-info-value">${osInfo.name}</div>
              </div>
            </div>
          </div>
          <div class="stats-grid">
            <div class="stat-card" style="background: #f6ffed; border: 1px solid #b7eb8f;">
              <div class="stat-value" style="color: #52c41a;">${successfulSteps}/${totalSteps}</div>
              <div class="stat-label">执行步骤</div>
            </div>
            <div class="stat-card" style="background: #e6f7ff; border: 1px solid #91d5ff;">
              <div class="stat-value" style="color: #1890ff;">${successRate}%</div>
              <div class="stat-label">成功率</div>
            </div>
            <div class="stat-card" style="background: #fff7e6; border: 1px solid #ffd591;">
              <div class="stat-value" style="color: #fa8c16;">${totalDuration}s</div>
              <div class="stat-label">总耗时</div>
            </div>
            <div class="stat-card" style="background: #fff1f0; border: 1px solid #ffa39e;">
              <div class="stat-value" style="color: rgb(243, 132, 138);">${elementNotFoundCount}</div>
              <div class="stat-label">元素未找到</div>
            </div>
          </div>

          <div class="section">
            <h3 style="margin: 0 0 10px; font-size: 16px; color: #333;">操作类型分布</h3>
            ${Object.entries(actionTypes).map(([type, count]) => `
              <div class="action-type">
                <div class="action-label">${type}:</div>
                <div class="action-bar">
                  <div class="action-bar-fill" style="width: ${(count / totalSteps) * 100}%;"></div>
                </div>
                <div class="action-count">${count}次</div>
              </div>
            `).join('')}
          </div>

          ${replayIndex < totalSteps ? `
          <div class="section">
            <h3 style="margin: 0 0 10px; font-size: 16px; color: #333;">未完成步骤</h3>
            <div class="error-list">
              <ul style="margin: 0; padding-left: 20px;">
                ${recordedActions.slice(replayIndex).map((action, index) => `
                  <li class="error-step">
                    <div class="error-type">步骤 ${replayIndex + index + 1}: ${action.type} (${action.text || action.value || action.code || ""})</div>
                    ${action.selector ? `<div class="error-desc">${getElementDescription(action.selector)}</div>` : ''}
                  </li>
                `).join('')}
              </ul>
            </div>
          </div>
          ` : ''}
        </div>
      </body>
      </html>
    `;

    // 创建下载链接
    const dataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(reportContent);
    const exportName = `test_report_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.html`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportName);
    linkElement.click();
  };

  const closeButton = reportDialog.querySelector('#closeButton');
  closeButton.onclick = () => {
    document.body.removeChild(overlay);
    document.body.removeChild(reportDialog);
  };

  // 添加到页面
  document.body.appendChild(reportDialog);
}

// 移除鼠标指针
function removeMousePointer() {
  if (mousePointer) {
    document.body.removeChild(mousePointer);
    mousePointer = null;
  }
}

// 移动鼠标指针到指定位置
function moveMousePointer(x, y, callback) {
  if (!mousePointer) {
    createMousePointer();
  }

  // 显示鼠标指针
  mousePointer.style.display = 'block';

  // 获取当前位置
  const currentX = parseInt(mousePointer.style.left) || 0;
  const currentY = parseInt(mousePointer.style.top) || 0;

  // 如果位置相同，直接调用回调
  if (currentX === x && currentY === y && callback) {
    callback();
    return;
  }

  // 设置新位置
  mousePointer.style.left = x + 'px';
  mousePointer.style.top = y + 'px';

  // 处理悬停效果
  handleHoverEffect(x, y);

  // 300ms后执行回调（与CSS过渡时间相同）
  if (callback) {
    setTimeout(callback, 300);
  }
}

// 添加处理悬停效果的函数
function handleHoverEffect(x, y) {
  // 获取鼠标位置下的元素
  const elementsFromPoint = document.elementsFromPoint(x, y);

  // 过滤掉鼠标指针自身
  const targetElements = elementsFromPoint.filter(el => el.id !== 'replay-mouse-pointer');

  // 如果有元素
  if (targetElements.length > 0) {
    const targetElement = targetElements[0]; // 最上层的元素

    // 如果与上次悬停的元素不同
    if (lastHoveredElement !== targetElement) {
      // 如果有上次悬停的元素，触发鼠标离开事件
      if (lastHoveredElement) {
        simulateMouseEvent(lastHoveredElement, 'mouseout');
        simulateMouseEvent(lastHoveredElement, 'mouseleave');
      }

      // 触发鼠标进入事件
      simulateMouseEvent(targetElement, 'mouseover');
      simulateMouseEvent(targetElement, 'mouseenter');

      // 更新上次悬停的元素
      lastHoveredElement = targetElement;
    }

    // 无论如何都触发鼠标移动事件
    simulateMouseEvent(targetElement, 'mousemove');
  } else if (lastHoveredElement) {
    // 如果没有元素但有上次悬停的元素，触发鼠标离开事件
    simulateMouseEvent(lastHoveredElement, 'mouseout');
    simulateMouseEvent(lastHoveredElement, 'mouseleave');
    lastHoveredElement = null;
  }
}

// 添加模拟鼠标事件的函数
function simulateMouseEvent(element, eventType) {
  if (!element || !eventType) return;

  try {
    const mouseEvent = new MouseEvent(eventType, {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: 1,
      screenX: parseInt(mousePointer.style.left) || 0,
      screenY: parseInt(mousePointer.style.top) || 0,
      clientX: parseInt(mousePointer.style.left) || 0,
      clientY: parseInt(mousePointer.style.top) || 0,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      button: 0,
      relatedTarget: null
    });

    element.dispatchEvent(mouseEvent);
  } catch (error) {
    console.error('模拟鼠标事件出错:', error);
  }
}

// 点击鼠标指针动画
function animateMouseClick() {
  if (!mousePointer) return;

  // 添加点击动画类
  mousePointer.classList.add('clicking');

  // 创建点击波纹效果
  const clickEffect = document.createElement('div');
  clickEffect.style.cssText = `
    position: absolute;
    top: 5px;
    left: 0;
    width: 30px;
    height: 30px;
    background-color: rgba(255, 255, 255, 0.7);
    border: 2px solid rgba(0, 0, 0, 0.3);
    border-radius: 50%;
    animation: click-ripple 0.7s ease-out;
    pointer-events: none;
    transform: translate(-50%, -50%);
    z-index: 9999;
  `;

  mousePointer.appendChild(clickEffect);

  // 移除点击效果
  setTimeout(() => {
    if (mousePointer && mousePointer.classList) {
      mousePointer.classList.remove('clicking');
      if (clickEffect && clickEffect.parentNode === mousePointer) {
        mousePointer.removeChild(clickEffect);
      }
    }
  }, 700);
}

// 格式化时间戳
function formatTimestamp(timestamp) {
  if (!timestamp || isNaN(new Date(timestamp).getTime())) {
    return '未知时间';
  }
  return new Date(timestamp).toLocaleString();
}

// 创建任务抽屉
function createTaskDrawer() {
  return
  // 如果已经存在任务抽屉，先移除
  removeTaskDrawer();

  // 创建任务抽屉容器
  taskDrawer = document.createElement('div');
  taskDrawer.id = 'task-drawer';
  taskDrawer.style.cssText = `
    position: fixed;
    top: 0;
    right: -320px;
    width: 320px;
    height: 100%;
    background-color: rgba(255, 255, 255, 0.95);
    border-left: 1px solid #ccc;
    box-shadow: -2px 0 10px rgba(0, 0, 0, 0.2);
    z-index: 9998;
    font-family: Arial, sans-serif;
    transition: right 0.3s ease-in-out;
    display: flex;
    flex-direction: column;
  `;

  // 创建抽屉切换按钮
  const toggleButton = document.createElement('div');
  toggleButton.id = 'task-drawer-toggle';
  toggleButton.style.cssText = `
    position: absolute;
    top: 50%;
    left: -30px;
    transform: translateY(-50%);
    width: 30px;
    height: 60px;
    background-color: rgba(66, 133, 244, 0.9);
    border-radius: 5px 0 0 5px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    box-shadow: -2px 0 5px rgba(0, 0, 0, 0.2);
  `;
  toggleButton.innerHTML = '<span style="color: white; font-weight: bold;">◀</span>';
  toggleButton.addEventListener('click', toggleTaskDrawer);

  // 创建标题栏
  const titleBar = document.createElement('div');
  titleBar.style.cssText = `
    padding: 10px;
    background-color: #4285f4;
    color: white;
    font-weight: bold;
    font-size: 18px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  `;
  titleBar.innerHTML = '<span>任务列表</span>';



  // 创建录制按钮
  const recordButton = document.createElement('button');
  recordButton.style.cssText = `
    padding: 5px 10px;
    background-color: #ea4335;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 14px;
  `;
  recordButton.textContent = '开始录制';
  recordButton.addEventListener('click', function () {
    const recordingName = '录制_' + new Date().toLocaleString();
    if (recordingName) {
      chrome.runtime.sendMessage({
        action: 'startRecording',
        recordingName: recordingName
      }, function () {
        updateTaskDrawer();
      });
    }
  });
  titleBar.appendChild(recordButton);
  taskDrawer.appendChild(titleBar);

  // 创建当前页面域名提示区域
  const domainHint = document.createElement('div');
  domainHint.style.cssText = `
    padding: 10px 15px;
    background-color: #f8f9fa;
    color: #666;
    font-size: 13px;
    border-bottom: 1px solid #eee;
    word-wrap: break-word;
    word-break: break-all;
  `;
  domainHint.id = 'airoom-domain-hint';
  domainHint.textContent = `列出当前页面任务：${window.location.href}`;
  taskDrawer.appendChild(domainHint);

  // 创建任务列表容器
  const taskListContainer = document.createElement('div');
  taskListContainer.id = 'task-list-container';
  taskListContainer.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 10px;
  `;
  taskDrawer.appendChild(taskListContainer);

  // 创建底部容器
  const bottomContainer = document.createElement('div');
  bottomContainer.style.cssText = `
    padding: 15px;
    border-top: 1px solid #ccc;
    display: flex;
    justify-content: center;
    gap: 10px;
  `;

  // 创建显示全部按钮
  const showAllButton = document.createElement('button');
  showAllButton.style.cssText = `
    padding: 6px 15px;
    background-color: white;
    color: #666;
    border: 1px solid #ccc;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    width: 100%;
    max-width: 150px;
  `;
  showAllButton.textContent = '显示全部任务 ⤵';
  showAllButton.addEventListener('click', function () {
    if (show_all === false) {
      show_all = true;
      updateTaskDrawer(null, true);
      showAllButton.textContent = '显示当前页面任务';
    } else {
      show_all = false;
      updateTaskDrawer(null, false);
      showAllButton.textContent = '显示全部任务 ⤵';
    }
  });
  // 创建刷新按钮
  const refreshButton = document.createElement('button');
  refreshButton.style.cssText = `
    padding: 6px 12px;
    background-color: white;
    color: #666;
    border: 1px solid #ccc;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  refreshButton.innerHTML = '刷新';
  refreshButton.title = '刷新任务列表';
  refreshButton.addEventListener('click', function () {
    // 更新域名提示
    const domainHint = document.getElementById('airoom-domain-hint')
    if (domainHint) {
      domainHint.textContent = `列出当前页面任务：${window.location.href}`;
    }
    updateTaskDrawer(null, show_all);
    setTimeout(() => {
      refreshButton.innerHTML = '刷新...';
      setTimeout(() => {
        refreshButton.innerHTML = '刷新..';
        setTimeout(() => {
          refreshButton.innerHTML = '刷新';
        }, 200);
      }, 200);
    }, 200);
  });

  bottomContainer.appendChild(showAllButton);
  bottomContainer.appendChild(refreshButton);
  taskDrawer.appendChild(bottomContainer);

  // 添加到页面
  document.body.appendChild(taskDrawer);
  taskDrawer.appendChild(toggleButton);

  // 加载任务列表
  updateTaskDrawer();
}

// 切换任务抽屉
function toggleTaskDrawer() {
  return
  const drawer = document.getElementById('task-drawer');
  const toggleButton = document.getElementById('task-drawer-toggle');

  if (!drawer || !toggleButton) return;

  if (isTaskDrawerOpen) {
    drawer.style.right = '-320px';
    toggleButton.innerHTML = '<span style="color: white; font-weight: bold;">◀</span>';
  } else {
    drawer.style.right = '0';
    toggleButton.innerHTML = '<span style="color: white; font-weight: bold;">▶</span>';
    // 加载任务列表
    updateTaskDrawer(null, false);

  }

  isTaskDrawerOpen = !isTaskDrawerOpen;
}

// 监听来自popup的消息
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  switch (request.action) {
    case 'checkTaskDrawerStatus':
      sendResponse({ isOpen: isTaskDrawerOpen });
      break;
    case 'openTaskDrawer':
      if (!taskDrawer) {
        createTaskDrawer();
      }
      if (!isTaskDrawerOpen) {
        toggleTaskDrawer();
      }
      break;
    case 'closeTaskDrawer':
      if (isTaskDrawerOpen) {
        toggleTaskDrawer();
      }
      break;
  }
});

// 更新任务抽屉
function updateTaskDrawer(recordings, show_all = false) {
  return
  console.log('更新任务抽屉，显示所有:', show_all);
  const taskListContainer = document.getElementById('task-list-container');
  if (!taskListContainer) return;

  // 清空任务列表
  taskListContainer.innerHTML = '';

  // 如果没有传入recordings，则获取所有录制
  if (!recordings) {
    chrome.runtime.sendMessage({ action: 'getRecordings' }, function (response) {
      if (response && response.recordings) {
        updateTaskDrawer(response.recordings, show_all);
        return;
      }
    });
  } else {

    if (recordings.length === 0) {
      taskListContainer.innerHTML = '<div style="text-align: center; padding: 20px; color: #666;">暂无任务</div>';
      return;
    }

    // 获取当前页面的域名
    const currentDomain = window.location.href;
    // let url = "https://debug.xxx.com/#/ProductData/MainDevice/RTKAccount";

    // 创建 URL 对象
    const urlObj = new URL(currentDomain);
    const hostname = urlObj.hostname; // "debug.xxx.com"
    const topLevelDomain = hostname.split('.').slice(-2).join('.'); // "xxx.com"
    let path = currentDomain.substring(currentDomain.indexOf(topLevelDomain) + topLevelDomain.length); // 后缀
    if (path === "/") {
      path = "";
    }

    console.log('currentDomain:', currentDomain);
    console.log("一级域名:", topLevelDomain); // xxx.com
    console.log("路径:", path); // /#/ProductData/MainDevice/RTKAccount

    // 创建任务列表
    recordings.forEach(function (recording) {

      if (show_all === false) {
        // 创建 URL 对象
        console.log('recording domain:', recording.domain);
        const currentDomain2 = recording.domain;
        if (!currentDomain2) {
          console.warn('recording domain is empty', recording);
          return;
        }
        console.log('currentDomain2:', currentDomain2)
        const urlObj2 = new URL(currentDomain2);
        const hostname2 = urlObj2.hostname; // "debug.xxx.com"
        const topLevelDomain2 = hostname2.split('.').slice(-2).join('.'); // "xxx.com"
        let path2 = currentDomain2.substring(currentDomain2.indexOf(topLevelDomain2) + topLevelDomain2.length); // 后缀
        if (path2 === "/") {
          path2 = "";
        }
        if (path.length > 0) {
          if (path !== path2) {
            return;
          }
          // console.log('path2 xxx:', path2);
        } else {
          if (topLevelDomain !== topLevelDomain2) {
            return;
          }
          // console.log('topLevelDomain xxx:', topLevelDomain);
          // console.log('topLevelDomain2 xxx:', topLevelDomain2);
        }
      }

      console.log('recording domain:', recording.domain);
      const taskItem = document.createElement('div');
      taskItem.style.cssText = `
          margin-bottom: 10px;
          padding: 10px;
          background-color: #f5f5f5;
          border-radius: 5px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        `;

      // 任务名称容器
      const taskNameContainer = document.createElement('div');
      taskNameContainer.style.cssText = `
          display: flex;
          align-items: center;
          margin-bottom: 8px;
        `;

      // 任务名称显示区域
      const taskNameDisplay = document.createElement('div');
      taskNameDisplay.style.cssText = `
          font-weight: bold;
          font-size: 16px;
          flex-grow: 1;
          margin-right: 8px;
        `;
      // 显示任务名称和域名
      taskNameDisplay.textContent = recording.displayName || recording.name;

      // 任务名称编辑输入框
      const taskNameInput = document.createElement('input');
      taskNameInput.type = 'text';
      taskNameInput.style.cssText = `
          font-weight: bold;
          font-size: 16px;
          width: 100%;
          padding: 4px 8px;
          border: 1px solid #4285f4;
          border-radius: 3px;
          display: none;
        `;
      taskNameInput.value = recording.displayName || recording.name;

      // 编辑按钮
      const editButton = document.createElement('button');
      editButton.style.cssText = `
          padding: 3px 8px;
          background-color: #fbbc05;
          color: white;
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-size: 12px;
        `;
      editButton.textContent = '编辑';

      // 编辑按钮点击事件
      editButton.addEventListener('click', function () {
        taskNameDisplay.style.display = 'none';
        taskNameInput.style.display = 'block';
        editButton.style.display = 'none';
        taskNameInput.focus();
        taskNameInput.select();
      });

      // 输入框失焦和回车事件
      taskNameInput.addEventListener('blur', function () {
        if (taskNameInput.value.trim() !== '') {
          saveTaskName();
        } else {
          cancelEdit();
        }
      });
      taskNameInput.addEventListener('keyup', function (e) {
        if (e.key === 'Enter') {
          if (taskNameInput.value.trim() !== '') {
            saveTaskName();
          } else {
            cancelEdit();
          }
        } else if (e.key === 'Escape') {
          cancelEdit();
        }
      });

      function saveTaskName() {
        const newDisplayName = taskNameInput.value.trim();
        if (newDisplayName !== '' && newDisplayName !== (recording.displayName || recording.name)) {
          chrome.runtime.sendMessage({
            action: 'updateRecordingDisplayName',
            recordingName: recording.name,
            displayName: newDisplayName
          }, function () {
            recording.displayName = newDisplayName;
            taskNameDisplay.textContent = newDisplayName;
          });
        }
        cancelEdit();
      }

      function cancelEdit() {
        taskNameInput.style.display = 'none';
        taskNameDisplay.style.display = 'block';
        editButton.style.display = 'inline';
        taskNameInput.value = recording.displayName || recording.name;
      }

      taskNameContainer.appendChild(taskNameDisplay);
      taskNameContainer.appendChild(taskNameInput);
      taskNameContainer.appendChild(editButton);
      taskItem.appendChild(taskNameContainer);

      // 任务信息
      const taskInfo = document.createElement('div');
      taskInfo.style.cssText = `
          font-size: 12px;
          color: #666;
          margin-bottom: 8px;
        `;
      console.log(recording, "任务列表。")
      taskInfo.textContent = `步骤数: ${recording.actions.length} | 创建时间: ${formatTimestamp(recording.createdAt)}`;
      taskItem.appendChild(taskInfo);

      // 按钮容器
      const buttonContainer = document.createElement('div');
      buttonContainer.style.cssText = `
          display: flex;
          justify-content: space-between;
        `;

      // 回放按钮
      const replayButton = document.createElement('button');
      replayButton.style.cssText = `
          padding: 5px 10px;
          background-color: #4285f4;
          color: white;
          border: none;
          border-radius: 3px;
          cursor: pointer;
          flex: 1;
          margin-right: 5px;
          font-size: 12px;
        `;
      replayButton.textContent = '回放';
      replayButton.addEventListener('click', function () {
        chrome.runtime.sendMessage({
          action: 'startReplay',
          recordingName: recording.name
        });
      });
      buttonContainer.appendChild(replayButton);

      // 查看按钮
      const viewButton = document.createElement('button');
      viewButton.style.cssText = `
          padding: 5px 10px;
          background-color: #34a853;
          color: white;
          border: none;
          border-radius: 3px;
          cursor: pointer;
          flex: 1;
          margin-right: 5px;
          font-size: 12px;
        `;
      viewButton.textContent = '查看';
      viewButton.addEventListener('click', function () {
        showTaskDetails(recording);
      });
      buttonContainer.appendChild(viewButton);

      // 删除按钮
      const deleteButton = document.createElement('button');
      deleteButton.style.cssText = `
          padding: 5px 10px;
          background-color: #ea4335;
          color: white;
          border: none;
          border-radius: 3px;
          cursor: pointer;
          flex: 1;
          font-size: 12px;
        `;
      deleteButton.textContent = '删除';
      deleteButton.addEventListener('click', function () {
        chrome.runtime.sendMessage({
          action: 'deleteRecording',
          recordingName: recording.name
        }, function (response) {
          if (response && response.success) {
            // 删除成功后重新获取任务列表并更新任务抽屉
            chrome.runtime.sendMessage({ action: 'getRecordings' }, function (response) {
              if (response && response.recordings) {
                updateTaskDrawer(response.recordings, show_all);
              }
            });
          }
        });
      });
      buttonContainer.appendChild(deleteButton);

      taskItem.appendChild(buttonContainer);
      taskListContainer.appendChild(taskItem);
    });
  }
}

// 显示任务详情
function showTaskDetails(recording) {
  return
  // 创建详情弹窗
  const detailsModal = document.createElement('div');
  detailsModal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
  `;

  // 创建详情容器
  const detailsContainer = document.createElement('div');
  detailsContainer.style.cssText = `
    width: 80%;
    max-width: 800px;
    max-height: 80%;
    background-color: white;
    border-radius: 5px;
    box-shadow: 0 0 20px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `;

  // 创建标题栏
  const titleBar = document.createElement('div');
  titleBar.style.cssText = `
    padding: 15px;
    background-color: #4285f4;
    color: white;
    font-weight: bold;
    font-size: 18px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  `;
  titleBar.innerHTML = `<span>任务详情: ${recording.name}</span>`;

  // 创建关闭按钮
  const closeButton = document.createElement('button');
  closeButton.style.cssText = `
    background: none;
    border: none;
    color: white;
    font-size: 20px;
    cursor: pointer;
  `;
  closeButton.textContent = '×';
  closeButton.addEventListener('click', function () {
    document.body.removeChild(detailsModal);
  });
  titleBar.appendChild(closeButton);
  detailsContainer.appendChild(titleBar);

  // 创建内容区域
  const contentArea = document.createElement('div');
  contentArea.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 15px;
  `;

  // 添加任务信息
  const infoSection = document.createElement('div');
  infoSection.style.cssText = `
    margin-bottom: 15px;
    padding-bottom: 15px;
    border-bottom: 1px solid #eee;
  `;
  infoSection.innerHTML = `
    <div><strong>创建时间:</strong> ${formatTimestamp(recording.createdAt)}</div>
    <div><strong>任务地址:</strong> ${recording.domain || '未知'}</div>
    <div><strong>任务步骤:</strong> ${recording.actions.length}</div>
  `;
  contentArea.appendChild(infoSection);

  // 添加步骤列表
  const stepsTitle = document.createElement('h3');
  stepsTitle.textContent = '步骤列表';
  contentArea.appendChild(stepsTitle);

  const stepsList = document.createElement('div');
  recording.actions.forEach(function (action, index) {
    const stepItem = document.createElement('div');
    stepItem.style.cssText = `
      margin-bottom: 8px;
      padding: 8px;
      background-color: #f5f5f5;
      border-radius: 3px;
    `;

    let actionDescription = '';
    switch (action.type) {
      case 'click':
        actionDescription = `点击 (${action.text}) 元素: ${action.selector}`;
        break;
      case 'input':
        actionDescription = `输入 (${action.value}) 元素: ${action.selector}`;
        break;
      case 'keydown':
        actionDescription = `按键 (${action.code}) key: ${action.key}`;
        break;
      case 'submit':
        actionDescription = `提交表单: ${action.selector}`;
        break;
      case 'scroll':
        actionDescription = `滚动页面: X=${action.scrollX}, Y=${action.scrollY}`;
        break;
      case 'pageRefresh':
        actionDescription = `页面刷新: ${action.url}`;
        break;
      default:
        actionDescription = `${action.type} 操作`;
    }

    stepItem.innerHTML = `<strong>步骤 ${index + 1}:</strong> ${actionDescription}`;
    stepsList.appendChild(stepItem);
  });
  contentArea.appendChild(stepsList);

  detailsContainer.appendChild(contentArea);
  detailsModal.appendChild(detailsContainer);
  document.body.appendChild(detailsModal);
}

// 移除任务抽屉
function removeTaskDrawer() {
  return
  const drawer = document.getElementById('task-drawer');
  const toggleButton = document.getElementById('task-drawer-toggle');

  if (drawer) {
    document.body.removeChild(drawer);
  }

  if (toggleButton) {
    document.body.removeChild(toggleButton);
  }

  taskDrawer = null;
  isTaskDrawerOpen = false;
}

// 显示录制状态指示器
function showRecordingIndicator(recordingName) {
  // 如果已经存在指示器，先移除
  hideRecordingIndicator();

  // 创建录制状态指示器容器
  recordingIndicator = document.createElement('div');
  recordingIndicator.id = 'recording-indicator';
  recordingIndicator.style.cssText = `
    position: fixed;
    top: 10px;
    left: 10px;
    background-color: rgba(255, 255, 255, 0.95);
    border: 1px solid #ea4335;
    border-radius: 5px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    padding: 10px;
    z-index: 9999;
    font-family: Arial, sans-serif;
    font-size: 14px;
    display: flex;
    align-items: center;
    pointer-events: none;
  `;

  // 创建录制图标
  const recordingIcon = document.createElement('div');
  recordingIcon.style.cssText = `
    width: 12px;
    height: 12px;
    background-color: #ea4335;
    border-radius: 50%;
    margin-right: 8px;
    animation: pulse 1.5s infinite;
  `;

  // 添加脉冲动画
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.5; }
      100% { opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // 创建录制状态文本
  const statusText = document.createElement('div');
  statusText.style.cssText = `
    margin-right: 10px;
    font-weight: bold;
  `;
  statusText.textContent = `录制中...`;

  // 创建计时器
  const timerDisplay = document.createElement('div');
  timerDisplay.id = 'recording-timer';
  timerDisplay.style.cssText = `
    margin-right: 10px;
    font-family: monospace;
  `;
  timerDisplay.textContent = '00:00';

  // 创建停止按钮
  const stopButton = document.createElement('button');
  stopButton.style.cssText = `
    padding: 3px 8px;
    background-color: #ea4335;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    pointer-events: auto;
  `;
  stopButton.textContent = '结束录制';
  stopButton.addEventListener('click', function () {
    chrome.runtime.sendMessage({ action: 'stopRecording' });
  });

  // 组装指示器
  recordingIndicator.appendChild(recordingIcon);
  recordingIndicator.appendChild(statusText);
  recordingIndicator.appendChild(timerDisplay);
  recordingIndicator.appendChild(stopButton);

  // 添加到页面
  document.body.appendChild(recordingIndicator);

  // 从storage中读取开始时间，如果不存在则使用当前时间
  chrome.storage.local.get(['recordingStartTime'], function (data) {
    recordingStartTime = data.recordingStartTime || Date.now();
    startRecordingTimer();
  });
}

// 隐藏录制状态指示器
function hideRecordingIndicator() {
  if (recordingIndicator) {
    document.body.removeChild(recordingIndicator);
    recordingIndicator = null;
  }

  // 停止计时器
  stopRecordingTimer();
}

// 开始录制计时器
function startRecordingTimer() {
  // 停止已有的计时器
  stopRecordingTimer();

  // 创建新的计时器
  recordingTimer = setInterval(updateRecordingTimer, 1000);
  updateRecordingTimer(); // 立即更新一次
}

// 停止录制计时器
function stopRecordingTimer() {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
}

// 更新录制计时器显示
function updateRecordingTimer() {
  const timerDisplay = document.getElementById('recording-timer');
  if (!timerDisplay) return;

  // 计算已录制时间（秒）
  const elapsedTime = Math.floor((Date.now() - recordingStartTime) / 1000);

  // 格式化为 MM:SS
  const minutes = Math.floor(elapsedTime / 60).toString().padStart(2, '0');
  const seconds = (elapsedTime % 60).toString().padStart(2, '0');

  timerDisplay.textContent = `${minutes}:${seconds}`;

  // 保存当前计时器状态到storage local
  chrome.storage.local.set({
    recordingStartTime: recordingStartTime
  });
}
