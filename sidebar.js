// 初始化标签页状态
let showAllTasks = false;


// 格式化时间戳
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString();
}

// 导出录制为 JSON 文件，可分享给他人导入。
// 用带 schema 的封装格式，便于以后做版本兼容；recording 字段即原始录制对象
function exportRecording(recording) {
    const payload = {
        schema: 'relax-work-recording',
        version: 1,
        exportedAt: Date.now(),
        recording: {
            name: recording.name,
            displayName: recording.displayName || recording.name,
            domain: recording.domain || '',
            createdAt: recording.createdAt || Date.now(),
            actions: recording.actions || []
        }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (recording.displayName || recording.name || 'recording')
        .replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
    a.download = `自动点击助手-${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// 导入录制：解析 JSON，校验，交给 background 入库（名称冲突自动改名）
function importRecordingFromFile(file) {
    const reader = new FileReader();
    reader.onload = function () {
        let data;
        try {
            data = JSON.parse(reader.result);
        } catch (e) {
            alert('文件解析失败：不是有效的 JSON');
            return;
        }
        // 兼容封装格式和裸录制对象
        const rec = data && data.recording ? data.recording : data;
        if (!rec || !Array.isArray(rec.actions) || rec.actions.length === 0) {
            alert('文件格式不正确：缺少 actions 或为空');
            return;
        }
        chrome.runtime.sendMessage({ action: 'importRecording', recording: rec }, function (response) {
            if (response && response.success) {
                loadTasks();
                // 切到「全部任务」视图，方便用户看到刚导入的任务
                if (!showAllTasks) {
                    document.getElementById('allTasksTab').click();
                }
            } else {
                alert('导入失败：' + (response && response.error || '未知错误'));
            }
        });
    };
    reader.onerror = function () {
        alert('读取文件失败');
    };
    reader.readAsText(file);
}

// 获取并显示任务列表
function loadTasks() {
    // 获取当前页面的URL信息
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const currentDomain = tabs[0].url;
        const urlObj = new URL(currentDomain);
        const hostname = urlObj.hostname;
        const topLevelDomain = hostname.split('.').slice(-2).join('.');
        let path = currentDomain.substring(currentDomain.indexOf(topLevelDomain) + topLevelDomain.length);
        if (path === "/") {
            path = "";
        }

        chrome.storage.local.get(['recordings'], function (result) {
            const recordings = result.recordings || [];
            const taskListElement = document.getElementById('taskList');
            taskListElement.innerHTML = '';

            recordings.forEach(function (recording) {
                // 根据标签页状态过滤任务列表
                if (!showAllTasks && recording.domain) {
                    const urlObj2 = new URL(recording.domain);
                    const hostname2 = urlObj2.hostname;
                    const topLevelDomain2 = hostname2.split('.').slice(-2).join('.');
                    let path2 = recording.domain.substring(recording.domain.indexOf(topLevelDomain2) + topLevelDomain2.length);
                    if (path2 === "/") {
                        path2 = "";
                    }

                    if (path.length > 0) {
                        if (path !== path2) {
                            return;
                        }
                    } else {
                        if (topLevelDomain !== topLevelDomain2) {
                            return;
                        }
                    }
                }
                const taskItem = document.createElement('div');
                taskItem.className = 'task-item';

                // 任务名称容器
                const taskNameContainer = document.createElement('div');
                taskNameContainer.style.cssText = 'display: flex; align-items: center; margin-bottom: 8px;';

                // 任务名称显示区域
                const taskNameDisplay = document.createElement('div');
                taskNameDisplay.style.cssText = 'font-weight: bold; flex-grow: 1; margin-right: 8px;';
                taskNameDisplay.textContent = recording.displayName || recording.name;

                // 任务名称编辑输入框
                const taskNameInput = document.createElement('input');
                taskNameInput.type = 'text';
                taskNameInput.style.cssText = 'font-weight: bold; width: 100%; padding: 4px 8px; border: 1px solid #4285f4; border-radius: 3px; display: none;';
                taskNameInput.value = recording.displayName || recording.name;

                // 编辑按钮
                const editButton = document.createElement('button');
                editButton.style.cssText = 'padding: 2px 5px; background-color:rgb(238, 238, 238); color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;';
                editButton.textContent = '✍️';

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

                const taskInfo = document.createElement('div');
                taskInfo.className = 'task-info';
                // 显示域名（截短，去掉协议前缀，便于一眼区分任务归属的站点）
                const domainText = recording.domain
                    ? recording.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
                    : '未知';
                taskInfo.textContent = `域名: ${domainText} | 创建: ${formatTimestamp(recording.createdAt)} | 步骤: ${recording.actions.length}`;

                const taskActions = document.createElement('div');
                taskActions.className = 'task-actions';
                taskActions.style.cssText = 'flex-wrap: wrap; align-items: center;';

                // 重复次数输入框（默认 20 次）
                const repeatLabel = document.createElement('span');
                repeatLabel.textContent = '次数';
                repeatLabel.style.cssText = 'font-size: 0.85em; color: #666;';
                taskActions.appendChild(repeatLabel);

                const repeatInput = document.createElement('input');
                repeatInput.type = 'number';
                repeatInput.min = '1';
                repeatInput.max = '9999';
                repeatInput.value = '20';
                repeatInput.title = '重复次数，1 表示只播放一次';
                repeatInput.style.cssText = 'width: 56px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9em;';
                repeatInput.addEventListener('click', function (e) {
                    e.stopPropagation();
                });
                taskActions.appendChild(repeatInput);

                // 每轮间隔秒数（默认 1 秒）
                const intervalLabel = document.createElement('span');
                intervalLabel.textContent = '间隔(秒)';
                intervalLabel.style.cssText = 'font-size: 0.85em; color: #666;';
                taskActions.appendChild(intervalLabel);

                const intervalInput = document.createElement('input');
                intervalInput.type = 'number';
                intervalInput.min = '0';
                intervalInput.step = '0.5';
                intervalInput.value = '1';
                intervalInput.title = '每轮之间的等待时间（秒），0 表示不等待';
                intervalInput.style.cssText = 'width: 56px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9em;';
                intervalInput.addEventListener('click', function (e) {
                    e.stopPropagation();
                });
                taskActions.appendChild(intervalInput);

                // 播放按钮
                const playButton = document.createElement('button');
                playButton.className = 'play-btn';
                playButton.textContent = '播放';
                playButton.addEventListener('click', function () {
                    // 读取并校正重复次数，非法值一律按 1 处理
                    let repeatCount = parseInt(repeatInput.value, 10);
                    if (!Number.isFinite(repeatCount) || repeatCount < 1) {
                        repeatCount = 1;
                        repeatInput.value = '1';
                    }
                    if (repeatCount > 9999) {
                        repeatCount = 9999;
                        repeatInput.value = '9999';
                    }

                    // 读取并校正轮间间隔，非法/负值按 1 秒处理
                    let repeatInterval = parseFloat(intervalInput.value);
                    if (!Number.isFinite(repeatInterval) || repeatInterval < 0) {
                        repeatInterval = 1;
                        intervalInput.value = '1';
                    }
                    if (repeatInterval > 3600) {
                        repeatInterval = 3600;
                        intervalInput.value = '3600';
                    }

                    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                        chrome.runtime.sendMessage({
                            action: 'startReplay',
                            recordingName: recording.name,
                            repeatCount: repeatCount,
                            repeatInterval: repeatInterval
                        });
                    });
                });

                // 删除按钮
                const deleteButton = document.createElement('button');
                deleteButton.className = 'delete-btn';
                deleteButton.textContent = '删除';
                deleteButton.addEventListener('click', function () {
                    chrome.runtime.sendMessage({
                        action: 'deleteRecording',
                        recordingName: recording.name
                    }, function (response) {
                        if (response && response.success) {
                            // 删除成功后重新获取任务列表
                            chrome.runtime.sendMessage({ action: 'getRecordings' }, function (response) {
                                if (response && response.recordings) {
                                    loadTasks();
                                }
                            });
                        }
                    });
                });

                // 导出按钮：把录制导出成 JSON 文件，便于分享给他人导入
                const exportButton = document.createElement('button');
                exportButton.className = 'export-btn';
                exportButton.textContent = '导出';
                exportButton.title = '导出为文件，可分享给其他人导入';
                exportButton.addEventListener('click', function () {
                    exportRecording(recording);
                });

                // 详情按钮
                const detailsButton = document.createElement('button');
                detailsButton.className = 'details-btn';
                detailsButton.textContent = '详情';
                detailsButton.addEventListener('click', function () {
                    showTaskDetails(recording);
                });

                taskActions.appendChild(playButton);
                taskActions.appendChild(exportButton);
                taskActions.appendChild(detailsButton);
                taskActions.appendChild(deleteButton);

                taskItem.appendChild(taskNameContainer);
                taskItem.appendChild(taskInfo);
                taskItem.appendChild(taskActions);

                taskListElement.appendChild(taskItem);
            });
        });
    });
}

// 初始化加载任务列表和事件监听
document.addEventListener('DOMContentLoaded', function () {
    // 标签页切换事件
    const currentPageTab = document.getElementById('currentPageTab');
    const allTasksTab = document.getElementById('allTasksTab');

    currentPageTab.addEventListener('click', function () {
        if (showAllTasks) {
            showAllTasks = false;
            currentPageTab.style.backgroundColor = '#4285f4';
            currentPageTab.style.color = 'white';
            allTasksTab.style.backgroundColor = '#f0f0f0';
            allTasksTab.style.color = '#333';
            loadTasks();
        }
    });

    allTasksTab.addEventListener('click', function () {
        if (!showAllTasks) {
            showAllTasks = true;
            allTasksTab.style.backgroundColor = '#4285f4';
            allTasksTab.style.color = 'white';
            currentPageTab.style.backgroundColor = '#f0f0f0';
            currentPageTab.style.color = '#333';
            loadTasks();
        }
    });

    loadTasks();

    // 创建按钮点击事件
    const createButton = document.getElementById('createButton');
    createButton.addEventListener('click', function () {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            chrome.runtime.sendMessage({
                action: 'startRecording',
                recordingName: '新建录制_' + Date.now()
            });
        });
    });

    // 导入按钮：触发隐藏的文件选择框
    const importButton = document.getElementById('importButton');
    const importFile = document.getElementById('importFile');
    importButton.addEventListener('click', function () {
        importFile.value = '';
        importFile.click();
    });
    importFile.addEventListener('change', function () {
        if (importFile.files && importFile.files[0]) {
            importRecordingFromFile(importFile.files[0]);
        }
    });
});

// 显示任务详情
function showTaskDetails(recording) {
    const modal = document.getElementById('taskDetailsModal');
    const modalTitle = document.getElementById('modalTitle');
    const taskInfo = document.getElementById('taskInfo');
    const stepsList = document.getElementById('stepsList');

    modalTitle.textContent = `任务详情: ${recording.displayName || recording.name}`;
    taskInfo.innerHTML = `
        <div><strong>创建时间:</strong> ${formatTimestamp(recording.createdAt)}</div>
        <div><strong>任务地址:</strong> ${recording.domain ? `<a href="${recording.domain}" target="_blank" style="color: #4285f4; text-decoration: none; border-bottom: 1px solid #4285f4;">${recording.domain}</a>` : '未知'}</div>
        <div><strong>任务步骤:</strong> ${recording.actions.length}</div>
    `;

    stepsList.innerHTML = '';
    recording.actions.forEach(function (action, index) {
        const stepItem = document.createElement('div');
        stepItem.className = 'step-item';

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

    modal.style.display = 'flex';

    // 添加关闭按钮事件
    const closeButton = modal.querySelector('.modal-close-btn');
    closeButton.addEventListener('click', function () {
        modal.style.display = 'none';
    });
}

// 监听storage变化和URL变化，实时更新任务列表
chrome.storage.onChanged.addListener(function (changes, namespace) {
    if (namespace === 'local' && changes.recordings) {
        loadTasks();
    }
});

// 监听URL变化
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.url) {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0].id === tabId) {
                loadTasks();
            }
        });
    }
});

// 监听标签页切换
chrome.tabs.onActivated.addListener(function (activeInfo) {
    loadTasks();
});