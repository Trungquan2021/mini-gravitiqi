(function () {
  'use strict';

  // ==========================================
  // 1. CẤU HÌNH & TRẠNG THÁI HỆ THỐNG
  // ==========================================
  // Đọc giá trị đã lưu: ưu tiên tên khóa mà saveConfig() ghi, sau đó tới tên khóa cũ
  const loadSaved = (key, legacyGmKey, legacyLsKey, fallback) => {
    const gm = typeof GM_getValue !== 'undefined'
      ? (GM_getValue(key, '') || GM_getValue(legacyGmKey, ''))
      : '';
    return gm || localStorage.getItem('edunext_' + key) || localStorage.getItem(legacyLsKey) || fallback;
  };

  const savedProvider = loadSaved('provider', 'ai_provider', 'edunext_provider', 'auto');

  const CONFIG = {
    // Đã bỏ chế độ "Chỉ dùng Google Gemini", chỉ giữ 'auto' và 'groq'
    provider: savedProvider === 'groq' ? 'groq' : 'auto',
    subject: loadSaved('subject', 'subject_mode', 'edunext_subject', 'auto'),
    groqApiKey: loadSaved('groqApiKey', 'groq_api_key', 'edunext_groq_key', ''),
    groqModel: loadSaved('groqModel', 'groq_model', 'edunext_groq_model', 'openai/gpt-oss-120b'),
    geminiApiKey: loadSaved('geminiApiKey', 'gemini_api_key', 'edunext_gemini_key', ''),
    geminiModel: loadSaved('geminiModel', 'selected_model', 'edunext_model', 'gemini-3.6-flash'),
    groqKeyIndex: 0,
    geminiKeyIndex: 0,
    useVision: true,
    autoLoop: false,
    autoNextLesson: true,
    lastLessonSwitchTime: 0,
    autoSubmit: true,
    autoReady: true,
    delaySeconds: 5,
    uiMinimized: loadSaved('uiMinimized', 'ui_minimized', 'edunext_ui_minimized', 'false') === 'true',
    uiStealth: false,
    currentQuestion: '',
    currentAnswer: '',
    isSolving: false,
    lastProcessedSignature: '',
    lastHintClickedSig: '',
    hintWaitStartTime: 0,
    lastActionTime: 0,
    loopSolvedCount: 0,
  };

  // Tách danh sách nhiều API Key (ngăn cách bởi xuống dòng, dấu phẩy, chấm phẩy hoặc khoảng trắng)
  function parseKeyList(rawStr) {
    if (!rawStr || typeof rawStr !== 'string') return [];
    return [...new Set(
      rawStr
        .split(/[\r\n,;\s]+/)
        .map(k => k.trim())
        .filter(k => k.length >= 10)
    )];
  }

  const saveConfig = (key, val) => {
    CONFIG[key] = val;
    if (typeof GM_setValue !== 'undefined') GM_setValue(key, val);
    localStorage.setItem('edunext_' + key, val);
  };

  // ==========================================
  // 2. CROSS-ORIGIN HTTP REQUEST (BYPASS CORS / CSP)
  // ==========================================
  function crossOriginPost(url, payload, customHeaders = {}) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, customHeaders);
      if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
          method: 'POST',
          url: url,
          headers: headers,
          data: JSON.stringify(payload),
          timeout: 25000,
          onload: function (response) {
            if (response.status >= 200 && response.status < 300) {
              try {
                const data = JSON.parse(response.responseText);
                resolve({ ok: true, data });
              } catch (e) {
                reject(new Error("Lỗi đọc dữ liệu JSON: " + e.message));
              }
            } else {
              let errMsg = `Mã lỗi ${response.status}`;
              let isModelNotFound = response.status === 404;
              try {
                const errObj = JSON.parse(response.responseText);
                if (errObj.error?.message) {
                  errMsg += `: ${errObj.error.message}`;
                  if (errObj.error.message.includes('model') || errObj.error.message.includes('not found')) {
                    isModelNotFound = true;
                  }
                }
              } catch (_) {
                errMsg += ` ${response.statusText || response.responseText}`;
              }
              resolve({ ok: false, status: response.status, isModelNotFound, errMsg });
            }
          },
          onerror: function (err) {
            reject(new Error("Lỗi kết nối GM_xmlhttpRequest: " + (err.statusText || "Network Error")));
          },
          ontimeout: function () {
            reject(new Error("Quá thời gian chờ phản hồi (Timeout)"));
          }
        });
      } else {
        fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        }).then(async res => {
          if (!res.ok) {
            const errText = await res.text();
            resolve({ ok: false, status: res.status, isModelNotFound: res.status === 404, errMsg: `HTTP ${res.status}: ${errText}` });
          } else {
            const data = await res.json();
            resolve({ ok: true, data });
          }
        }).catch(err => {
          reject(new Error("Lỗi fetch (CORS/CSP chặn): " + err.message));
        });
      }
    });
  }

  // ==========================================
  // 3. TRÍCH XUẤT ĐỀ BÀI (NETWORK + CANVAS + DOM SCANNER)
  // ==========================================
  let latestDetectedQuestion = '';

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = args[0] ? (typeof args[0] === 'string' ? args[0] : args[0].url) : '';
      if (url && (url.includes('/chat') || url.includes('/lesson') || url.includes('/ai') || url.includes('/message') || url.includes('/session'))) {
        const clone = response.clone();
        clone.text().then(text => {
          try {
            const data = JSON.parse(text);
            extractQuestionFromData(data);
          } catch (_) {
            if (text.includes('Câu hỏi') || text.includes('Trả lời:') || text.includes('?')) {
              processRawText(text);
            }
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  const originalFillText = CanvasRenderingContext2D.prototype.fillText;
  let canvasTextBuffer = [];
  let canvasTimer = null;

  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    if (text && typeof text === 'string' && text.trim().length > 1) {
      canvasTextBuffer.push(text.trim());
      clearTimeout(canvasTimer);
      canvasTimer = setTimeout(() => {
        const fullContent = canvasTextBuffer.join(' ');
        canvasTextBuffer = [];
        if (fullContent.includes('Câu hỏi') || fullContent.includes('Trả lời') || fullContent.includes('TÓM TẮT') || fullContent.includes('?') || fullContent.includes('thừa cân')) {
          processRawText(fullContent);
        }
      }, 350);
    }
    return originalFillText.apply(this, arguments);
  };

  // Giữ nguyên dấu xuống dòng (\n) để bảo toàn cấu trúc Bảng số liệu Markdown và công thức!
  function cleanMessageText(raw) {
    if (!raw) return '';
    return raw
      .replace(/\r\n/g, '\n')
      .replace(/[0-9a-f]{24}/gi, '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
      .replace(/\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(:\d{2})?/g, '')
      .replace(/🧠\s*Đã chấm bằng AI/g, '')
      .replace(/INT:\s*[A-Z_]+/g, '')
      .replace(/Feedback|Sửa công thức/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Trích xuất khung "Gợi ý (Hint)" từ cả React Fiber Metadata lẫn DOM của .assistant-row cuối cùng
  function extractHintFromDOMAndMetadata(lastMsg) {
    let isHintLoading = false;
    const hintParts = [];

    try {
      // 1. Quét trong lastMsg.metadata (nếu EduNext lưu hint ở các trường metadata phụ)
      const meta = lastMsg?.metadata || {};
      const candidateKeys = ['hint', 'hints', 'teacher_hint', 'suggestion', 'feedback', 'explanation', 'guide', 'hint_content', 'hint_block'];
      for (const key of candidateKeys) {
        const val = meta[key];
        if (!val) continue;
        if (typeof val === 'string' && val.trim().length > 3) {
          hintParts.push(cleanMessageText(val));
        } else if (Array.isArray(val)) {
          val.forEach(item => {
            const s = typeof item === 'string' ? item : (item?.content || item?.text || '');
            if (s && s.trim().length > 3) hintParts.push(cleanMessageText(s));
          });
        } else if (typeof val === 'object') {
          const s = val.content || val.text || val.message || '';
          if (s && s.trim().length > 3) hintParts.push(cleanMessageText(s));
        }
      }

      // 2. Quét trực tiếp trên DOM của tin nhắn bot mới nhất (.assistant-row)
      // (Vì khung Gợi ý dưới đáy câu hỏi thường được render ngoài question_block.content)
      const assistantRows = Array.from(document.querySelectorAll('.assistant-row, .message-assistant, [class*="assistant-row"]'));
      const lastBotRow = assistantRows.length > 0 ? assistantRows[assistantRows.length - 1] : null;
      if (lastBotRow) {
        const rawDom = lastBotRow.innerText || '';
        if (rawDom.includes('Đang chuẩn bị...')) {
          isHintLoading = true;
        }

        // 2a. Tìm các thẻ con chứa class liên quan đến hint/gợi ý
        const hintEls = lastBotRow.querySelectorAll('[class*="hint"], [class*="Hint"], [class*="suggest"], [class*="guide"]');
        hintEls.forEach(el => {
          const t = cleanMessageText(el.innerText || '')
            .replace(/^Gợi ý\s*/i, '')
            .replace(/Đang chuẩn bị\.\.\./gi, '')
            .trim();
          if (t && t.length > 8) hintParts.push(t);
        });

        // 2b. Tách phần văn bản nằm bên dưới dòng "Trả lời: [đáp án của bạn]" trong .assistant-row
        // (Đây chính là nơi EduNext chèn nội dung Hint 1, Hint 2... sau khi học sinh trả lời sai)
        const markerMatch = rawDom.match(/Trả lời:\s*\[đáp án của bạn\]([\s\S]*)$/i);
        if (markerMatch && markerMatch[1]) {
          const afterMarker = cleanMessageText(markerMatch[1])
            .replace(/^Gợi ý\s*$/gim, '')
            .replace(/Đang chuẩn bị\.\.\./gi, '')
            .replace(/Nộp câu trả lời|Sẵn sàng/gi, '')
            .trim();
          if (afterMarker && afterMarker.length > 8) {
            hintParts.push(afterMarker);
          }
        }
      }
    } catch (_) {}

    const qBlockClean = cleanMessageText(lastMsg?.metadata?.question_block?.content || '');
    const contentClean = cleanMessageText(lastMsg?.content || '');

    // Lọc trùng lặp với nội dung chính
    const uniqueHints = [...new Set(hintParts)].filter(h => {
      if (!h || h.length < 5) return false;
      if (qBlockClean && qBlockClean.includes(h)) return false;
      if (contentClean && contentClean === h) return false;
      return true;
    });

    return {
      isHintLoading,
      hintText: uniqueHints.join('\n')
    };
  }

  function getReactFiberState() {
    try {
      const targetWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const chatMessagesEl = targetWin.document.querySelector('.chat-messages');
      if (!chatMessagesEl) return null;
      const fiberKey = Object.keys(chatMessagesEl).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return null;
      let curr = chatMessagesEl[fiberKey];
      while (curr && (!curr.memoizedProps || !curr.memoizedProps.messages)) {
        curr = curr.return;
      }
      if (!curr || !curr.memoizedProps) return null;
      const p = curr.memoizedProps;
      const msgs = p.messages || [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;

      // Thu thập lịch sử các đáp án vừa bị chấm SAI ở câu hiện tại + bảng dữ liệu từ các câu trước
      const wrongAnswers = [];
      let earlierTableContext = '';

      for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 10; i--) {
        const m = msgs[i];
        if (!m) continue;
        if (m.role === 'user' && m.content) {
          const uText = m.content.trim();
          if (uText && uText.toLowerCase() !== 'sẵn sàng' && uText.toLowerCase() !== 'gợi ý') {
            wrongAnswers.unshift(uText);
          }
        } else if (m.role === 'assistant') {
          const qBlock = m.metadata?.question_block?.content || '';
          // Lưu lại bảng số liệu ở các câu trước nếu câu hiện tại không in lại bảng
          if (!earlierTableContext && i < msgs.length - 1 && (qBlock.includes('|') || qBlock.includes('Bảng'))) {
            earlierTableContext = qBlock;
          }
          // Nếu gặp điểm bắt đầu của câu hỏi mới (NEW_EXERCISE / THEORY / SUMMARY) hoặc câu trả lời trước đó đã ĐÚNG thì dừng gom đáp án sai
          const fs = m.metadata?.flow_status || '';
          const isCorr = m.metadata?.is_correct;
          if (i < msgs.length - 1 && (isCorr === true || fs === 'NEW_EXERCISE' || fs === 'EXERCISE' || fs === 'THEORY' || fs === 'SUMMARY')) {
            break;
          }
        }
      }

      // Nếu tin nhắn cuối cùng của bot là câu hỏi mới hoàn toàn (is_correct === true ở bước vừa rồi), xóa danh sách sai cũ
      if (lastMsg?.metadata?.is_correct === true || lastMsg?.metadata?.flow_status === 'NEW_EXERCISE' || lastMsg?.metadata?.flow_status === 'EXERCISE') {
        wrongAnswers.length = 0;
      }

      const { isHintLoading, hintText } = extractHintFromDOMAndMetadata(lastMsg);

      return {
        isStreaming: !!p.isStreaming,
        isHintLoading,
        hintText,
        totalMessages: msgs.length,
        lastRole: lastMsg?.role || '',
        content: lastMsg?.content || '',
        questionBlock: lastMsg?.metadata?.question_block?.content || '',
        flowStatus: lastMsg?.metadata?.flow_status || '',
        isCorrect: lastMsg?.metadata?.is_correct,
        wrongAnswers,
        earlierTableContext,
        messageId: lastMsg?.id || ''
      };
    } catch (_) {
      return null;
    }
  }

  function buildStructuredQuestionPrompt(reactState) {
    if (!reactState) return '';
    const sections = [];

    if (reactState.earlierTableContext && !(reactState.questionBlock || '').includes('|')) {
      sections.push(`[DỮ LIỆU / BẢNG SỐ LIỆU Ở CÂU TRƯỚC]:\n${cleanMessageText(reactState.earlierTableContext)}`);
    }

    if (reactState.wrongAnswers && reactState.wrongAnswers.length > 0) {
      sections.push(
        `[⚠️ CẢNH BÁO - CÁC ĐÁP ÁN ĐÃ NỘP NHƯNG BỊ CHẤM SAI (TUYỆT ĐỐI KHÔNG TRẢ LỜI LẠI CÁC GIÁ TRỊ NÀY)]:\n` +
        reactState.wrongAnswers.map((a, idx) => `  - Lần thử sai ${idx + 1}: ${a}`).join('\n')
      );
    }

    if (reactState.content) {
      sections.push(`[💬 NHẬN XÉT & PHẢN HỒI CỦA GIÁO VIÊN AI EDUNEXT KHI CHẤM BÀI]:\n${cleanMessageText(reactState.content)}`);
    }

    if (reactState.hintText) {
      sections.push(`[💡 GỢI Ý CỦA EDUNEXT (HƯỚNG DẪN CÁCH GIẢI ĐÚNG - BẮT BUỘC LÀM THEO HƯỚNG DẪN NÀY)]:\n${reactState.hintText}`);
    }

    if (reactState.questionBlock) {
      sections.push(`[🎯 ĐỀ BÀI & CÂU HỎI CHÍNH CẦN GIẢI]:\n${cleanMessageText(reactState.questionBlock)}`);
    }

    return sections.join('\n\n');
  }

  function getLatestChatState() {
    const reactState = getReactFiberState();
    const allRows = Array.from(document.querySelectorAll('.assistant-row, .user-row, .message-assistant, .message-user'));
    const assistantRows = Array.from(document.querySelectorAll('.assistant-row, .message-assistant, [class*="assistant-row"]'));
    const isStreaming = (reactState && reactState.isStreaming) ||
      !!document.querySelector('.streaming-indicator') ||
      document.body.innerText.includes('Đang chờ phản hồi');

    const lastRow = allRows.length > 0 ? allRows[allRows.length - 1] : null;
    const isWaitingForBot = reactState
      ? reactState.lastRole === 'user'
      : (lastRow ? (lastRow.classList.contains('user-row') || lastRow.classList.contains('message-user')) : false);

    let latestBotText = '';
    if (reactState && (reactState.questionBlock || reactState.content)) {
      latestBotText = buildStructuredQuestionPrompt(reactState);
    }
    if (!latestBotText && assistantRows.length > 0) {
      const lastBotRow = assistantRows[assistantRows.length - 1];
      latestBotText = cleanMessageText(lastBotRow.innerText || '');
    }
    if (!latestBotText || latestBotText.length < 5) {
      latestBotText = cleanMessageText(latestDetectedQuestion || '');
    }

    const flowStatus = reactState?.flowStatus || '';
    const msgCount = reactState ? reactState.totalMessages : assistantRows.length;
    const wrongCount = reactState?.wrongAnswers?.length || 0;
    const hintText = reactState?.hintText || '';
    const isHintLoading = !!reactState?.isHintLoading;
    const signature = `${msgCount}::${flowStatus}::w${wrongCount}::h${hintText.slice(-80)}::${latestBotText.slice(-250)}`;
    return {
      assistantCount: msgCount,
      isStreaming,
      isHintLoading,
      hintText,
      wrongCount,
      isWaitingForBot,
      latestBotText,
      flowStatus,
      signature
    };
  }

  function scanLatestQuestionFromDOM() {
    const reactState = getReactFiberState();
    if (reactState && (reactState.questionBlock || reactState.content)) {
      const fiberText = buildStructuredQuestionPrompt(reactState);
      if (fiberText.length > 5) return fiberText;
    }

    const assistantRows = Array.from(document.querySelectorAll('.assistant-row, .message-assistant, [class*="assistant"]'));
    for (let i = assistantRows.length - 1; i >= 0; i--) {
      const row = assistantRows[i];
      const text = cleanMessageText(row.innerText ? row.innerText.trim() : '');
      if (text.length > 10 && (text.includes('Câu hỏi') || text.includes('?') || text.includes('thỏa mãn') || text.includes('thừa cân') || text.includes('Tính') || text.includes('tính') || text.includes('Trả lời'))) {
        return text;
      }
    }

    const chatContainer = document.querySelector('.chat-messages') || document.querySelector('.chat-content') || document.querySelector('.chat-body');
    if (chatContainer && chatContainer.innerText) {
      const fullText = chatContainer.innerText;
      const chunks = fullText.split('\n\n').filter(c => c.trim().length > 10);
      for (let i = chunks.length - 1; i >= 0; i--) {
        const chunk = cleanMessageText(chunks[i].trim());
        if (chunk.includes('Câu hỏi') || chunk.includes('?') || chunk.includes('Trả lời: [') || chunk.includes('thừa cân')) {
          return chunk;
        }
      }
      return cleanMessageText(fullText.slice(-1500));
    }

    return '';
  }

  function processRawText(raw) {
    if (!raw) return;
    const cleaned = cleanMessageText(raw.replace(/\\n/g, '\n'));
    if (cleaned.length > 10 && cleaned !== latestDetectedQuestion) {
      latestDetectedQuestion = cleaned;
      CONFIG.currentQuestion = cleaned;
      updateUIStatus('🟢 Đã bắt được câu hỏi mới!');
      renderQuestionUI(cleaned);
    }
  }

  function extractQuestionFromData(obj) {
    if (!obj) return;
    const str = JSON.stringify(obj);
    if (str.includes('Câu hỏi') || str.includes('TÓM TẮT') || str.includes('Trả lời:') || str.includes('?')) {
      processRawText(str);
    }
  }

  // ==========================================
  // 4. TỰ ĐỘNG ĐIỀN ĐÁP ÁN & VÒNG LẶP AUTO LOOP
  // ==========================================
  function setReactInputValue(inputEl, value) {
    if (!inputEl) return false;
    inputEl.focus();

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(inputEl, value);
    } else {
      inputEl.value = value;
    }

    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
    return true;
  }

  // Tách đúng dòng "Trả lời: ..." cuối cùng từ phản hồi có bước tính nháp của AI
  function extractFinalAnswerLine(rawAnswer) {
    if (!rawAnswer) return '';
    const lines = rawAnswer
      .split('\n')
      .map(l => l.replace(/^\*\*|\*\*$/g, '').replace(/^`+|`+$/g, '').trim())
      .filter(Boolean);

    // Ưu tiên tìm từ dưới lên dòng bắt đầu bằng "Trả lời:"
    for (let i = lines.length - 1; i >= 0; i--) {
      const idx = lines[i].toLowerCase().indexOf('trả lời:');
      if (idx !== -1) {
        return lines[i].slice(idx).replace(/\*\*$/g, '').trim();
      }
    }

    const lastLine = lines[lines.length - 1] || rawAnswer.trim();
    return lastLine.toLowerCase().startsWith('trả lời:') ? lastLine : `Trả lời: ${lastLine}`;
  }

  function submitCurrentAnswer(answerText) {
    const textarea = document.querySelector('.w-md-editor-text-input') || document.querySelector('textarea');
    if (!textarea) {
      showToast('❌ Không tìm thấy ô nhập câu trả lời!');
      return false;
    }

    const formatted = extractFinalAnswerLine(answerText);

    setReactInputValue(textarea, formatted);
    CONFIG.lastActionTime = Date.now();
    showToast('✏️ Đã điền đáp án, đang nộp...');

    setTimeout(() => {
      const submitBtn = Array.from(document.querySelectorAll('.exercise-intent-column__item, button')).find(
        btn => btn.innerText && btn.innerText.includes('Nộp câu trả lời')
      );

      if (submitBtn && !submitBtn.disabled) {
        submitBtn.click();
        CONFIG.loopSolvedCount++;
        updateLoopCounterUI();
        showToast(`🚀 Đã nộp câu #${CONFIG.loopSolvedCount}!`);
        updateUIStatus(`🚀 Đã nộp (#${CONFIG.loopSolvedCount})! Chờ chấm...`);
      } else {
        const sendBtn = document.querySelector('.w-send-btn');
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          CONFIG.loopSolvedCount++;
          updateLoopCounterUI();
          showToast(`🚀 Đã gửi câu #${CONFIG.loopSolvedCount}!`);
          updateUIStatus(`🚀 Đã gửi (#${CONFIG.loopSolvedCount})! Chờ chấm...`);
        } else {
          showToast('⚠️ Nút nộp bị khóa, đang thử lại...');
        }
      }
    }, 800);
    return true;
  }

  function sendReadySignal() {
    const readyBtn = Array.from(document.querySelectorAll('button')).find(
      b => b.innerText && b.innerText.trim() === 'Sẵn sàng'
    );
    if (readyBtn) {
      readyBtn.click();
      CONFIG.lastActionTime = Date.now();
      setTimeout(() => {
        const sendBtn = document.querySelector('.w-send-btn');
        if (sendBtn && !sendBtn.disabled) sendBtn.click();
      }, 450);
      showToast('⏩ Đã tự động bấm "Sẵn sàng" + Gửi!');
      updateUIStatus('⏩ Đã gửi "Sẵn sàng", chờ phần mới...');
      return true;
    }

    // Nếu không có nút Sẵn sàng nhưng câu hỏi yêu cầu trả lời Sẵn sàng
    const textarea = document.querySelector('.w-md-editor-text-input') || document.querySelector('textarea');
    if (textarea) {
      setReactInputValue(textarea, 'Sẵn sàng');
      CONFIG.lastActionTime = Date.now();
      setTimeout(() => {
        const sendBtn = document.querySelector('.w-send-btn');
        const submitBtn = Array.from(document.querySelectorAll('.exercise-intent-column__item, button')).find(
          btn => btn.innerText && btn.innerText.includes('Nộp câu trả lời')
        );
        if (sendBtn && !sendBtn.disabled) sendBtn.click();
        else if (submitBtn && !submitBtn.disabled) submitBtn.click();
      }, 600);
      showToast('⏩ Đã tự động điền & gửi "Sẵn sàng"!');
      updateUIStatus('⏩ Đã gửi "Sẵn sàng", chờ câu hỏi...');
      return true;
    }
    return false;
  }

  // ==========================================
  // 4b. TỰ ĐỘNG CHUYỂN SANG BÀI TIẾP THEO
  // ==========================================
  // Nút bài học ở sidebar có dạng: "09\nBài 9 - Tên bài\n2/4 cấu trúc"
  function getLessonButtons() {
    return Array.from(document.querySelectorAll('button'))
      .map(btn => {
        const text = (btn.innerText || '').replace(/\s+/g, ' ').trim();
        const m = text.match(/Bài\s+(\d+)\s*-/);
        if (!m) return null;
        const prog = text.match(/(\d+)\s*\/\s*(\d+)\s*cấu trúc/);
        const done = prog ? parseInt(prog[1], 10) : 0;
        const total = prog ? parseInt(prog[2], 10) : 0;
        return {
          btn,
          number: parseInt(m[1], 10),
          text,
          done,
          total,
          isComplete: total > 0 && done >= total
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.number - b.number);
  }

  // Xác định bài đang mở qua breadcrumb "... / Toán 11 - KNTT / Bài 9 - ..."
  function getCurrentLessonInfo() {
    const chatArea = document.querySelector('#chat-popup, .chat-window, .chat-body') || document.body;
    const crumb = (chatArea.innerText || '').match(/\/\s*Bài\s+(\d+)\s*-/);
    if (!crumb) return null;
    const number = parseInt(crumb[1], 10);
    const lessons = getLessonButtons();
    return lessons.find(l => l.number === number) || { number, done: 0, total: 0, isComplete: false };
  }

  function goToNextLesson(current) {
    if (!current) return false;
    if (Date.now() - CONFIG.lastLessonSwitchTime < 15000) return false; // tránh bấm liên tục

    const next = getLessonButtons().find(l => l.number > current.number && !l.isComplete);
    if (!next) {
      updateUIStatus('🏁 Đã hoàn thành tất cả các bài! Dừng Auto Loop.');
      showToast('🏁 Không còn bài nào chưa hoàn thành. Đã dừng Auto Loop.');
      setAutoLoop(false);
      return false;
    }

    CONFIG.lastLessonSwitchTime = Date.now();
    CONFIG.lastActionTime = Date.now();
    CONFIG.lastProcessedSignature = '';
    CONFIG.currentQuestion = '';
    latestDetectedQuestion = '';
    next.btn.click();
    updateUIStatus(`➡️ Bài ${current.number} xong, chuyển sang Bài ${next.number}...`);
    showToast(`➡️ Tự động chuyển sang Bài ${next.number}`);
    return true;
  }

  function clickStartLessonIfPresent() {
    const startBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const t = (b.innerText || '').trim();
      return t === 'Bắt đầu học' || t === 'Tiếp tục học';
    });
    if (startBtn && !startBtn.disabled) {
      startBtn.click();
      CONFIG.lastActionTime = Date.now();
      CONFIG.lastProcessedSignature = '';
      updateUIStatus('▶️ Đã bấm "Bắt đầu học" cho bài mới...');
      return true;
    }
    return false;
  }

  async function runAutoLoopStep() {
    if (!CONFIG.autoLoop || CONFIG.isSolving) return;

    // 1. Kiểm tra lỗi server 503/429
    if (detectServerError()) return;

    // 1b. Màn hình bài mới chưa bắt đầu -> bấm "Bắt đầu học"
    if (Date.now() - CONFIG.lastActionTime > 3000 && clickStartLessonIfPresent()) return;

    // 2. Kiểm tra trạng thái khung chat
    const state = getLatestChatState();
    if (state.isStreaming) {
      updateUIStatus('⏳ EduNext đang gõ phản hồi...');
      return;
    }

    // 3. Đảm bảo khoảng nghỉ chống 429 sau lần gửi gần nhất
    const cooldownMs = Math.max(CONFIG.delaySeconds, 4) * 1000;
    if (Date.now() - CONFIG.lastActionTime < cooldownMs) {
      return;
    }

    if (state.isWaitingForBot) {
      updateUIStatus('⏳ Đang chờ EduNext chấm bài...');
      return;
    }

    // 3b. Nếu EduNext đang hiển thị "Gợi ý - Đang chuẩn bị..." sau khi trả lời sai -> chờ tối đa 7s để lấy trọn Gợi ý
    if (state.isHintLoading) {
      if (!CONFIG.hintWaitStartTime) CONFIG.hintWaitStartTime = Date.now();
      if (Date.now() - CONFIG.hintWaitStartTime < 7500) {
        updateUIStatus('💡 Đang chờ EduNext tạo xong Gợi ý...');
        return;
      }
    } else {
      CONFIG.hintWaitStartTime = 0;
    }

    // 3c. Nếu đã sai từ 2 lần trở lên ở câu hiện tại mà chưa có Gợi ý, tự động bấm nút "Gợi ý" (nếu có) 1 lần
    if (state.wrongCount >= 2 && !state.hintText && CONFIG.lastHintClickedSig !== state.signature) {
      const hintBtn = Array.from(document.querySelectorAll('.exercise-intent-column__item, button')).find(b => {
        const t = (b.innerText || '').trim();
        return t === 'Gợi ý' || t === 'Xem gợi ý' || t.includes('💡 Gợi ý');
      });
      if (hintBtn && !hintBtn.disabled) {
        CONFIG.lastHintClickedSig = state.signature;
        CONFIG.lastActionTime = Date.now();
        CONFIG.hintWaitStartTime = Date.now();
        hintBtn.click();
        updateUIStatus('💡 Đã sai >= 2 lần -> Tự bấm "Gợi ý" để lấy hướng dẫn...');
        showToast('💡 Đang lấy Gợi ý từ EduNext để giải lại chuẩn xác!');
        return;
      }
    }

    // 3d. Bài hiện tại đã đủ X/X cấu trúc -> tự chuyển sang bài kế tiếp
    if (CONFIG.autoNextLesson) {
      const lesson = getCurrentLessonInfo();
      if (lesson && lesson.isComplete) {
        goToNextLesson(lesson);
        return;
      }
    }

    // 4. Kiểm tra xem bài học đã hoàn thành 100% chưa
    const lowerText = state.latestBotText.toLowerCase();
    if (
      state.flowStatus === 'COMPLETED' ||
      (lowerText.includes('chúc mừng') && lowerText.includes('hoàn thành bài học')) ||
      lowerText.includes('hẹn gặp em ở buổi học tiếp theo') ||
      lowerText.includes('hoàn thành toàn bộ nội dung')
    ) {
      updateUIStatus('🎉 Đã hoàn thành 100% bài học này!');
      if (state.signature !== CONFIG.lastProcessedSignature) {
        CONFIG.lastProcessedSignature = state.signature;
        showToast('🎉 Chúc mừng! Bài học đã hoàn thành 100%!');
      }
      if (CONFIG.autoNextLesson) {
        goToNextLesson(getCurrentLessonInfo());
      }
      return;
    }

    // 5. Kiểm tra nút hoặc câu hỏi "Sẵn sàng chuyển sang phần tiếp theo"
    const hasReadyButton = Array.from(document.querySelectorAll('button')).some(
      b => b.innerText && b.innerText.trim() === 'Sẵn sàng'
    );
    const asksReady = state.flowStatus === 'SUMMARY' ||
      lowerText.includes('sẵn sàng chuyển sang') ||
      lowerText.includes('bạn đã sẵn sàng') ||
      lowerText.includes('em đã sẵn sàng');

    if ((hasReadyButton || asksReady) && state.signature !== CONFIG.lastProcessedSignature) {
      CONFIG.lastProcessedSignature = state.signature;
      sendReadySignal();
      return;
    }

    // 6. Phát hiện câu hỏi mới (hoặc câu hỏi yêu cầu làm lại kèm Gợi ý) chưa được giải
    if (state.latestBotText && state.latestBotText.length > 10 && state.signature !== CONFIG.lastProcessedSignature) {
      CONFIG.currentQuestion = state.latestBotText;
      renderQuestionUI(state.latestBotText);
      const retryNote = state.wrongCount > 0 ? ` (Giải lại lần ${state.wrongCount + 1}${state.hintText ? ' + Có Gợi ý 💡' : ''})` : '';
      updateUIStatus(`🔄 Auto Loop: Đang giải${retryNote}...`);
      const ok = await solveWithAI(true);
      if (ok) {
        // Chỉ đánh dấu đã giải xong khi gọi AI thành công (nếu lỗi mạng/429 sẽ tự thử lại ở nhịp sau)
        CONFIG.lastProcessedSignature = state.signature;
      } else {
        CONFIG.lastActionTime = Date.now();
      }
    }
  }

  // ==========================================
  // 5. PROMPT CHUYÊN BIỆT THEO TỪNG MÔN HỌC (MULTI-SUBJECT PROMPT)
  // ==========================================
  const SUBJECT_PROMPTS = {
    toan: {
      label: '📐 Toán học',
      rules: `KIẾN THỨC & QUY TẮC MÔN TOÁN (SGK KẾT NỐI TRI THỨC):
- Công thức Thống kê mẫu số liệu ghép nhóm:
  + Giá trị đại diện nhóm [a; b) là c_i = (a + b) / 2. Cỡ mẫu n = tổng các tần số n_i.
  + Số trung bình: x_tb = (n_1*c_1 + ... + n_k*c_k) / n.
  + Trung vị M_e (hoặc Q_2): Tìm nhóm m đầu tiên có tần số tích lũy >= n/2. Công thức: M_e = u_m + ((n/2 - C) / n_m) * (u_{m+1} - u_m), với u_m là đầu mút trái nhóm m, C là tần số tích lũy của nhóm liền trước nhóm m, n_m là tần số nhóm m.
  + Tứ phân vị Q_1, Q_3: Thay n/2 bằng n/4 (cho Q_1) hoặc 3n/4 (cho Q_3).
  + Mốt M_o: Nhóm m có tần số lớn nhất. M_o = u_m + ((n_m - n_{m-1}) / ((n_m - n_{m-1}) + (n_m - n_{m+1}))) * (u_{m+1} - u_m) (nếu nhóm đầu tiên thì n_{m-1} = 0).
  + Chia khoảng biến thiên R = max - min thành k nhóm có độ dài nguyên d bằng nhau: tổng độ dài k*d phải LỚN HƠN R (k*d > R) -> chọn số nguyên d nhỏ nhất thỏa mãn k*d > R (hoặc làm theo đúng chỉ dẫn ở mục [💡 GỢI Ý CỦA EDUNEXT]).
- Lượng giác, Dãy số, Cấp số cộng/nhân, Giới hạn, Đạo hàm, Xác suất, Hình không gian: Tính chính xác từng bước, ưu tiên dùng DẤU PHẨY (,) cho số thập phân theo chuẩn SGK Việt Nam (ví dụ: 51,81 hoặc 6,83) trừ khi gợi ý yêu cầu dấu chấm.`
    },
    hoa: {
      label: '🧪 Hóa học',
      rules: `KIẾN THỨC & QUY TẮC MÔN HÓA HỌC (CHƯƠNG TRÌNH GDPT 2018 - KẾT NỐI TRI THỨC):
- BẮT BUỘC dùng danh pháp IUPAC tiếng Anh chuẩn SGK mới: nitrogen (N2), ammonia (NH3), ammonium (NH4+), nitric acid (HNO3), sulfur (S), sulfur dioxide (SO2), sulfuric acid (H2SO4), sodium (Na), potassium (K), iron (Fe), copper (Cu), aluminium (Al), ethylic alcohol, alkane, alkene...
- Giải thích tính chất dựa trên cấu tạo phân tử:
  + Phân tử N2 có liên kết ba bền vững (N≡N, năng lượng liên kết lớn 945 kJ/mol) -> rất trơ về mặt hóa học ở nhiệt độ thường (dùng bảo quản thực phẩm, mẫu vật).
  + Nitrogen lỏng có nhiệt độ sôi rất thấp (-196°C) -> dùng làm môi trường đông lạnh bảo quản máu, mẫu vật sinh học.
  + Ammonia (NH3) tan tốt trong nước do phân tử phân cực và tạo liên kết hydrogen với nước; có tính base yếu và tính khử.
- Cân bằng hóa học (Le Chatelier), tính pH, tốc độ phản ứng: Trả lời ngắn gọn, đúng trọng tâm từ khóa SGK.`
    },
    ly: {
      label: '⚡ Vật lí',
      rules: `KIẾN THỨC & QUY TẮC MÔN VẬT LÍ (SGK KẾT NỐI TRI THỨC):
- Đổi tất cả đại lượng về hệ đơn vị chuẩn SI (m, kg, s, rad, Hz, N, J, W, V, A, C) trước khi thay vào công thức, sau đó đổi kết quả cuối cùng về đúng đơn vị mà đề bài hỏi (ví dụ: cm, mm, ms, kJ, mA, µC).
- Dao động điều hòa: x = A*cos(ωt + φ), v_max = ωA, a_max = ω^2*A, T = 2π/ω = 1/f.
- Sóng cơ & Giao thoa: λ = v*T = v/f; khoảng vân i = λD/a; bước sóng, tần số, biên độ, pha dao động.
- Điện trường & Dòng điện: Định luật Coulomb, cường độ điện trường E, điện dung C, định luật Ohm, công suất điện. Làm tròn đúng chữ số thập phân đề yêu cầu.`
    },
    sinh: {
      label: '🧬 Sinh học',
      rules: `KIẾN THỨC & QUY TẮC MÔN SINH HỌC (SGK KẾT NỐI TRI THỨC):
- Sử dụng thuật ngữ chuẩn SGK Sinh học GDPT 2018: trao đổi chất và chuyển hóa năng lượng, quang hợp (pha sáng, pha tối, thực vật C3, C4, CAM), hô hấp tế bào (đường phân, chu trình Krebs, chuỗi truyền electron), dinh dưỡng khoáng và nitrogen ở thực vật, tuần hoàn, miễn dịch, bài tiết, cân bằng nội môi, cảm ứng, sinh trưởng và phát triển, di truyền phân tử (DNA, RNA, phiên mã, dịch mã).
- Câu trả lời tự luận phải ngắn gọn (1 câu hoặc cụm từ khóa trọng tâm), đúng bản chất sinh học.`
    },
    anh: {
      label: '🇬🇧 Tiếng Anh',
      rules: `KIẾN THỨC & QUY TẮC MÔN TIẾNG ANH (GLOBAL SUCCESS):
- Kiểm tra kỹ ngữ pháp (thì động từ, câu bị động, câu điều kiện, mệnh đề quan hệ, danh động từ/động từ nguyên mẫu, giới từ, từ loại) và chính tả tiếng Anh.
- Ở dòng "Trả lời: " cuối cùng, CHỈ ghi duy nhất đáp án tiếng Anh cần điền (từ, cụm từ, chữ cái A/B/C/D hoặc câu hoàn chỉnh), TUYỆT ĐỐI KHÔNG kèm giải thích tiếng Việt trong dòng "Trả lời: ".`
    },
    tin: {
      label: '💻 Tin học',
      rules: `KIẾN THỨC & QUY TẮC MÔN TIN HỌC (SGK KẾT NỐI TRI THỨC):
- Lập trình Python chuẩn SGK: kiểu dữ liệu (int, float, str, bool, list), vòng lặp for/while, hàm def, độ phức tạp thuật toán O(1), O(log n), O(n), O(n^2), tìm kiếm tuần tự/nhị phân, sắp xếp chọn/nổi bọt/chèn, Cơ sở dữ liệu quan hệ & SQL.
- Dòng "Trả lời: " chỉ ghi kết quả chạy chương trình, câu lệnh ngắn gọn hoặc thuật ngữ chính xác.`
    },
    van_su_dia_ktpl: {
      label: '📖 Văn / Sử / Địa / KTPL',
      rules: `KIẾN THỨC & QUY TẮC CÁC MÔN XÃ HỘI (NGỮ VĂN, LỊCH SỬ, ĐỊA LÍ, GDKT & PL - SGK KẾT NỐI TRI THỨC):
- Bám sát từ khóa trọng tâm trong SGK Kết nối tri thức với cuộc sống.
- Dòng "Trả lời: " phải cô đọng, súc tích (1-2 câu hoặc liệt kê đúng các ý chính), tránh viết lan man dài dòng.`
    }
  };

  function detectCurrentSubject(questionText = '') {
    if (CONFIG.subject && CONFIG.subject !== 'auto' && SUBJECT_PROMPTS[CONFIG.subject]) {
      return CONFIG.subject;
    }

    const pageHeader = (
      (document.querySelector('#chat-popup, .chat-window, .chat-body')?.innerText || '').slice(0, 600) +
      ' ' + (document.title || '')
    ).toLowerCase();
    const qLower = (questionText || '').toLowerCase();
    const combined = pageHeader + ' ' + qLower;

    // 1. Ưu tiên nhận diện từ Breadcrumb / Tên khóa học trên EduNext
    if (/toán|_toan|toan\s*\d+|đại số|hình học|thống kê|tứ phân vị|trung vị|mẫu số liệu|cấp số|lượng giác|đạo hàm/.test(combined)) {
      return 'toan';
    }
    if (/hóa học|hoá học|_hoa|hoa\s*\d+|nitrogen|ammonia|sulfur|alkane|alkene|hữu cơ|vô cơ|cân bằng hóa học|phản ứng|nguyên tử|phân tử/.test(combined)) {
      return 'hoa';
    }
    if (/vật lí|vật lý|_ly|_vatli|dao động|sóng cơ|bước sóng|tần số|điện trường|dòng điện|cảm ứng từ|nhiệt động lực/.test(combined)) {
      return 'ly';
    }
    if (/sinh học|_sinh|quang hợp|hô hấp tế bào|trao đổi chất|di truyền|nhiễm sắc thể|tế bào|enzyme/.test(combined)) {
      return 'sinh';
    }
    if (/tiếng anh|english|_anh|global success|grammar|vocabulary|rewrite the sentence|choose the correct/.test(combined)) {
      return 'anh';
    }
    if (/tin học|_tin|python|thuật toán|cơ sở dữ liệu|sql|mảng|danh sách/.test(combined)) {
      return 'tin';
    }
    if (/lịch sử|địa lí|địa lý|ngữ văn|kinh tế và pháp luật|gdkt|ktpl/.test(combined)) {
      return 'van_su_dia_ktpl';
    }

    return 'toan';
  }

  function getSystemPromptForQuestion(questionText = '') {
    const subjectKey = detectCurrentSubject(questionText);
    const subj = SUBJECT_PROMPTS[subjectKey] || SUBJECT_PROMPTS.toan;

    const prompt = `Bạn là giáo viên giỏi giải bài tập THPT & Đại học (chuyên sâu môn ${subj.label} - SGK Kết nối tri thức với cuộc sống) trên hệ thống FPT EduNext.

QUY TẮC SỬA SAI & BÁM SÁT GỢI Ý EDUNEXT (BẮT BUỘC):
1. Nếu trong đề có mục [💡 GỢI Ý CỦA EDUNEXT] hoặc [💬 NHẬN XÉT & PHẢN HỒI CỦA GIÁO VIÊN AI EDUNEXT KHI CHẤM BÀI]:
   - Đây là hướng dẫn trực tiếp từ hệ thống chấm bài của EduNext! Bạn BẮT BUỘC phải làm theo đúng công thức, phép tính hoặc hướng suy luận được chỉ ra trong Gợi ý đó.
2. Nếu có mục [⚠️ CẢNH BÁO - CÁC ĐÁP ÁN ĐÃ NỘP NHƯNG BỊ CHẤM SAI]:
   - TUYỆT ĐỐI KHÔNG trả lời lại bất kỳ giá trị nào nằm trong danh sách đã bị chấm sai! Hãy kiểm tra lại cách làm tròn, đơn vị hoặc dấu thập phân.

${subj.rules}

QUY TẮC TRÌNH BÀY ĐẦU RA (BẮT BUỘC):
- Bước 1 (Nháp ngắn gọn 1-3 dòng): Phân tích nhanh gợi ý / viết phép tính cụ thể để đảm bảo kết quả chính xác 100%.
- Bước 2 (DÒNG CUỐI CÙNG BẮT BUỘC): Phải bắt đầu chính xác bằng cụm từ "Trả lời: " kèm theo đáp án ngắn gọn nhất đúng yêu cầu đề bài (không viết thêm bất kỳ chữ hay ký tự nào sau dòng này).
- Ví dụ dòng cuối:
  Trả lời: 51,81
  hoặc Trả lời: 1, 3, 2, 1, 1
  hoặc Trả lời: Vì phân tử nitrogen có liên kết ba bền vững nên rất trơ ở nhiệt độ thường.`;

    return {
      subjectKey,
      subjectLabel: subj.label,
      systemPrompt: prompt
    };
  }

  async function solveWithGroq(questionText) {
    const keys = parseKeyList(CONFIG.groqApiKey);
    if (keys.length === 0) {
      throw new Error('Chưa nhập Groq API Key! Lấy key tại https://console.groq.com/keys');
    }

    const { subjectLabel, systemPrompt } = getSystemPromptForQuestion(questionText);

    // Chỉ xoay vòng qua các model đang hoạt động thực tế trên Groq (bỏ các model đã bị khai tử gây lỗi 400 & tốn RPM)
    const candidateModels = [
      CONFIG.groqModel || 'openai/gpt-oss-120b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant'
    ];
    const modelsToTry = [...new Set(candidateModels)];
    const trimmedQ = (questionText || '').slice(-3500);

    let lastError = null;
    let successfulAnswer = '';
    let workingModel = '';
    let usedKeyIndex = CONFIG.groqKeyIndex % keys.length;

    // Vòng lặp xoay qua từng API Key trong kho lưu trữ
    for (let k = 0; k < keys.length; k++) {
      const keyIdx = (CONFIG.groqKeyIndex + k) % keys.length;
      const apiKey = keys[keyIdx];
      const keyLabel = keys.length > 1 ? ` [Key #${keyIdx + 1}/${keys.length}]` : '';

      for (const model of modelsToTry) {
        updateUIStatus(`⚡ [${subjectLabel}] Giải qua Groq (${model})${keyLabel}...`);
        const payload = {
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Nội dung bài tập trên EduNext:\n${trimmedQ}` }
          ],
          temperature: 0.1,
          max_tokens: 1536
        };

        try {
          const result = await crossOriginPost('https://api.groq.com/openai/v1/chat/completions', payload, {
            'Authorization': `Bearer ${apiKey}`
          });

          const content = result.data?.choices?.[0]?.message?.content?.trim();
          if (result.ok && content) {
            successfulAnswer = content;
            workingModel = model;
            usedKeyIndex = keyIdx;
            CONFIG.groqKeyIndex = keyIdx;
            updateKeyBadgesUI();
            break;
          } else if (result.status === 401 || result.status === 403) {
            // Key không hợp lệ -> Bỏ qua key này, nhảy ngay sang API Key tiếp theo!
            console.warn(`[mini-gravitiqi] Groq Key #${keyIdx + 1} không hợp lệ (${result.status}), đổi sang key tiếp theo...`);
            lastError = new Error(`Groq Key #${keyIdx + 1} lỗi (${result.status}): ${result.errMsg}`);
            break;
          } else {
            console.warn(`[mini-gravitiqi] Groq Model ${model} lỗi (${result.status || 'Empty'}), nghỉ 1s rồi thử model kế tiếp...`);
            lastError = new Error(result.errMsg || 'Model trả về rỗng');
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
        } catch (err) {
          lastError = err;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      }

      if (successfulAnswer) break;

      if (k < keys.length - 1) {
        const nextKeyNum = ((keyIdx + 1) % keys.length) + 1;
        showToast(`🔄 Groq Key #${keyIdx + 1} hết quota/lỗi ➔ Tự đổi sang Key #${nextKeyNum}!`);
        await new Promise(r => setTimeout(r, 800));
      }
    }

    if (!successfulAnswer) throw lastError || new Error('Tất cả API Key & Model Groq đều hết quota hoặc lỗi');
    return {
      answer: successfulAnswer,
      model: `${subjectLabel} • Groq/${workingModel}${keys.length > 1 ? ` (K#${usedKeyIndex + 1})` : ''}`
    };
  }

  async function solveWithGemini(questionText, images = []) {
    const keys = parseKeyList(CONFIG.geminiApiKey);
    if (keys.length === 0) {
      throw new Error('Chưa nhập Gemini API Key! Lấy key tại https://aistudio.google.com/app/apikey');
    }

    const { subjectLabel, systemPrompt } = getSystemPromptForQuestion(questionText);

    // Chỉ giữ 3.6 Flash và 3.5 Flash theo yêu cầu (đã xóa 3.8 Flash)
    const selected = (CONFIG.geminiModel === 'gemini-3.5-flash') ? 'gemini-3.5-flash' : 'gemini-3.6-flash';
    const candidateModels = [
      selected,
      'gemini-3.6-flash',
      'gemini-3.5-flash'
    ];
    const modelsToTry = [...new Set(candidateModels)];

    const imageNote = images.length
      ? `\n\n(Kèm theo ${images.length} ảnh chụp tin nhắn EduNext chứa sơ đồ/hình vẽ của đề bài. Hãy đọc kỹ tất cả chữ và nhánh sơ đồ trong ảnh để lấy đầy đủ dữ kiện trả lời.)`
      : '';
    const parts = [{ text: `${systemPrompt}\n\nNội dung bài tập trên EduNext:\n${questionText || '(Đề bài nằm trong ảnh sơ đồ đính kèm)'}${imageNote}` }];
    for (const img of images) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
    }

    const payload = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
    };

    let lastError = null;
    let successfulAnswer = '';
    let workingModel = '';
    let usedKeyIndex = CONFIG.geminiKeyIndex % keys.length;

    // Vòng lặp xoay qua từng Gemini API Key trong kho lưu trữ
    for (let k = 0; k < keys.length; k++) {
      const keyIdx = (CONFIG.geminiKeyIndex + k) % keys.length;
      const apiKey = keys[keyIdx];
      const keyLabel = keys.length > 1 ? ` [Key #${keyIdx + 1}/${keys.length}]` : '';

      for (const model of modelsToTry) {
        updateUIStatus(`♊ [${subjectLabel}] Giải qua Gemini (${model})${keyLabel}...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        try {
          const result = await crossOriginPost(url, payload);
          if (result.ok && result.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            successfulAnswer = result.data.candidates[0].content.parts[0].text.trim();
            workingModel = model;
            usedKeyIndex = keyIdx;
            CONFIG.geminiKeyIndex = keyIdx;
            updateKeyBadgesUI();
            break;
          } else if (result.status === 400 && result.errMsg.includes('API_KEY_INVALID')) {
            console.warn(`[mini-gravitiqi] Gemini Key #${keyIdx + 1} không hợp lệ, chuyển sang Key tiếp theo...`);
            lastError = new Error(`Gemini Key #${keyIdx + 1} không hợp lệ`);
            break;
          } else {
            // Lỗi 429 (hết 20 lượt/ngày) hoặc 404/503 -> thử model còn lại hoặc nhảy sang Key tiếp theo!
            console.warn(`[mini-gravitiqi] Gemini Key #${keyIdx + 1} (${model}) lỗi ${result.status}, thử tiếp...`);
            lastError = new Error(result.errMsg);
            continue;
          }
        } catch (err) {
          lastError = err;
          continue;
        }
      }

      if (successfulAnswer) break;

      if (k < keys.length - 1) {
        const nextKeyNum = ((keyIdx + 1) % keys.length) + 1;
        showToast(`🔄 Gemini Key #${keyIdx + 1} hết quota (429) ➔ Tự đổi sang Key #${nextKeyNum}!`);
      }
    }

    if (!successfulAnswer) throw lastError || new Error('Tất cả API Key & Model Gemini (3.6/3.5 Flash) đều hết quota');
    return {
      answer: successfulAnswer,
      model: `${subjectLabel} • Gemini/${workingModel}${keys.length > 1 ? ` (K#${usedKeyIndex + 1})` : ''}`
    };
  }

  // ==========================================
  // 5b. NHẬN DIỆN CÂU HỎI SƠ ĐỒ ĐỒ HỌA vs. BẢNG ĐƠN GIẢN
  // ==========================================
  function getLatestCanvasImageUrls() {
    try {
      const targetWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const rows = targetWin.document.querySelectorAll('.chat-messages .assistant-row');
      const lastRow = rows[rows.length - 1];
      if (!lastRow) return [];
      const urls = [];

      // 1. Lấy các thẻ <img> (sơ đồ tư duy / hình vẽ nhúng trong tin nhắn)
      lastRow.querySelectorAll('img').forEach(img => {
        if (img.src && !img.src.includes('avatar') && !img.src.startsWith('data:image/svg')) {
          urls.push({ url: img.src, mimeType: 'image/png' });
        }
      });

      // 2. Lấy ảnh WebP gốc từ React Fiber của <canvas>
      lastRow.querySelectorAll('canvas').forEach(canvas => {
        const fiberKey = Object.keys(canvas).find(k => k.startsWith('__reactFiber$'));
        let curr = fiberKey ? canvas[fiberKey] : null;
        for (let i = 0; i < 10 && curr; i++) {
          const c = curr.memoizedProps && curr.memoizedProps.canvas;
          if (c && c.url) {
            urls.push({ url: c.url, mimeType: c.mime_type || 'image/webp' });
            break;
          }
          curr = curr.return;
        }
      });
      return urls;
    } catch (_) {
      return [];
    }
  }

  // Phân biệt:
  // - Bảng số liệu đơn giản (như bảng Thời gian | Số nhân viên [15;20) | 6...): Đã có sẵn chữ/bảng Markdown trong React Fiber -> Trả về FALSE để dùng GROQ!
  // - Sơ đồ đồ họa phức tạp (như sơ đồ tư duy Hóa học "Ứng dụng của nitrogen" có ảnh nhúng hoặc không quét được nội dung các ô sơ đồ ra chữ) -> Trả về TRUE để dùng GEMINI VISION!
  function isComplexDiagramQuestion(questionText) {
    try {
      const targetWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const rows = targetWin.document.querySelectorAll('.chat-messages .assistant-row');
      const lastRow = rows[rows.length - 1];

      const reactState = getReactFiberState();
      const rawFiber = `${reactState?.questionBlock || ''}\n${reactState?.content || ''}`.trim();

      // Nếu trong React Fiber đã có bảng kẻ đơn giản (dạng Markdown table "| ... | ... |")
      // và không nhúng file ảnh ngoài (![...]) -> Đây là bảng số liệu đơn giản, Groq giải trực tiếp bằng chữ cực tốt!
      const hasMarkdownTable = /\|.*\|[\s\S]*\|---/.test(rawFiber) || (rawFiber.split('|').length >= 6);
      const hasEmbeddedImageMarkdown = /!\[.*?\]\(.*?\)|<img\s/i.test(rawFiber);

      if (hasMarkdownTable && !hasEmbeddedImageMarkdown) {
        return false; // Dùng Groq!
      }

      // TH1: Trong tin nhắn có nhúng thẻ <img> đồ họa thực sự (như sơ đồ nhánh Hóa/Sinh/Lý) hoặc markdown ảnh ![...]
      if (hasEmbeddedImageMarkdown) {
        return true; // Dùng Gemini Vision!
      }
      if (lastRow) {
        const hasContentImg = Array.from(lastRow.querySelectorAll('img')).some(
          img => img.src && !img.src.includes('avatar') && (img.width > 50 || img.naturalWidth > 50)
        );
        if (hasContentImg) {
          return true; // Dùng Gemini Vision!
        }
      }

      // TH2: Không quét được chữ đề bài (hoặc chỉ quét được câu dẫn ngắn ngủi như "Bạn hãy làm bài sau nhé:", còn toàn bộ sơ đồ + câu hỏi nằm chết trong ảnh canvas)
      const stripped = (questionText || '')
        .replace(/Bạn hãy làm bài sau nhé:?/gi, '')
        .replace(/Hãy trả lời theo định dạng sau nhé.*/gi, '')
        .replace(/Câu hỏi:?/gi, '')
        .trim();
      if (!stripped || stripped.length < 15) {
        return true; // Dùng Gemini Vision!
      }

      // TH3: Đề bài chỉ có đúng 1 câu hỏi ngắn (không kèm số liệu hay bảng biểu), nhưng câu dẫn/đề bài nhắc trực tiếp tới "sơ đồ" hoặc "hình bên/hình dưới" nằm trong ảnh
      if (stripped.length < 160 && !/\d/.test(stripped) && /sơ đồ|hình bên|hình dưới|hình trên|quan sát hình/i.test(stripped)) {
        return true; // Dùng Gemini Vision!
      }

      // Mặc định: Các câu chữ và bảng biểu đơn giản -> Dùng Groq!
      return false;
    } catch (_) {
      return false;
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fetchImageAsBase64(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'undefined') {
        reject(new Error('Thiếu GM_xmlhttpRequest'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 15000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300 && res.response) {
            resolve(arrayBufferToBase64(res.response));
          } else {
            reject(new Error(`Tải ảnh lỗi ${res.status} (URL có thể đã hết hạn)`));
          }
        },
        onerror: () => reject(new Error('Lỗi mạng khi tải ảnh')),
        ontimeout: () => reject(new Error('Hết thời gian tải ảnh'))
      });
    });
  }

  async function collectLatestImages() {
    const sources = getLatestCanvasImageUrls().slice(0, 4);
    const images = [];
    for (const src of sources) {
      try {
        const base64 = await fetchImageAsBase64(src.url);
        images.push({ mimeType: src.mimeType, base64 });
      } catch (err) {
        console.warn('[mini-gravitiqi] Không tải được ảnh canvas:', err.message);
      }
    }
    return images;
  }

  async function solveWithAI(forceAutoSubmit = false) {
    let questionText = CONFIG.currentQuestion;
    if (!questionText || questionText.length < 5) {
      questionText = scanLatestQuestionFromDOM();
      if (questionText) {
        CONFIG.currentQuestion = questionText;
        renderQuestionUI(questionText);
      }
    }

    // Kiểm tra xem câu này có phải dạng Sơ đồ phức tạp (như sơ đồ Hóa học) hay chỉ là chữ/bảng số liệu đơn giản
    const needsVision = CONFIG.useVision && isComplexDiagramQuestion(questionText);
    let images = [];
    if (needsVision && CONFIG.geminiApiKey) {
      updateUIStatus('🖼️ Phát hiện Sơ đồ đồ họa -> Đang tải ảnh cho Gemini...');
      images = await collectLatestImages();
    }

    if ((!questionText || questionText.length < 5) && images.length === 0) {
      showToast('❌ Không tìm thấy đề bài trên trang! Hãy dán vào ô đề bài.');
      updateUIStatus('❌ Không tìm thấy đề bài');
      return;
    }

    CONFIG.isSolving = true;

    try {
      let result = null;

      // 1. Sơ đồ đồ họa phức tạp (như sơ đồ Hóa/Sinh/Lý) -> Ưu tiên Gemini Vision (3.6 -> 3.5 Flash), lỗi tự nhảy sang Groq
      if (needsVision && images.length > 0 && CONFIG.geminiApiKey) {
        updateUIStatus(`🖼️ Sơ đồ đồ họa -> Chuyển sang Gemini (${CONFIG.geminiModel})...`);
        showToast(`🖼️ Phát hiện sơ đồ đồ họa -> Tự chuyển sang Gemini!`);
        try {
          result = await solveWithGemini(questionText, images);
          result.model += ` +${images.length}🖼️`;
        } catch (visionErr) {
          if (CONFIG.groqApiKey && questionText && questionText.length >= 5) {
            showToast('⚠️ Gemini lỗi, tự động chuyển sang Groq...');
            result = await solveWithGroq(questionText);
          } else {
            throw visionErr;
          }
        }
      } else {
        // 2. Câu hỏi chữ & Bảng số liệu đơn giản -> Ưu tiên dùng Groq siêu tốc!
        // Nếu tất cả key/model Groq bị lỗi (hoặc hết lượt 429), tự động chuyển sang Gemini (3.6 -> 3.5 Flash)
        if (!CONFIG.groqApiKey && CONFIG.geminiApiKey) {
          result = await solveWithGemini(questionText);
        } else {
          if (!CONFIG.groqApiKey) {
            throw new Error('Chưa nhập Groq API Key! Mở mục [🔑 API Keys & Models] để dán key.');
          }
          try {
            result = await solveWithGroq(questionText);
          } catch (groqErr) {
            if (CONFIG.geminiApiKey) {
              showToast('⚠️ Groq lỗi/hết lượt, tự động chuyển sang Gemini...');
              result = await solveWithGemini(questionText);
            } else {
              throw groqErr;
            }
          }
        }
      }

      const finalAnswer = extractFinalAnswerLine(result.answer);
      CONFIG.currentAnswer = finalAnswer;
      renderAnswerUI(finalAnswer);
      updateUIStatus(`✅ Xong (${result.model})!`);
      showToast(`🎯 Đáp án [${result.model}]: ${finalAnswer}`);

      if (CONFIG.autoLoop || CONFIG.autoSubmit || forceAutoSubmit) {
        const delay = Math.max(CONFIG.delaySeconds, 3) * 1000;
        updateUIStatus(`⏳ Chờ ${CONFIG.delaySeconds}s rồi tự động nộp...`);
        showToast(`⏳ Chờ ${CONFIG.delaySeconds}s chống 429 rồi nộp...`);
        await new Promise(r => setTimeout(r, delay));
        submitCurrentAnswer(finalAnswer);
      }
      return true;
    } catch (err) {
      console.error(err);
      updateUIStatus('❌ ' + err.message);
      showToast('❌ ' + err.message);
      return false;
    } finally {
      CONFIG.isSolving = false;
    }
  }

  // ==========================================
  // 6. GIAO DIỆN ĐIỀU KHIỂN LINEAR UI (SIÊU GỌN & DỄ ẨN)
  // ==========================================
  function createUI() {
    if (document.getElementById('edunext-helper-ui')) return;

    const hasKeysAlready = parseKeyList(CONFIG.groqApiKey).length > 0 || parseKeyList(CONFIG.geminiApiKey).length > 0;

    const container = document.createElement('div');
    container.id = 'edunext-helper-ui';
    if (CONFIG.uiMinimized) container.classList.add('ln-minimized');

    container.innerHTML = `
      <!-- CHẾ ĐỘ VIÊN THUỐC THU GỌN (LINEAR MINI PILL) -->
      <div class="ln-pill-bar" id="enh-pill-bar" title="Kéo để di chuyển • Click để mở rộng (Phím tắt ẩn hoàn toàn: Alt + X)">
        <span class="enh-dot" id="enh-pill-dot"></span>
        <span class="ln-pill-title">mini-gravitiqi</span>
        <span class="ln-pill-sep">•</span>
        <span class="ln-pill-count" id="enh-pill-count">0 nộp</span>
        <button class="ln-icon-btn" id="enh-btn-expand" title="Mở rộng bảng điều khiển">↗</button>
        <button class="ln-icon-btn" id="enh-btn-pill-stealth" title="Ẩn hoàn toàn (Alt + X)">👁️</button>
      </div>

      <!-- CHẾ ĐỘ BẢNG ĐIỀU KHIỂN LINEAR ĐẦY ĐỦ -->
      <div class="ln-panel" id="enh-panel">
        <div class="enh-header" id="enh-drag-handle" title="Kéo thanh tiêu đề để di chuyển • Nhấp đúp để thu gọn">
          <div class="ln-header-left">
            <span class="enh-dot" id="enh-dot"></span>
            <span class="enh-title">mini-gravitiqi</span>
            <span class="ln-ver">v1.9</span>
          </div>
          <div class="enh-actions">
            <span id="enh-loop-badge" class="enh-badge">0 nộp</span>
            <button class="ln-icon-btn" id="enh-btn-stealth" title="Ẩn hoàn toàn (Phím tắt: Alt + X)">👁️</button>
            <button class="ln-icon-btn" id="enh-btn-minimize" title="Thu gọn thành thanh nhỏ">─</button>
          </div>
        </div>

        <div class="enh-body" id="enh-body">
          <div class="enh-status-bar">
            <span id="enh-status-text">Đang sẵn sàng...</span>
          </div>

          <!-- NÚT VÒNG LẶP AUTO LOOP LINEAR -->
          <button id="enh-btn-autoloop" class="enh-btn-loop ${CONFIG.autoLoop ? 'active' : ''}">
            ${CONFIG.autoLoop ? '● AUTO LOOP: ĐANG CHẠY (BẤM ĐỂ DỪNG)' : '▶ BẬT AUTO LOOP (GIẢI & NỘP LIÊN TỤC)'}
          </button>

          <!-- HÀNG CHỌN NHANH: MÔN HỌC & CHẾ ĐỘ AI (2 CỘT LINEAR) -->
          <div class="ln-grid-2">
            <div class="enh-section">
              <label class="enh-label">📚 Môn học</label>
              <select id="enh-subject-select" class="enh-select">
                <option value="auto" ${CONFIG.subject === 'auto' ? 'selected' : ''}>🤖 Tự nhận diện</option>
                <option value="toan" ${CONFIG.subject === 'toan' ? 'selected' : ''}>📐 Toán học</option>
                <option value="hoa" ${CONFIG.subject === 'hoa' ? 'selected' : ''}>🧪 Hóa học</option>
                <option value="ly" ${CONFIG.subject === 'ly' ? 'selected' : ''}>⚡ Vật lí</option>
                <option value="sinh" ${CONFIG.subject === 'sinh' ? 'selected' : ''}>🧬 Sinh học</option>
                <option value="anh" ${CONFIG.subject === 'anh' ? 'selected' : ''}>🇬🇧 Tiếng Anh</option>
                <option value="tin" ${CONFIG.subject === 'tin' ? 'selected' : ''}>💻 Tin học</option>
                <option value="van_su_dia_ktpl" ${CONFIG.subject === 'van_su_dia_ktpl' ? 'selected' : ''}>📖 Văn/Sử/Địa/KTPL</option>
              </select>
            </div>
            <div class="enh-section">
              <label class="enh-label">⚡ Luồng AI</label>
              <select id="enh-provider-select" class="enh-select">
                <option value="auto" ${CONFIG.provider === 'auto' ? 'selected' : ''}>🔄 Tự động (Groq+Gemini)</option>
                <option value="groq" ${CONFIG.provider === 'groq' ? 'selected' : ''}>⚡ Ưu tiên Groq</option>
              </select>
            </div>
          </div>

          <!-- NGĂN KÉO GẬP MỞ: KHO API KEYS & MODELS -->
          <details class="ln-drawer" ${!hasKeysAlready ? 'open' : ''}>
            <summary class="ln-drawer-summary">
              <span>🔑 Kho API Keys & Model</span>
              <span id="enh-drawer-key-summary" class="ln-drawer-meta">0 key</span>
            </summary>
            <div class="ln-drawer-body">
              <!-- Kho Groq API Keys -->
              <div id="enh-groq-panel" class="enh-provider-panel">
                <div class="enh-flex-between">
                  <label class="enh-label">Groq Keys <span id="enh-groq-key-badge" class="enh-key-count">(0)</span></label>
                  <a href="https://console.groq.com/keys" target="_blank" class="enh-link">Lấy Key ↗</a>
                </div>
                <textarea id="enh-groq-key-input" class="enh-key-textarea" rows="2" placeholder="Dán 1 hoặc nhiều khóa gsk_... (mỗi dòng 1 key)">${CONFIG.groqApiKey}</textarea>
                <div style="margin-top:5px;">
                  <label class="enh-label">Model Groq chính:</label>
                  <select id="enh-groq-model-select" class="enh-select">
                    <option value="openai/gpt-oss-120b" ${CONFIG.groqModel === 'openai/gpt-oss-120b' ? 'selected' : ''}>GPT-OSS 120B (Khuyên dùng)</option>
                    <option value="openai/gpt-oss-20b" ${CONFIG.groqModel === 'openai/gpt-oss-20b' ? 'selected' : ''}>GPT-OSS 20B (Nhanh)</option>
                    <option value="llama-3.3-70b-versatile" ${CONFIG.groqModel === 'llama-3.3-70b-versatile' ? 'selected' : ''}>Llama 3.3 70B</option>
                    <option value="llama-3.1-8b-instant" ${CONFIG.groqModel === 'llama-3.1-8b-instant' ? 'selected' : ''}>Llama 3.1 8B</option>
                    <option value="llama-3.1-70b-versatile" ${CONFIG.groqModel === 'llama-3.1-70b-versatile' ? 'selected' : ''}>Llama 3.1 70B</option>
                    <option value="mixtral-8x7b-32768" ${CONFIG.groqModel === 'mixtral-8x7b-32768' ? 'selected' : ''}>Mixtral 8x7B</option>
                    <option value="gemma2-9b-it" ${CONFIG.groqModel === 'gemma2-9b-it' ? 'selected' : ''}>Gemma2 9B</option>
                    <option value="qwen-2.5-32b" ${CONFIG.groqModel === 'qwen-2.5-32b' ? 'selected' : ''}>Qwen 2.5 32B</option>
                    <option value="qwen-2.5-coder-32b" ${CONFIG.groqModel === 'qwen-2.5-coder-32b' ? 'selected' : ''}>Qwen 2.5 Coder 32B</option>
                  </select>
                </div>
              </div>

              <div class="ln-divider"></div>

              <!-- Kho Gemini API Keys (Dùng cho Sơ đồ Vision & Dự phòng) -->
              <div id="enh-gemini-panel" class="enh-provider-panel">
                <div class="enh-flex-between">
                  <label class="enh-label">Gemini Keys (Giải Sơ đồ/Ảnh) <span id="enh-gemini-key-badge" class="enh-key-count">(0)</span></label>
                  <a href="https://aistudio.google.com/app/apikey" target="_blank" class="enh-link">Lấy Key ↗</a>
                </div>
                <textarea id="enh-gemini-key-input" class="enh-key-textarea" rows="2" placeholder="Dán 1 hoặc nhiều khóa AIza... (tự đổi key khi hết 20 lượt)">${CONFIG.geminiApiKey}</textarea>
                <div style="margin-top:5px;">
                  <label class="enh-label">Model Gemini Vision:</label>
                  <select id="enh-gemini-model-select" class="enh-select">
                    <option value="gemini-3.6-flash" ${CONFIG.geminiModel !== 'gemini-3.5-flash' ? 'selected' : ''}>Gemini 3.6 Flash</option>
                    <option value="gemini-3.5-flash" ${CONFIG.geminiModel === 'gemini-3.5-flash' ? 'selected' : ''}>Gemini 3.5 Flash</option>
                  </select>
                </div>
              </div>
            </div>
          </details>

          <!-- Ô ĐỀ BÀI & ĐÁP ÁN COMPACT -->
          <div class="enh-box">
            <div class="enh-box-header">
              <span class="enh-box-title">Đề bài & Gợi ý</span>
              <div class="enh-box-actions">
                <button class="enh-sm-btn" id="enh-btn-rescan" title="Quét lại đề & gợi ý">↻ Quét</button>
                <button class="enh-sm-btn" id="enh-btn-copy-q" title="Copy đề bài">Copy</button>
              </div>
            </div>
            <div id="enh-detected-q" class="enh-scrollable" contenteditable="true">Bấm [↻ Quét] hoặc tự động bắt đề...</div>
          </div>

          <div class="enh-box">
            <div class="enh-box-header">
              <span class="enh-box-title">Đáp án xuất ra</span>
            </div>
            <div id="enh-detected-a" class="enh-scrollable font-mono" contenteditable="true">Trả lời: ...</div>
          </div>

          <!-- NÚT THAO TÁC NHANH -->
          <div class="enh-row-btns">
            <button class="enh-btn enh-btn-primary" id="enh-btn-solve">⚡ Giải Bằng AI</button>
            <button class="enh-btn enh-btn-success" id="enh-btn-submit">↵ Điền & Nộp</button>
          </div>

          <!-- NGĂN KÉO GẬP MỞ: TÙY CHỌN TỰ ĐỘNG -->
          <details class="ln-drawer">
            <summary class="ln-drawer-summary">
              <span>⚙️ Cài đặt tự động & Phím tắt</span>
              <span class="ln-drawer-meta">Alt + X để ẩn</span>
            </summary>
            <div class="ln-drawer-body enh-settings">
              <label class="enh-checkbox">
                <input type="checkbox" id="enh-chk-auto-submit" ${CONFIG.autoSubmit ? 'checked' : ''} />
                <span>Tự điền & nộp sau khi bấm Giải</span>
              </label>
              <label class="enh-checkbox">
                <input type="checkbox" id="enh-chk-auto-ready" ${CONFIG.autoReady ? 'checked' : ''} />
                <span>Tự bấm "Sẵn sàng"</span>
              </label>
              <label class="enh-checkbox">
                <input type="checkbox" id="enh-chk-auto-next" ${CONFIG.autoNextLesson ? 'checked' : ''} />
                <span>Xong bài tự chuyển bài tiếp theo</span>
              </label>
              <label class="enh-checkbox">
                <input type="checkbox" id="enh-chk-vision" ${CONFIG.useVision ? 'checked' : ''} />
                <span>🖼️ Giải sơ đồ đồ họa qua Gemini Vision</span>
              </label>
              <div class="enh-delay-row">
                <span>Độ trễ nộp bài:</span>
                <input type="number" id="enh-num-delay" class="ln-num-input" min="3" max="20" value="${CONFIG.delaySeconds}" />
                <span>giây</span>
              </div>
            </div>
          </details>
        </div>
      </div>

      <!-- CHẤM NHỎ KHI ẨN HOÀN TOÀN (STEALTH MICRO-DOT) -->
      <div id="enh-stealth-dot" class="ln-stealth-dot" title="mini-gravitiqi đang ẩn (Click hoặc bấm Alt + X để hiện lại)"></div>
    `;

    const style = document.createElement('style');
    style.innerHTML = `
      #edunext-helper-ui {
        position: fixed;
        bottom: 18px;
        right: 18px;
        z-index: 999999;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        color: #ececee;
        user-select: none;
      }

      /* BẢNG CHÍNH PHONG CÁCH LINEAR.APP */
      .ln-panel {
        width: 310px;
        background: rgba(13, 14, 18, 0.94);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.09);
        border-radius: 10px;
        box-shadow: 0 16px 36px -8px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(0, 0, 0, 0.4);
        overflow: hidden;
        transition: opacity 0.16s ease, transform 0.16s ease;
      }

      /* CHẾ ĐỘ MINI PILL KHI THU GỌN */
      .ln-pill-bar {
        display: none;
        align-items: center;
        gap: 7px;
        background: rgba(15, 16, 20, 0.92);
        backdrop-filter: blur(14px);
        border: 1px solid rgba(255, 255, 255, 0.11);
        border-radius: 999px;
        padding: 5px 10px 5px 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        cursor: grab;
        font-size: 11.5px;
      }
      .ln-pill-title { font-weight: 600; color: #f3f4f6; letter-spacing: -0.01em; }
      .ln-pill-sep { color: #52525b; }
      .ln-pill-count { color: #a1a1aa; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

      #edunext-helper-ui.ln-minimized .ln-panel { display: none; }
      #edunext-helper-ui.ln-minimized .ln-pill-bar { display: inline-flex; }

      /* CHẾ ĐỘ STEALTH (ẨN HOÀN TOÀN) */
      .ln-stealth-dot {
        display: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #5e6ad2;
        opacity: 0.22;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 0 6px rgba(94, 106, 210, 0.6);
      }
      .ln-stealth-dot:hover {
        opacity: 1;
        transform: scale(1.4);
      }
      #edunext-helper-ui.ln-stealth .ln-panel,
      #edunext-helper-ui.ln-stealth .ln-pill-bar {
        display: none !important;
      }
      #edunext-helper-ui.ln-stealth .ln-stealth-dot {
        display: block;
      }

      /* THANH TIÊU ĐỀ LINEAR */
      .enh-header {
        background: rgba(255, 255, 255, 0.025);
        padding: 8px 11px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
        cursor: grab;
      }
      .enh-header:active, .ln-pill-bar:active { cursor: grabbing; }
      .ln-header-left { display: flex; align-items: center; gap: 7px; }
      .enh-title { font-weight: 600; font-size: 12.5px; color: #f4f4f5; letter-spacing: -0.01em; }
      .ln-ver {
        font-size: 10px; color: #71717a; background: rgba(255,255,255,0.05); padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace;
      }
      .enh-actions { display: flex; align-items: center; gap: 4px; }
      .enh-badge {
        background: rgba(94, 106, 210, 0.16);
        color: #a5b4fc;
        border: 1px solid rgba(94, 106, 210, 0.3);
        font-size: 10.5px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: 5px;
        margin-right: 2px;
      }
      .ln-icon-btn {
        background: transparent;
        border: 1px solid transparent;
        color: #8a8f98;
        cursor: pointer;
        font-size: 12px;
        width: 22px;
        height: 22px;
        border-radius: 5px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: all 0.12s;
        padding: 0;
      }
      .ln-icon-btn:hover {
        background: rgba(255, 255, 255, 0.07);
        color: #f4f4f5;
        border-color: rgba(255, 255, 255, 0.09);
      }

      /* THÂN BẢNG ĐIỀU KHIỂN */
      .enh-body { padding: 10px; display: flex; flex-direction: column; gap: 7px; }
      .enh-status-bar {
        display: flex;
        align-items: center;
        font-size: 11px;
        color: #8a8f98;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .enh-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #52525b;
        flex-shrink: 0;
        transition: background 0.2s, box-shadow 0.2s;
      }
      .enh-dot.running {
        background: #10b981;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.7);
      }

      /* NÚT AUTO LOOP LINEAR */
      .enh-btn-loop {
        width: 100%;
        padding: 7px 10px;
        border: 1px solid rgba(94, 106, 210, 0.45);
        border-radius: 6px;
        background: linear-gradient(180deg, #5e6ad2 0%, #4e5ac0 100%);
        color: #ffffff;
        font-weight: 600;
        font-size: 11.5px;
        letter-spacing: -0.01em;
        cursor: pointer;
        transition: all 0.15s ease;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.15);
      }
      .enh-btn-loop:hover { filter: brightness(1.08); }
      .enh-btn-loop.active {
        background: linear-gradient(180deg, #10b981 0%, #059669 100%);
        border-color: rgba(52, 211, 153, 0.5);
        box-shadow: 0 0 14px rgba(16, 185, 129, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.2);
      }

      /* LƯỚI 2 CỘT */
      .ln-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .enh-label { font-size: 10.5px; color: #8a8f98; display: block; margin-bottom: 3px; font-weight: 500; }
      .enh-key-count { color: #10b981; font-weight: 600; font-family: ui-monospace, monospace; }
      .enh-link { font-size: 10.5px; color: #818cf8; text-decoration: none; }
      .enh-link:hover { text-decoration: underline; }
      .enh-flex-between { display: flex; justify-content: space-between; align-items: center; }

      .enh-key-textarea, .enh-select, .ln-num-input {
        width: 100%;
        background: #141519;
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #ececee;
        padding: 5px 7px;
        border-radius: 6px;
        box-sizing: border-box;
        font-size: 11px;
        outline: none;
        transition: border-color 0.15s;
      }
      .enh-key-textarea {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10.5px;
        resize: vertical;
        user-select: text;
      }
      .enh-key-textarea:focus, .enh-select:focus, .ln-num-input:focus {
        border-color: #5e6ad2;
      }
      .enh-select { cursor: pointer; font-family: inherit; }

      /* NGĂN KÉO GẬP MỞ (LINEAR ACCORDION DRAWER) */
      .ln-drawer {
        background: #131418;
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        overflow: hidden;
      }
      .ln-drawer-summary {
        padding: 6px 8px;
        font-size: 11px;
        font-weight: 500;
        color: #c8cad0;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        list-style: none;
      }
      .ln-drawer-summary::-webkit-details-marker { display: none; }
      .ln-drawer-summary:hover { background: rgba(255, 255, 255, 0.03); color: #fff; }
      .ln-drawer-meta {
        font-size: 10px;
        color: #71717a;
        font-family: ui-monospace, monospace;
      }
      .ln-drawer-body {
        padding: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ln-divider { height: 1px; background: rgba(255, 255, 255, 0.06); margin: 3px 0; }

      /* HỘP ĐỀ BÀI & ĐÁP ÁN */
      .enh-box {
        background: #131418;
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        padding: 6px 8px;
      }
      .enh-box-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 3px;
      }
      .enh-box-title { font-size: 10.5px; font-weight: 500; color: #8a8f98; }
      .enh-scrollable {
        max-height: 54px;
        overflow-y: auto;
        font-size: 11.5px;
        line-height: 1.4;
        color: #e4e4e7;
        word-break: break-word;
        outline: none;
        user-select: text;
      }
      .enh-scrollable::-webkit-scrollbar { width: 4px; }
      .enh-scrollable::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
      .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #34d399; font-size: 11px; }
      .enh-box-actions { display: flex; gap: 4px; }
      .enh-sm-btn {
        background: rgba(255, 255, 255, 0.05);
        color: #a1a1aa;
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 4px;
        padding: 1px 6px;
        font-size: 10px;
        cursor: pointer;
        transition: all 0.12s;
      }
      .enh-sm-btn:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }

      /* HÀNG NÚT HÀNH ĐỘNG */
      .enh-row-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .enh-btn {
        padding: 6px 8px;
        border-radius: 6px;
        font-weight: 500;
        cursor: pointer;
        font-size: 11.5px;
        text-align: center;
        transition: all 0.12s;
      }
      .enh-btn-primary {
        background: rgba(255, 255, 255, 0.07);
        color: #f4f4f5;
        border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .enh-btn-primary:hover { background: rgba(255, 255, 255, 0.12); }
      .enh-btn-success {
        background: rgba(16, 185, 129, 0.15);
        color: #6ee7b7;
        border: 1px solid rgba(16, 185, 129, 0.35);
      }
      .enh-btn-success:hover { background: rgba(16, 185, 129, 0.25); }

      /* CÀI ĐẶT CHECKBOX */
      .enh-settings { font-size: 11px; color: #a1a1aa; }
      .enh-checkbox { display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .enh-checkbox input[type="checkbox"] { accent-color: #5e6ad2; margin: 0; cursor: pointer; }
      .enh-delay-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
      .ln-num-input { width: 46px !important; padding: 2px 5px !important; text-align: center; }

      /* TOAST THÔNG BÁO LINEAR */
      .enh-toast {
        position: fixed;
        top: 16px;
        right: 16px;
        background: rgba(15, 16, 20, 0.95);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #f4f4f5;
        padding: 7px 12px;
        border-radius: 7px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        z-index: 1000000;
        font-size: 11.5px;
        font-family: Inter, -apple-system, sans-serif;
        transition: opacity 0.25s;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(container);

    // Kéo thả linh hoạt (Draggable cho cả Header lẫn Mini Pill)
    const makeDraggable = (handleEl) => {
      let isDragging = false;
      let startX = 0, startY = 0, startRight = 18, startBottom = 18;
      handleEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, select, input, textarea, a')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = container.getBoundingClientRect();
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        container.style.right = Math.max(6, Math.min(window.innerWidth - 60, startRight - dx)) + 'px';
        container.style.bottom = Math.max(6, Math.min(window.innerHeight - 40, startBottom - dy)) + 'px';
      });
      window.addEventListener('mouseup', () => { isDragging = false; });
    };
    makeDraggable(document.getElementById('enh-drag-handle'));
    makeDraggable(document.getElementById('enh-pill-bar'));

    // Chuyển đổi giữa Full Panel <-> Mini Pill
    const setMinimized = (min) => {
      CONFIG.uiMinimized = min;
      saveConfig('uiMinimized', min ? 'true' : 'false');
      container.classList.toggle('ln-minimized', min);
    };

    document.getElementById('enh-btn-minimize').onclick = () => setMinimized(true);
    document.getElementById('enh-drag-handle').ondblclick = (e) => {
      if (!e.target.closest('button')) setMinimized(true);
    };
    document.getElementById('enh-btn-expand').onclick = () => setMinimized(false);
    document.getElementById('enh-pill-bar').onclick = (e) => {
      if (!e.target.closest('#enh-btn-pill-stealth')) setMinimized(false);
    };

    // Chế độ Stealth (Ẩn hoàn toàn bằng nút 👁️ hoặc phím tắt Alt + X)
    const toggleStealth = () => {
      CONFIG.uiStealth = !CONFIG.uiStealth;
      container.classList.toggle('ln-stealth', CONFIG.uiStealth);
    };
    document.getElementById('enh-btn-stealth').onclick = toggleStealth;
    document.getElementById('enh-btn-pill-stealth').onclick = (e) => {
      e.stopPropagation();
      toggleStealth();
    };
    document.getElementById('enh-stealth-dot').onclick = toggleStealth;

    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key.toLowerCase() === 'x' || e.key.toLowerCase() === 'h')) {
        e.preventDefault();
        toggleStealth();
      }
    });

    // Bật / Tắt Vòng Lặp Auto Loop
    const autoLoopBtn = document.getElementById('enh-btn-autoloop');
    autoLoopBtn.onclick = () => setAutoLoop(!CONFIG.autoLoop);

    document.getElementById('enh-chk-auto-next').onchange = (e) => {
      CONFIG.autoNextLesson = e.target.checked;
      showToast(`Tự qua bài tiếp theo: ${e.target.checked ? 'BẬT' : 'TẮT'}`);
    };

    document.getElementById('enh-chk-vision').onchange = (e) => {
      CONFIG.useVision = e.target.checked;
      if (e.target.checked && !CONFIG.geminiApiKey) {
        showToast('⚠️ Vision cần Gemini API Key trong mục [🔑 Kho API Keys].');
      } else {
        showToast(`Giải sơ đồ Gemini Vision: ${e.target.checked ? 'BẬT' : 'TẮT'}`);
      }
    };

    // Chuyển đổi Môn học (Prompt chuyên biệt)
    const subjectSelect = document.getElementById('enh-subject-select');
    subjectSelect.onchange = (e) => {
      const val = e.target.value;
      saveConfig('subject', val);
      const label = val === 'auto'
        ? '🤖 Tự động nhận diện môn học'
        : (SUBJECT_PROMPTS[val]?.label || val);
      showToast(`📚 Prompt Môn học: ${label}`);
    };

    // Chuyển đổi chế độ Auto / Groq (Đã bỏ "Chỉ dùng Google Gemini")
    const providerSelect = document.getElementById('enh-provider-select');
    providerSelect.onchange = (e) => {
      const val = e.target.value;
      saveConfig('provider', val);
      showToast(`Luồng AI: ${val === 'auto' ? 'Tự động (Chữ ➔ Groq | Ảnh ➔ Gemini)' : 'Ưu tiên Groq'}`);
    };

    // Tự động nhận diện danh sách nhiều API Key khi nhập/dán
    document.getElementById('enh-groq-key-input').oninput = (e) => {
      const raw = e.target.value.trim();
      saveConfig('groqApiKey', raw);
      CONFIG.groqKeyIndex = 0;
      updateKeyBadgesUI();
    };
    document.getElementById('enh-groq-key-input').onchange = () => {
      const count = parseKeyList(CONFIG.groqApiKey).length;
      showToast(`🔑 Đã lưu ${count} Groq API Key vào kho!`);
    };

    document.getElementById('enh-gemini-key-input').oninput = (e) => {
      const raw = e.target.value.trim();
      saveConfig('geminiApiKey', raw);
      CONFIG.geminiKeyIndex = 0;
      updateKeyBadgesUI();
    };
    document.getElementById('enh-gemini-key-input').onchange = () => {
      const count = parseKeyList(CONFIG.geminiApiKey).length;
      showToast(`🔑 Đã lưu ${count} Gemini API Key vào kho!`);
    };

    updateKeyBadgesUI();

    document.getElementById('enh-groq-model-select').onchange = (e) => {
      saveConfig('groqModel', e.target.value);
      showToast('⚙️ Groq Model: ' + e.target.value);
    };

    document.getElementById('enh-gemini-model-select').onchange = (e) => {
      saveConfig('geminiModel', e.target.value);
      showToast('⚙️ Gemini Model: ' + e.target.value);
    };

    document.getElementById('enh-btn-copy-q').onclick = () => {
      const q = document.getElementById('enh-detected-q').innerText;
      navigator.clipboard.writeText(q);
      showToast('📋 Đã copy đề bài!');
    };

    document.getElementById('enh-btn-rescan').onclick = () => {
      const q = scanLatestQuestionFromDOM();
      if (q) {
        CONFIG.currentQuestion = q;
        renderQuestionUI(q);
        showToast('🔍 Đã quét đề bài & gợi ý trên màn hình!');
      } else {
        showToast('⚠️ Không tìm thấy đề bài mới.');
      }
    };

    document.getElementById('enh-detected-q').oninput = (e) => {
      CONFIG.currentQuestion = e.target.innerText.trim();
    };

    document.getElementById('enh-detected-a').oninput = (e) => {
      CONFIG.currentAnswer = e.target.innerText.trim();
    };

    document.getElementById('enh-btn-solve').onclick = () => {
      solveWithAI(CONFIG.autoSubmit);
    };

    document.getElementById('enh-btn-submit').onclick = () => {
      const a = document.getElementById('enh-detected-a').innerText.trim();
      if (!a || a.includes('Trả lời: ...')) {
        showToast('⚠️ Chưa có đáp án để nộp!');
        return;
      }
      submitCurrentAnswer(a);
    };

    document.getElementById('enh-chk-auto-submit').onchange = (e) => {
      saveConfig('autoSubmit', e.target.checked);
      showToast(`Tự động nộp: ${e.target.checked ? 'BẬT' : 'TẮT'}`);
    };

    document.getElementById('enh-chk-auto-ready').onchange = (e) => {
      saveConfig('autoReady', e.target.checked);
    };

    document.getElementById('enh-num-delay').onchange = (e) => {
      const v = parseInt(e.target.value) || 5;
      saveConfig('delaySeconds', v);
    };

    setTimeout(() => {
      const initialQ = scanLatestQuestionFromDOM();
      if (initialQ) {
        CONFIG.currentQuestion = initialQ;
        renderQuestionUI(initialQ);
      }
    }, 1500);

    // Vòng lặp kiểm tra mỗi 2 giây
    setInterval(() => {
      if (CONFIG.autoLoop) {
        runAutoLoopStep();
      } else {
        if (CONFIG.autoReady) {
          const readyBtn = Array.from(document.querySelectorAll('button')).find(
            b => b.innerText && b.innerText.trim() === 'Sẵn sàng'
          );
          if (readyBtn && Date.now() - CONFIG.lastActionTime > 5000) {
            sendReadySignal();
          }
        }
        detectServerError();
        if (!CONFIG.currentQuestion || CONFIG.currentQuestion.length < 5) {
          const found = scanLatestQuestionFromDOM();
          if (found) {
            CONFIG.currentQuestion = found;
            renderQuestionUI(found);
          }
        }
      }
    }, 2000);
  }

  function detectServerError() {
    const errorText = Array.from(document.querySelectorAll('*')).find(
      e => e.innerText && e.innerText.includes('Máy chủ tạm thời không truy cập được')
    );
    if (errorText) {
      updateUIStatus('⚠️ Server 503/429! Đang chờ thử lại...');
      const retryBtn = Array.from(document.querySelectorAll('button')).find(
        b => b.innerText && b.innerText.trim() === 'Thử lại'
      );
      if (retryBtn && Date.now() - CONFIG.lastActionTime > 5000) {
        CONFIG.lastActionTime = Date.now();
        setTimeout(() => retryBtn.click(), 3000);
      }
      return true;
    }
    return false;
  }

  function setAutoLoop(on) {
    CONFIG.autoLoop = on;
    const btn = document.getElementById('enh-btn-autoloop');
    const dot = document.getElementById('enh-dot');
    const pillDot = document.getElementById('enh-pill-dot');
    if (on) {
      CONFIG.lastProcessedSignature = ''; // Reset để giải ngay câu hiện tại trên màn hình
      if (btn) {
        btn.classList.add('active');
        btn.innerText = '● AUTO LOOP: ĐANG CHẠY (BẤM ĐỂ DỪNG)';
      }
      if (dot) dot.classList.add('running');
      if (pillDot) pillDot.classList.add('running');
      updateUIStatus('🔄 Đã BẬT Auto Loop! Đang quét đề...');
      showToast('🔄 Đã BẬT Auto Loop: Giải -> Điền -> Nộp liên tục!');
      runAutoLoopStep();
    } else {
      if (btn) {
        btn.classList.remove('active');
        btn.innerText = '▶ BẬT AUTO LOOP (GIẢI & NỘP LIÊN TỤC)';
      }
      if (dot) dot.classList.remove('running');
      if (pillDot) pillDot.classList.remove('running');
      updateUIStatus('⏸️ Đã tạm dừng Auto Loop.');
    }
  }

  function updateLoopCounterUI() {
    const badge = document.getElementById('enh-loop-badge');
    const pillCount = document.getElementById('enh-pill-count');
    if (badge) badge.innerText = `${CONFIG.loopSolvedCount} nộp`;
    if (pillCount) pillCount.innerText = `${CONFIG.loopSolvedCount} nộp`;
  }

  function updateKeyBadgesUI() {
    const groqKeys = parseKeyList(CONFIG.groqApiKey);
    const geminiKeys = parseKeyList(CONFIG.geminiApiKey);
    const groqBadge = document.getElementById('enh-groq-key-badge');
    const geminiBadge = document.getElementById('enh-gemini-key-badge');
    const drawerSummary = document.getElementById('enh-drawer-key-summary');
    if (groqBadge) {
      groqBadge.innerText = groqKeys.length > 0
        ? `(${groqKeys.length} key • #${(CONFIG.groqKeyIndex % groqKeys.length) + 1})`
        : '(0)';
    }
    if (geminiBadge) {
      geminiBadge.innerText = geminiKeys.length > 0
        ? `(${geminiKeys.length} key • #${(CONFIG.geminiKeyIndex % geminiKeys.length) + 1})`
        : '(0)';
    }
    if (drawerSummary) {
      drawerSummary.innerText = `Groq: ${groqKeys.length} • Gem: ${geminiKeys.length}`;
    }
  }

  function updateUIStatus(text) {
    const el = document.getElementById('enh-status-text');
    if (el) el.innerText = text;
  }

  function renderQuestionUI(q) {
    const el = document.getElementById('enh-detected-q');
    if (el) el.innerText = q;
  }

  function renderAnswerUI(a) {
    const el = document.getElementById('enh-detected-a');
    if (el) el.innerText = a;
  }

  function showToast(msg) {
    if (CONFIG.uiStealth) return; // Không hiện toast khi đang ở chế độ ẩn hoàn toàn (Stealth)
    const toast = document.createElement('div');
    toast.className = 'enh-toast';
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, 2200);
  }

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(createUI, 1000);
  });
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(createUI, 1000);
  }
})();
