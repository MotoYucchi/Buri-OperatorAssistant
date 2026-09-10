/**
 * Call Assist AI - Client Application Logic
 * Featuring:
 * - Real-time Gemini 3.7 Flash analysis
 * - Google Cloud Speech-to-Text microphone input
 * - Manual Customer / Operator speaker switching
 * - Live Call Timeline Chat stream
 * - 5 Preset Call Center Demo Cases
 * - Human Escalation Alert & Knowledge accumulation
 */

// 5 Demo Cases specified in requirements
const DEMO_CASES = {
  1: {
    title: "商品不良",
    text: "先日購入した商品が壊れた状態で届いたのですが、交換してもらえますか？"
  },
  2: {
    title: "料金・請求",
    text: "今月の請求金額が、聞いていた金額より高いのですが、どうなっていますか？"
  },
  3: {
    title: "再問い合わせ",
    text: "先日問い合わせた件がまだ解決していないのですが、どうなっていますか？"
  },
  4: {
    title: "クレーム・説明相違",
    text: "前に電話したときの担当者の説明と話が違うんですが、どういうことですか？"
  },
  5: {
    title: "判断困難・要ヒアリング",
    text: "どうしたらいいのか自分でも分からなくて、とにかく困っています……"
  }
};

// State
let currentAnalysisData = null;
let apiHealth = { connected: false, model: "gemini-3.7-flash" };
let callSeconds = 154; // Start at 02:34
let stepTimer = null;

// Voice & Speaker State
let currentSpeaker = "customer"; // 'customer' or 'operator'
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let liveRecognition = null;

// DOM Elements: Input & Presets
const inquiryInput = document.getElementById("inquiryInput");
const charCount = document.getElementById("charCount");
const analyzeBtn = document.getElementById("analyzeBtn");
const clearBtn = document.getElementById("clearBtn");
const presetButtons = document.querySelectorAll(".preset-btn");

// DOM Elements: Voice & Chat Stream
const speakerCustomerBtn = document.getElementById("speakerCustomerBtn");
const speakerOperatorBtn = document.getElementById("speakerOperatorBtn");
const micRecordBtn = document.getElementById("micRecordBtn");
const micBtnIcon = document.getElementById("micBtnIcon");
const micBtnLabel = document.getElementById("micBtnLabel");
const sttEngineBadge = document.getElementById("sttEngineBadge");
const chatBody = document.getElementById("chatBody");
const clearChatBtn = document.getElementById("clearChatBtn");
const chatTimerText = document.getElementById("chatTimerText");
const chatInterimBox = document.getElementById("chatInterimBox");
const interimSpeakerLabel = document.getElementById("interimSpeakerLabel");
const interimText = document.getElementById("interimText");
const addCustomerLineBtn = document.getElementById("addCustomerLineBtn");
const addOperatorLineBtn = document.getElementById("addOperatorLineBtn");

// DOM Elements: Results
const loadingPanel = document.getElementById("loadingPanel");
const emptyState = document.getElementById("emptyState");
const resultsContainer = document.getElementById("resultsContainer");
const errorPanel = document.getElementById("errorPanel");
const escalationBanner = document.getElementById("escalationBanner");
const escalationReasonText = document.getElementById("escalationReasonText");
const escalateActionBtn = document.getElementById("escalateActionBtn");

const resCategory = document.getElementById("resCategory");
const resUrgency = document.getElementById("resUrgency");
const resUrgencyText = document.getElementById("resUrgencyText");
const resDepartment = document.getElementById("resDepartment");
const resSummary = document.getElementById("resSummary");
const resActionText = document.getElementById("resActionText");
const resCautionsList = document.getElementById("resCautionsList");
const resCasesList = document.getElementById("resCasesList");
const resModelBadge = document.getElementById("resModelBadge");

// Edit & Adopt buttons
const actionDisplayArea = document.getElementById("actionDisplayArea");
const actionEditArea = document.getElementById("actionEditArea");
const editActionInput = document.getElementById("editActionInput");
const adoptActionBtn = document.getElementById("adoptActionBtn");
const modifyActionBtn = document.getElementById("modifyActionBtn");
const saveKbBtn = document.getElementById("saveKbBtn");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const kbCountBadge = document.getElementById("kbCountBadge");

// Header status & Modal
const apiStatusPill = document.getElementById("apiStatusPill");
const apiStatusDot = document.getElementById("apiStatusDot");
const apiStatusLabel = document.getElementById("apiStatusLabel");
const callTimer = document.getElementById("callTimer");

const settingsModal = document.getElementById("settingsModal");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const cancelSettingsBtn = document.getElementById("cancelSettingsBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const modalApiKey = document.getElementById("modalApiKey");
const modalSpeechKey = document.getElementById("modalSpeechKey");
const modalModelSelect = document.getElementById("modalModelSelect");
const modalStatusBox = document.getElementById("modalStatusBox");
const modalOAuthProject = document.getElementById("modalOAuthProject");
const modalOAuthClientId = document.getElementById("modalOAuthClientId");
const googleAuthBtn = document.getElementById("googleAuthBtn");
const testSttBtn = document.getElementById("testSttBtn");

const toastContainer = document.getElementById("toastContainer");

// ----------------------------------------------------
// Initialization
// ----------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initCallTimer();
  checkApiHealth();
  updateKnowledgeCount();
  setupEventListeners();

  // Check URL params for auth success
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("auth") === "success") {
    showToast("Google OAuth認証が完了しました！", "success");
    window.history.replaceState({}, document.title, window.location.pathname);
    setTimeout(checkApiHealth, 500);
  } else if (urlParams.get("auth_error")) {
    showToast(`OAuth認証エラー: ${urlParams.get("auth_error")}`, "error");
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});

// ----------------------------------------------------
// Call Simulation Timer
// ----------------------------------------------------
function initCallTimer() {
  setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, "0");
    const secs = String(callSeconds % 60).padStart(2, "0");
    const timeStr = `${mins}:${secs}`;
    if (callTimer) callTimer.textContent = timeStr;
    if (chatTimerText) chatTimerText.textContent = timeStr;
  }, 1000);
}

function formatCurrentTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ----------------------------------------------------
// Chat View Timeline Functions
// ----------------------------------------------------
function addChatMessage(speaker, text) {
  if (!chatBody || !text || !text.trim()) return;

  const row = document.createElement("div");
  row.className = `chat-row ${speaker}`;

  const who = document.createElement("div");
  who.className = "chat-who";
  who.textContent = speaker === "customer" ? "👤 顧客" : "🎧 オペレーター";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text.trim();

  const time = document.createElement("div");
  time.className = "chat-time";
  time.textContent = formatCurrentTime();

  row.appendChild(who);
  row.appendChild(bubble);
  row.appendChild(time);

  chatBody.appendChild(row);
  chatBody.scrollTop = chatBody.scrollHeight;
}

function clearChatTimeline() {
  if (!chatBody) return;
  chatBody.innerHTML = "";
  showToast("通話タイムラインをクリアしました", "info");
}

// ----------------------------------------------------
// Speaker Selection Functions
// ----------------------------------------------------
function setSpeaker(speaker) {
  currentSpeaker = speaker;
  if (speaker === "customer") {
    speakerCustomerBtn.className = "speaker-tab-btn active customer";
    speakerOperatorBtn.className = "speaker-tab-btn operator";
    if (interimSpeakerLabel) interimSpeakerLabel.textContent = "👤 顧客:";
  } else {
    speakerCustomerBtn.className = "speaker-tab-btn customer";
    speakerOperatorBtn.className = "speaker-tab-btn active operator";
    if (interimSpeakerLabel) interimSpeakerLabel.textContent = "🎧 オペレーター:";
  }
}

// ----------------------------------------------------
// Microphone & Google Cloud Speech-to-Text
// ----------------------------------------------------
async function toggleMicrophoneRecording() {
  if (!isRecording) {
    // Start Recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];

      // Determine supported MIME type
      let mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      }

      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all tracks to release mic
        stream.getTracks().forEach((track) => track.stop());

        // Process recorded audio
        const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        if (audioBlob.size < 300) {
          showToast("録音が短すぎるか音声が検出されませんでした。マイクに向かって話してから停止してください。", "error");
          micRecordBtn.classList.remove("recording");
          micBtnIcon.textContent = "🎙️";
          micBtnLabel.textContent = "マイク録音開始";
          if (chatInterimBox) chatInterimBox.classList.add("hidden");
          return;
        }
        await sendAudioToGoogleSpeech(audioBlob);
      };

      mediaRecorder.start(250);
      isRecording = true;

      // Update UI to recording state
      micRecordBtn.classList.add("recording");
      micBtnIcon.textContent = "■";
      micBtnLabel.textContent = "録音停止して認識";
      if (chatInterimBox) {
        chatInterimBox.classList.remove("hidden");
        interimText.textContent = "（聞き取り中... お話しください）";
      }

      // Optional real-time preview if browser supports Web Speech API
      initLiveSpeechPreview();

      showToast(`🎙️ ${currentSpeaker === "customer" ? "顧客" : "オペレーター"}の声を受音中...`, "info");
    } catch (err) {
      console.error("Microphone access error:", err);
      showToast("マイクのアクセスに失敗しました: " + err.message, "error");
    }
  } else {
    // Stop Recording
    stopMicrophoneRecording();
  }
}

function stopMicrophoneRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (liveRecognition) {
    try { liveRecognition.stop(); } catch (e) {}
    liveRecognition = null;
  }
  isRecording = false;

  // Update UI to processing state
  micRecordBtn.classList.remove("recording");
  micBtnIcon.textContent = "⏳";
  micBtnLabel.textContent = "認識処理中...";
}

// Live interim speech preview using webkitSpeechRecognition if supported
function initLiveSpeechPreview() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  try {
    liveRecognition = new SpeechRecognition();
    liveRecognition.lang = "ja-JP";
    liveRecognition.interimResults = true;
    liveRecognition.continuous = true;

    liveRecognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        interim += event.results[i][0].transcript;
      }
      if (interimText && interim) {
        interimText.textContent = interim;
      }
    };

    liveRecognition.onerror = () => {};
    liveRecognition.start();
  } catch (e) {
    // Graceful fallback
  }
}

// Send Audio Blob to Backend Google Cloud Speech-to-Text API
async function sendAudioToGoogleSpeech(blob) {
  try {
    const reader = new FileReader();
    reader.readAsDataURL(blob);

    reader.onloadend = async () => {
      let rawResult = reader.result;
      let cleanBase64 = rawResult;
      if (typeof rawResult === "string" && rawResult.includes(",")) {
        cleanBase64 = rawResult.split(",")[1];
      }

      try {
        const response = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioContent: cleanBase64,
            mimeType: blob.type,
            speaker: currentSpeaker
          })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || "音声認識に失敗しました。");
        }

        const transcript = data.transcript ? data.transcript.trim() : "";

        if (transcript && transcript !== "（音声を検出できませんでした）") {
          // 1. Add to conversation chat timeline
          addChatMessage(currentSpeaker, transcript);

          // 2. Append or set into inquiry textarea
          const speakerLabel = currentSpeaker === "customer" ? "顧客" : "オペレーター";
          if (!inquiryInput.value.trim()) {
            inquiryInput.value = transcript;
          } else {
            inquiryInput.value += `\n${speakerLabel}: ${transcript}`;
          }

          charCount.textContent = `${inquiryInput.value.length}文字`;
          showToast(`✓ Google STT:「${transcript}」を認識しました`, "success");
        } else {
          showToast("音声がはっきりと聞き取れませんでした。もう一度お試しください。", "error");
        }
      } catch (err) {
        console.error("Transcribe API Error:", err);
        showToast("音声認識エラー: " + err.message, "error");
      } finally {
        // Reset UI button
        micRecordBtn.classList.remove("recording");
        micBtnIcon.textContent = "🎙️";
        micBtnLabel.textContent = "マイク録音開始";
        if (chatInterimBox) chatInterimBox.classList.add("hidden");
      }
    };
  } catch (err) {
    console.error("Audio conversion error:", err);
    micRecordBtn.classList.remove("recording");
    micBtnIcon.textContent = "🎙️";
    micBtnLabel.textContent = "マイク録音開始";
    if (chatInterimBox) chatInterimBox.classList.add("hidden");
  }
}

// ----------------------------------------------------
// Event Listeners Setup
// ----------------------------------------------------
function setupEventListeners() {
  // Text input length counter
  inquiryInput.addEventListener("input", () => {
    charCount.textContent = `${inquiryInput.value.length}文字`;
  });

  // Shortcut Ctrl + Enter to run analysis
  inquiryInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runAnalysis();
    }
  });

  // Clear button
  clearBtn.addEventListener("click", () => {
    inquiryInput.value = "";
    charCount.textContent = "0文字";
    presetButtons.forEach((btn) => btn.classList.remove("active"));
    inquiryInput.focus();
  });

  // Clear Chat button
  if (clearChatBtn) {
    clearChatBtn.addEventListener("click", clearChatTimeline);
  }

  // Speaker Tab Buttons
  if (speakerCustomerBtn) {
    speakerCustomerBtn.addEventListener("click", () => setSpeaker("customer"));
  }
  if (speakerOperatorBtn) {
    speakerOperatorBtn.addEventListener("click", () => setSpeaker("operator"));
  }

  // Microphone Recording Button
  if (micRecordBtn) {
    micRecordBtn.addEventListener("click", toggleMicrophoneRecording);
  }

  // Manual Tag Append Buttons
  if (addCustomerLineBtn) {
    addCustomerLineBtn.addEventListener("click", () => {
      setSpeaker("customer");
      if (!inquiryInput.value.trim()) {
        inquiryInput.value = "顧客: ";
      } else {
        inquiryInput.value += "\n顧客: ";
      }
      charCount.textContent = `${inquiryInput.value.length}文字`;
      inquiryInput.focus();
    });
  }

  if (addOperatorLineBtn) {
    addOperatorLineBtn.addEventListener("click", () => {
      setSpeaker("operator");
      if (!inquiryInput.value.trim()) {
        inquiryInput.value = "オペレーター: ";
      } else {
        inquiryInput.value += "\nオペレーター: ";
      }
      charCount.textContent = `${inquiryInput.value.length}文字`;
      inquiryInput.focus();
    });
  }

  // Demo Preset Buttons
  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const caseNum = btn.getAttribute("data-case");
      presetButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      if (DEMO_CASES[caseNum]) {
        const text = DEMO_CASES[caseNum].text;
        inquiryInput.value = text;
        charCount.textContent = `${inquiryInput.value.length}文字`;

        // Also add customer message to timeline
        addChatMessage("customer", text);

        inquiryInput.focus();
        showToast(`事例 ${caseNum} (${DEMO_CASES[caseNum].title}) を入力しました`);
      }
    });
  });

  // Analyze Button
  analyzeBtn.addEventListener("click", runAnalysis);

  // Escalate Action Button
  escalateActionBtn.addEventListener("click", () => {
    showToast("🚨 責任者（SV）へのエスカレーション要求を発行しました", "error");
    escalateActionBtn.disabled = true;
    escalateActionBtn.innerHTML = "<span>✓ 引き継ぎチケット発行済 (SV待機中)</span>";
    escalateActionBtn.style.backgroundColor = "#059669";
  });

  // Adopt Action Button
  adoptActionBtn.addEventListener("click", () => {
    showToast("✓ AI推奨回答をオペレーターの応対方針として採用しました", "success");
    adoptActionBtn.style.backgroundColor = "#047857";
    adoptActionBtn.innerHTML = "<span>✓ 採用済み</span>";
  });

  // Modify Action Button
  modifyActionBtn.addEventListener("click", () => {
    actionDisplayArea.classList.add("hidden");
    actionEditArea.classList.remove("hidden");
    editActionInput.value = resActionText.textContent.trim();
    editActionInput.focus();
  });

  // Cancel Edit
  cancelEditBtn.addEventListener("click", () => {
    actionEditArea.classList.add("hidden");
    actionDisplayArea.classList.remove("hidden");
  });

  // Save Modified Action to Knowledge Base
  saveKbBtn.addEventListener("click", saveKnowledge);

  // Modal Open/Close
  apiStatusPill.addEventListener("click", openSettings);
  openSettingsBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);
  cancelSettingsBtn.addEventListener("click", closeSettings);
  saveSettingsBtn.addEventListener("click", saveSettings);

  document.getElementById("errorOpenSettingsBtn")?.addEventListener("click", openSettings);
  document.getElementById("errorRetryBtn")?.addEventListener("click", runAnalysis);

  // Test STT Button
  if (testSttBtn) {
    testSttBtn.addEventListener("click", async () => {
      testSttBtn.disabled = true;
      testSttBtn.textContent = "テスト中...";
      try {
        const res = await fetch("/api/transcribe/test");
        const data = await res.json();
        if (data.connected) {
          showToast(`✓ ${data.message}`, "success");
        } else {
          showToast(`⚠ ${data.message}`, "error");
        }
      } catch (err) {
        showToast("STTテスト失敗: " + err.message, "error");
      } finally {
        testSttBtn.disabled = false;
        testSttBtn.textContent = "STTテスト";
      }
    });
  }

  // Google OAuth Login Button
  if (googleAuthBtn) {
    googleAuthBtn.addEventListener("click", async () => {
      try {
        const selectedUri = document.getElementById("modalRedirectUriSelect")?.value;
        let url = "/api/auth/google/url";
        if (selectedUri && selectedUri !== "auto") {
          url += `?redirectUri=${encodeURIComponent(selectedUri)}`;
        }
        const res = await fetch(url);
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        } else {
          alert("OAuth URLの取得に失敗しました: " + (data.error || ""));
        }
      } catch (e) {
        alert("通信エラー: " + e.message);
      }
    });
  }

  const googleLogoutBtn = document.getElementById("googleLogoutBtn");
  if (googleLogoutBtn) {
    googleLogoutBtn.addEventListener("click", async () => {
      try {
        await fetch("/api/auth/google/logout", { method: "POST" });
        showToast("Google認証情報をログアウトしました", "info");
        await checkApiHealth();
      } catch (e) {
        showToast("ログアウト失敗: " + e.message, "error");
      }
    });
  }
}

// ----------------------------------------------------
// Health Check & Settings
// ----------------------------------------------------
async function checkApiHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    apiHealth = data;

    const oauthStatusTag = document.getElementById("oauthStatusTag");
    const googleLogoutBtn = document.getElementById("googleLogoutBtn");

    if (data.isOAuthAuthenticated) {
      if (oauthStatusTag) {
        oauthStatusTag.textContent = "認証済み (Google OAuth)";
        oauthStatusTag.style.backgroundColor = "#dcfce7";
        oauthStatusTag.style.color = "#15803d";
      }
      if (googleLogoutBtn) googleLogoutBtn.classList.remove("hidden");
    } else {
      if (oauthStatusTag) {
        oauthStatusTag.textContent = "未認証";
        oauthStatusTag.style.backgroundColor = "#f1f5f9";
        oauthStatusTag.style.color = "#64748b";
      }
      if (googleLogoutBtn) googleLogoutBtn.classList.add("hidden");
    }

    if (data.connected) {
      apiStatusDot.className = "status-indicator-dot connected";
      apiStatusLabel.textContent = data.authType === "oauth"
        ? `Gemini API ● 接続中 (Google OAuth)`
        : `Gemini API ● 接続中 (${data.model})`;
      apiStatusPill.style.borderColor = "#22c55e";
    } else {
      apiStatusDot.className = "status-indicator-dot disconnected";
      apiStatusLabel.textContent = data.status === "configured"
        ? "Gemini API ● 疎通エラー"
        : "Gemini API ● 未設定 (クリックして設定)";
      apiStatusPill.style.borderColor = "#ef4444";
    }

    if (data.hasOAuthSecret) {
      document.getElementById("oauthSection")?.classList.remove("hidden");
      if (modalOAuthProject) modalOAuthProject.textContent = data.oauthProject || "なし";
      if (modalOAuthClientId) modalOAuthClientId.textContent = data.oauthClientId || "なし";
    }

    if (modalStatusBox) {
      modalStatusBox.textContent = data.message || (data.connected ? "接続は正常です。" : "APIキーまたはGoogle認証の設定が必要です。");
      modalStatusBox.style.color = data.connected ? "#15803d" : "#b91c1c";
    }

    if (modalModelSelect) {
      modalModelSelect.value = data.model || "gemini-3.7-flash";
    }
  } catch (err) {
    apiStatusDot.className = "status-indicator-dot disconnected";
    apiStatusLabel.textContent = "Gemini API ● サーバー未接続";
    apiStatusPill.style.borderColor = "#ef4444";
  }
}

function openSettings() {
  settingsModal.classList.remove("hidden");
}

function closeSettings() {
  settingsModal.classList.add("hidden");
}

async function saveSettings() {
  const key = modalApiKey.value.trim();
  const speechKey = modalSpeechKey?.value.trim() || "";
  const model = modalModelSelect.value;

  saveSettingsBtn.disabled = true;
  saveSettingsBtn.textContent = "確認中...";

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key, speechApiKey: speechKey, model: model })
    });
    const data = await res.json();
    showToast(data.message, "success");
    await checkApiHealth();
    closeSettings();
  } catch (err) {
    showToast("設定の保存に失敗しました: " + err.message, "error");
  } finally {
    saveSettingsBtn.disabled = false;
    saveSettingsBtn.textContent = "保存して接続テスト";
  }
}

// ----------------------------------------------------
// Update Knowledge Count
// ----------------------------------------------------
async function updateKnowledgeCount() {
  try {
    const res = await fetch("/api/cases");
    const data = await res.json();
    if (data.cases) {
      kbCountBadge.textContent = `${data.cases.length} 件`;
    }
  } catch (e) {}
}

// ----------------------------------------------------
// Run AI Analysis (Core Dynamic Flow)
// ----------------------------------------------------
async function runAnalysis() {
  const text = inquiryInput.value.trim();
  if (!text) {
    showToast("問い合わせ内容を入力してください", "error");
    inquiryInput.focus();
    return;
  }

  // Reset UI states
  emptyState.classList.add("hidden");
  resultsContainer.classList.add("hidden");
  errorPanel.classList.add("hidden");
  escalationBanner.classList.add("hidden");
  loadingPanel.classList.remove("hidden");
  analyzeBtn.disabled = true;

  // Reset escalate button state
  escalateActionBtn.disabled = false;
  escalateActionBtn.innerHTML = "<span>🚨 責任者（SV）へ引き継ぐ</span>";
  escalateActionBtn.style.backgroundColor = "#e11d48";

  // Reset adopt button state
  adoptActionBtn.disabled = false;
  adoptActionBtn.innerHTML = "<span>✓ この回答を採用</span>";
  adoptActionBtn.style.backgroundColor = "#10b981";

  // Ensure normal display mode for recommended action
  actionEditArea.classList.add("hidden");
  actionDisplayArea.classList.remove("hidden");

  // Animate loading steps
  startLoadingStepAnimation();

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inquiryText: text,
        model: apiHealth.model || "gemini-3.7-flash"
      })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "AI分析に失敗しました。");
    }

    currentAnalysisData = data.data;
    renderAnalysisResult(data.data, data.modelUsed);
    showToast("AI分析が完了しました", "success");
  } catch (err) {
    console.error("Analysis Error:", err);
    errorPanel.classList.remove("hidden");
    document.getElementById("errorTitle").textContent = "AI分析に失敗しました";
    document.getElementById("errorMessage").textContent = err.message || "通信状況またはAPI設定を確認してください。";
  } finally {
    clearInterval(stepTimer);
    loadingPanel.classList.add("hidden");
    analyzeBtn.disabled = false;
  }
}

// Step-by-step progress animation while waiting for Gemini
function startLoadingStepAnimation() {
  const steps = [
    document.getElementById("step1"),
    document.getElementById("step2"),
    document.getElementById("step3")
  ];
  steps.forEach((s) => s.classList.remove("active"));
  steps[0].classList.add("active");

  let currentStep = 0;
  clearInterval(stepTimer);
  stepTimer = setInterval(() => {
    if (currentStep < 2) {
      steps[currentStep].classList.remove("active");
      currentStep++;
      steps[currentStep].classList.add("active");
    }
  }, 750);
}

// ----------------------------------------------------
// Render Results Dynamically
// ----------------------------------------------------
function renderAnalysisResult(data, modelUsed) {
  // 1. Human Escalation Check (Critical Section 9)
  if (data.humanRequired) {
    escalationBanner.classList.remove("hidden");
    escalationReasonText.textContent = data.humanReason || "問い合わせ内容が具体化されておらず、AIだけでは適切な対応を判断できない可能性があります。";
  } else {
    escalationBanner.classList.add("hidden");
  }

  // 2. Summary & Tags
  resCategory.textContent = data.category || "一般問い合わせ";
  
  // Urgency badge
  const urgency = (data.urgency || "medium").toLowerCase();
  resUrgency.className = `urgency-badge ${urgency}`;
  const urgencyLabelMap = { high: "高", medium: "中", low: "低" };
  resUrgencyText.textContent = urgencyLabelMap[urgency] || urgency;

  resDepartment.textContent = data.recommendedDepartment || "総合案内窓口";
  resSummary.textContent = data.summary || "-";

  // 3. Recommended Action
  resActionText.textContent = data.recommendedAction || "顧客のお問い合わせ内容を再度確認し、適切にご案内してください。";

  // 4. Cautions Checklist
  resCautionsList.innerHTML = "";
  if (Array.isArray(data.cautions) && data.cautions.length > 0) {
    data.cautions.forEach((caution, idx) => {
      const li = document.createElement("li");
      li.className = "caution-item";
      
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "caution-checkbox";
      checkbox.id = `caution-${idx}`;
      
      const span = document.createElement("span");
      span.className = "caution-text";
      span.textContent = caution;

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          span.classList.add("checked");
        } else {
          span.classList.remove("checked");
        }
      });

      li.appendChild(checkbox);
      li.appendChild(span);
      resCautionsList.appendChild(li);
    });
  } else {
    resCautionsList.innerHTML = `<li class="caution-item">特段の注意事項はありません</li>`;
  }

  // 5. Related Past Cases
  resCasesList.innerHTML = "";
  if (modelUsed) {
    resModelBadge.textContent = `${modelUsed} による動的選定`;
  }

  if (Array.isArray(data.relatedCases) && data.relatedCases.length > 0) {
    data.relatedCases.forEach((c) => {
      const card = document.createElement("div");
      card.className = "case-card";

      const header = document.createElement("div");
      header.className = "case-card-header";

      const title = document.createElement("span");
      title.className = "case-title";
      title.textContent = c.title || "関連事例";

      const relevance = document.createElement("span");
      relevance.className = "case-relevance";
      relevance.textContent = c.relevance || "類似問い合わせ";

      header.appendChild(title);
      header.appendChild(relevance);

      const response = document.createElement("div");
      response.className = "case-response";
      response.textContent = c.response || "";

      card.appendChild(header);
      card.appendChild(response);
      resCasesList.appendChild(card);
    });
  } else {
    resCasesList.innerHTML = `<div class="case-card">直近の該当事例はありません</div>`;
  }

  // Reveal results
  resultsContainer.classList.remove("hidden");
}

// ----------------------------------------------------
// Human Knowledge Feedback Loop (Section 12)
// ----------------------------------------------------
async function saveKnowledge() {
  const modifiedText = editActionInput.value.trim();
  if (!modifiedText) {
    showToast("修正内容を入力してください", "error");
    return;
  }

  saveKbBtn.disabled = true;
  saveKbBtn.textContent = "保存中...";

  try {
    const res = await fetch("/api/knowledge/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `${resCategory.textContent}: ${resSummary.textContent.slice(0, 20)}...`,
        category: resCategory.textContent,
        department: resDepartment.textContent,
        inquiry: inquiryInput.value.trim(),
        response: modifiedText
      })
    });

    const data = await res.json();
    if (data.success) {
      showToast("💡 修正内容を新しい対応事例として組織ナレッジに蓄積しました！", "success");
      resActionText.textContent = modifiedText;
      actionEditArea.classList.add("hidden");
      actionDisplayArea.classList.remove("hidden");
      updateKnowledgeCount();
    } else {
      throw new Error(data.error || "保存に失敗しました");
    }
  } catch (err) {
    showToast("ナレッジ保存エラー: " + err.message, "error");
  } finally {
    saveKbBtn.disabled = false;
    saveKbBtn.innerHTML = "<span>💾 修正内容を組織ナレッジに蓄積保存</span>";
  }
}

// ----------------------------------------------------
// Toast Notification
// ----------------------------------------------------
function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  
  const icon = type === "success" ? "✓" : type === "error" ? "⚠" : "ℹ";
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
