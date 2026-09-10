const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { OAuth2Client } = require('google-auth-library');

// Load environment variables
dotenv.config();

const app = express();
const DEFAULT_PORT = parseInt(process.env.PORT || '8080', 10);

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Safe JSON file reader (handles BOM cleanly)
function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '').trim();
    return JSON.parse(content);
  } catch (e) {
    console.warn(`[JSON] Warning parsing ${path.basename(filePath)}:`, e.message);
    return null;
  }
}

// App configuration & state
let activeApiKey = process.env.GEMINI_API_KEY || '';
let activeModel = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
let activeSpeechApiKey = process.env.GOOGLE_SPEECH_API_KEY || 'AIzaSyCep2TUiUsKHLKa7Hv6gFtpkIoOlisGV4E';
let actualRunningPort = DEFAULT_PORT;
let lastUsedRedirectUri = null;

// Token persistence file
const TOKEN_FILE = path.join(__dirname, '.oauth_tokens.json');
let activeOAuthTokens = readJsonSafe(TOKEN_FILE);
if (activeOAuthTokens) {
  console.log('[Auth] Loaded saved Google OAuth tokens from .oauth_tokens.json');
}

// Load Knowledge Base
let knowledgeBase = readJsonSafe(path.join(__dirname, 'knowledgeBase.json')) || [];
console.log(`[KnowledgeBase] Loaded ${knowledgeBase.length} past cases.`);

// Check for client_secret JSON file
let oauthClientConfig = null;
try {
  const files = fs.readdirSync(__dirname);
  const secretFile = files.find(f => f.startsWith('client_secret_') && f.endsWith('.json'));
  if (secretFile) {
    const parsed = readJsonSafe(path.join(__dirname, secretFile));
    const web = parsed ? (parsed.web || parsed.installed) : null;
    if (web) {
      oauthClientConfig = {
        fileName: secretFile,
        projectId: web.project_id || 'bell-gai-intern-20260910',
        clientId: web.client_id,
        clientSecret: web.client_secret,
        redirectUris: web.redirect_uris || [],
        javascriptOrigins: web.javascript_origins || [],
      };
      console.log(`[Auth] Loaded Google OAuth credentials (Project: ${oauthClientConfig.projectId})`);
    }
  }
} catch (e) {
  console.warn('[Auth] No client_secret file parsed:', e.message);
}

// Helper to create OAuth2Client
function getOAuthClient(customRedirectUri) {
  if (!oauthClientConfig) return null;
  const redirectUri = customRedirectUri || lastUsedRedirectUri || oauthClientConfig.redirectUris[0] || 'http://localhost:8081/auth/callback';
  const client = new OAuth2Client(
    oauthClientConfig.clientId,
    oauthClientConfig.clientSecret,
    redirectUri
  );
  if (activeOAuthTokens) {
    client.setCredentials(activeOAuthTokens);
  }
  return client;
}

// Function to get active auth header or param, refreshing OAuth token if needed
async function getValidAuthDetails() {
  if (activeOAuthTokens && activeOAuthTokens.access_token) {
    if (activeOAuthTokens.expiry_date && activeOAuthTokens.expiry_date < Date.now() + 60000 && activeOAuthTokens.refresh_token) {
      try {
        console.log('[Auth] Refreshing expired OAuth token...');
        const client = getOAuthClient();
        const { credentials } = await client.refreshAccessToken();
        activeOAuthTokens = credentials;
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(activeOAuthTokens, null, 2), 'utf-8');
        console.log('[Auth] OAuth token refreshed successfully!');
      } catch (err) {
        console.warn('[Auth] Failed to refresh OAuth token:', err.message);
      }
    }
    return { type: 'oauth', token: activeOAuthTokens.access_token };
  }

  if (activeApiKey && activeApiKey.trim() !== '') {
    return { type: 'api_key', key: activeApiKey.trim() };
  }

  return { type: 'none' };
}

// JSON Schema definition for Gemini Structured Outputs
const analysisResponseSchema = {
  type: 'OBJECT',
  properties: {
    category: {
      type: 'STRING',
      description: '問い合わせの分類（例: 商品不良・返品, 料金・請求, 再問い合わせ, クレーム・説明相違, 契約・変更, 判断困難・要ヒアリング 等）'
    },
    summary: {
      type: 'STRING',
      description: '顧客の問い合わせ内容の簡潔な要約（1行程度）'
    },
    urgency: {
      type: 'STRING',
      enum: ['low', 'medium', 'high'],
      description: '問い合わせの緊急度（高: high, 中: medium, 低: low）'
    },
    recommendedDepartment: {
      type: 'STRING',
      description: '推奨される対応担当部署（例: 返品・交換担当, 料金担当, クレーム対応担当 等）'
    },
    recommendedAction: {
      type: 'STRING',
      description: 'オペレーターへの推奨対応・案内手順（丁寧かつ具体的なアクション）'
    },
    cautions: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'オペレーターが対応時に確認すべき注意事項・確認項目のリスト（2〜4点）'
    },
    relatedCases: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: '過去事例のタイトル' },
          response: { type: 'STRING', description: '過去の対応内容要約' },
          relevance: { type: 'STRING', description: '今回の問い合わせと関連する理由' }
        },
        required: ['title', 'response', 'relevance']
      },
      description: '提供されたナレッジベースから選択した最も関連性の高い過去の類似事例（1〜2件）'
    },
    humanRequired: {
      type: 'BOOLEAN',
      description: '人間による対応・エスカレーションが必要かどうか。問い合わせ内容が曖昧、感情的混乱、状況が特定できない（例: どうしたらいいのか自分でも分からなくて困っている等）、またはAIだけでは判断不能な特殊・深刻案件の場合は必ず true にすること。明確な案件は false。'
    },
    humanReason: {
      type: 'STRING',
      description: 'humanRequiredがtrueの場合、人間による対応が必要な具体的な理由。falseの場合は空文字。'
    }
  },
  required: [
    'category',
    'summary',
    'urgency',
    'recommendedDepartment',
    'recommendedAction',
    'cautions',
    'relatedCases',
    'humanRequired',
    'humanReason'
  ]
};

// System instruction prompt
function buildSystemInstruction() {
  return `あなたはコールセンターの熟練オペレーター支援AI「Call Assist AI」です。
オペレーターが顧客から受けた問い合わせ内容（音声文字起こしまたは入力テキスト）を分析し、
迅速かつ適切な応対ができるよう、構造化されたJSON形式で支援情報を返してください。

【重要な判断基準】
1. 問い合わせ分類 (category):
   顧客の主訴を的確に分類してください（例: 商品不良・返品、料金・請求、再問い合わせ、クレーム・説明相違、契約・変更、判断困難・要ヒアリング 等）。
2. 緊急度 (urgency):
   怒り・苦情・早急な対応が必要なものは high、通常の問い合わせ・要望は medium、簡単な確認や質問は low。
3. 推奨部署 (recommendedDepartment):
   迅速に解決できる適切な担当窓口を提示してください。
4. 推奨対応 (recommendedAction):
   オペレーターがそのまま顧客に案内できる丁寧で実践的なアクションを提示してください。
5. 注意事項 (cautions):
   確認漏れを防ぐため、確認すべき事項（注文番号、購入日、契約名義、感情への配慮など）をリストアップしてください。
6. 過去の対応事例 (relatedCases):
   以下の【過去事例ナレッジベース】を参照し、今回の問い合わせ内容に合致または参考になる事例を1〜2件選定して、そのタイトル、対応内容、およびなぜ参考になるかの理由を記述してください。
7. 人間による対応の要否 (humanRequired & humanReason):
   【最重要】AIは万能ではなく、オペレーターを支援するツールです。
   もし顧客の相談内容が曖昧で具体化されていない場合（例:「どうしたらいいのか自分でも分からなくて困っている」「何か変なんです」など詳細がわからないもの）、
   または強い憤り・特殊事象で人間の深いヒアリングや判断が不可欠な場合は、
   「humanRequired: true」とし、humanReasonに「問い合わせ内容が具体化されておらず、AIだけでは適切な対応を判断できないため、丁寧な初期ヒアリングまたは責任者へのエスカレーションが必要です」と明確に記載してください。
   明確に内容が判断できる通常の問い合わせ（商品破損、料金確認、進捗確認など）は「humanRequired: false」としてください。

【過去事例ナレッジベース】
${JSON.stringify(knowledgeBase, null, 2)}
`;
}

// Function to call Gemini via REST API or Vertex AI
async function callGemini(promptText, requestedModel) {
  const auth = await getValidAuthDetails();
  if (auth.type === 'none') {
    throw new Error('Gemini APIキーまたはGoogle認証が設定されていません。.envファイルまたは画面右上の「API設定」から設定してください。');
  }

  const modelsToTry = [
    requestedModel || activeModel || 'gemini-3.7-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest'
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`[Gemini] Calling ${modelName} (Auth: ${auth.type})`);
      
      let url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const headers = { 'Content-Type': 'application/json' };
      
      if (auth.type === 'api_key') {
        url += `?key=${auth.key}`;
      } else if (auth.type === 'oauth') {
        headers['Authorization'] = `Bearer ${auth.token}`;
        if (oauthClientConfig && oauthClientConfig.projectId) {
          headers['x-goog-user-project'] = oauthClientConfig.projectId;
        }
      }

      const requestBody = {
        systemInstruction: {
          parts: [{ text: buildSystemInstruction() }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `【顧客からの問い合わせ内容】\n${promptText}` }]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: analysisResponseSchema,
          temperature: 0.2
        }
      };

      let response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      // Vertex AI fallback if OAuth 404/403
      if (!response.ok && auth.type === 'oauth' && oauthClientConfig && oauthClientConfig.projectId) {
        console.log(`[Gemini] Generative Language API returned ${response.status}. Trying Vertex AI API fallback...`);
        const vertexUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${oauthClientConfig.projectId}/locations/us-central1/publishers/google/models/${modelName}:generateContent`;
        const vertexResp = await fetch(vertexUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${auth.token}`
          },
          body: JSON.stringify(requestBody)
        });
        if (vertexResp.ok) {
          response = vertexResp;
        }
      }

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[Gemini] Model ${modelName} returned status ${response.status}: ${errText}`);
        if (response.status === 404) {
          lastError = new Error(`モデル ${modelName} は利用できませんでした (${response.status})`);
          continue;
        }
        let parsedErr;
        try { parsedErr = JSON.parse(errText); } catch (e) {}
        const msg = (parsedErr && parsedErr.error && parsedErr.error.message) || errText;
        throw new Error(`Gemini API エラー (${response.status}): ${msg}`);
      }

      const data = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error('Gemini APIから回答テキストを取得できませんでした。');
      }

      const parsedJson = JSON.parse(rawText);
      return {
        result: parsedJson,
        modelUsed: modelName
      };
    } catch (err) {
      console.error(`[Gemini] Error with ${modelName}:`, err.message);
      lastError = err;
      if (!err.message.includes('404') && !err.message.includes('not found')) {
        break;
      }
    }
  }

  throw lastError || new Error('Gemini API呼び出しに失敗しました。');
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Health & Connection Check
app.get('/api/health', async (req, res) => {
  const auth = await getValidAuthDetails();
  const configured = auth.type !== 'none';

  const host = req.get('host') || (`localhost:${actualRunningPort}`);
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const defaultLocalCallback = `${protocol}://${host}/auth/callback`;

  const responseData = {
    status: configured ? 'configured' : 'unconfigured',
    authType: auth.type,
    model: activeModel,
    port: actualRunningPort,
    hasOAuthSecret: !!oauthClientConfig,
    oauthProject: (oauthClientConfig && oauthClientConfig.projectId) || null,
    oauthClientId: oauthClientConfig ? (`${oauthClientConfig.clientId.substring(0, 18)}...`) : null,
    isOAuthAuthenticated: auth.type === 'oauth',
    suggestedCallbackUri: defaultLocalCallback,
    connected: false,
    message: ''
  };

  if (!configured) {
    responseData.message = 'Gemini APIキーまたはGoogle OAuth認証が未設定です。画面右上の「設定」から接続してください。';
    return res.json(responseData);
  }

  try {
    let testUrl = auth.type === 'api_key'
      ? `https://generativelanguage.googleapis.com/v1beta/models?key=${auth.key}&pageSize=1`
      : 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
    const headers = auth.type === 'oauth' ? {
      'Authorization': `Bearer ${auth.token}`,
      ...((oauthClientConfig && oauthClientConfig.projectId) ? { 'x-goog-user-project': oauthClientConfig.projectId } : {})
    } : {};
    
    const r = await fetch(testUrl, { headers });
    if (r.ok) {
      responseData.connected = true;
      responseData.message = auth.type === 'oauth'
        ? `Gemini API 接続完了 (Google OAuth: ${(oauthClientConfig && oauthClientConfig.projectId) || 'GCP'})`
        : `Gemini API 接続完了 (${activeModel})`;
    } else {
      const txt = await r.text();
      responseData.connected = false;
      responseData.message = `API疎通エラー (${r.status}): ${txt}`;
    }
  } catch (err) {
    responseData.connected = false;
    responseData.message = `接続テスト失敗: ${err.message}`;
  }

  res.json(responseData);
});

// 2. Set API Key or Model dynamically
app.post('/api/config', async (req, res) => {
  const { apiKey, model, speechApiKey } = req.body;
  if (apiKey !== undefined && apiKey.trim() !== '') {
    activeApiKey = apiKey.trim();
  }
  if (model) {
    activeModel = model.trim();
  }
  if (speechApiKey !== undefined && speechApiKey.trim() !== '') {
    activeSpeechApiKey = speechApiKey.trim();
  }
  const auth = await getValidAuthDetails();
  res.json({
    success: true,
    authType: auth.type,
    model: activeModel,
    hasSpeechKey: !!activeSpeechApiKey,
    message: '設定を更新しました。'
  });
});

// 3. AI Analysis Endpoint (Core Request)
app.post('/api/analyze', async (req, res) => {
  const { inquiryText, model } = req.body;

  if (!inquiryText || typeof inquiryText !== 'string' || inquiryText.trim() === '') {
    return res.status(400).json({ error: '問い合わせ内容が入力されていません。' });
  }

  const auth = await getValidAuthDetails();
  if (auth.type === 'none') {
    return res.status(401).json({
      error: 'Gemini APIが接続されていません。.env に GEMINI_API_KEY を設定するか、画面右上の「API設定」からキーを入力してください。'
    });
  }

  try {
    const { result, modelUsed } = await callGemini(inquiryText.trim(), model || activeModel);
    res.json({
      success: true,
      data: result,
      modelUsed
    });
  } catch (err) {
    console.error('[API Analyze Error]', err);
    res.status(500).json({
      error: `AI分析に失敗しました: ${err.message}`,
      hint: '通信状況またはAPI設定（APIキー、モデル名）を確認してください。'
    });
  }
});

// 3.5. Google Cloud Speech-to-Text Endpoint
app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioContent, encoding, sampleRateHertz, mimeType, speaker } = req.body;
    if (!audioContent) {
      return res.status(400).json({ error: '音声データが送信されていません。' });
    }

    const key = activeSpeechApiKey || process.env.GOOGLE_SPEECH_API_KEY;
    if (!key) {
      return res.status(401).json({ error: 'Google Cloud Speech-to-Text APIキーが設定されていません。' });
    }

    let enc = encoding || 'WEBM_OPUS';
    if (mimeType && mimeType.includes('wav')) enc = 'LINEAR16';
    if (mimeType && mimeType.includes('ogg')) enc = 'OGG_OPUS';
    if (mimeType && mimeType.includes('webm')) enc = 'WEBM_OPUS';
    if (mimeType && mimeType.includes('mp3')) enc = 'MP3';

    // Satisfy HTTP Referer restriction on API key
    const host = req.get('host') || `localhost:${actualRunningPort}`;
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const referer = req.get('referer') || `${protocol}://${host}/`;

    // Robust Base64 extraction (strips ANY data URL prefix regardless of codec parameters or MIME type)
    let cleanAudio = audioContent;
    if (typeof cleanAudio === 'string') {
      if (cleanAudio.includes('base64,')) {
        cleanAudio = cleanAudio.split('base64,')[1];
      } else if (cleanAudio.includes(',')) {
        cleanAudio = cleanAudio.split(',')[1];
      }
      cleanAudio = cleanAudio.trim().replace(/\s+/g, '');
    }

    if (!cleanAudio || cleanAudio.length < 50) {
      return res.status(400).json({ error: '録音された音声データが小さすぎるか空です。もう一度お試しください。' });
    }

    let rate = sampleRateHertz;
    if (!rate) {
      if (enc === 'WEBM_OPUS' || enc === 'OGG_OPUS') {
        rate = 48000;
      } else {
        rate = 16000;
      }
    }

    const requestBody = {
      config: {
        encoding: enc,
        sampleRateHertz: rate,
        languageCode: 'ja-JP',
        enableAutomaticPunctuation: true
      },
      audio: {
        content: cleanAudio
      }
    };

    console.log(`[Speech] Transcribing audio with encoding: ${enc}, rate: ${rate}Hz (Referer: ${referer})`);
    const url = `https://speech.googleapis.com/v1/speech:recognize?key=${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': referer
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    if (!response.ok) {
      console.warn('[Speech] Error from Google Speech API:', data);
      return res.status(response.status).json({
        error: data.error?.message || '音声認識APIエラーが発生しました。',
        details: data
      });
    }

    const transcript = (data.results || [])
      .map(r => r.alternatives?.[0]?.transcript || '')
      .join(' ')
      .trim();

    console.log(`[Speech] Transcription result: "${transcript}" (Speaker: ${speaker || 'customer'})`);
    res.json({
      success: true,
      transcript: transcript || '',
      speaker: speaker || 'customer',
      confidence: data.results?.[0]?.alternatives?.[0]?.confidence || null
    });
  } catch (err) {
    console.error('[Speech Error]', err);
    res.status(500).json({ error: '音声認識処理エラー: ' + err.message });
  }
});

// 3.6. Test Speech-to-Text API Connectivity
app.get('/api/transcribe/test', async (req, res) => {
  try {
    const key = activeSpeechApiKey || process.env.GOOGLE_SPEECH_API_KEY;
    if (!key) {
      return res.status(401).json({ connected: false, message: 'Google Cloud Speech APIキーが未設定です。' });
    }
    const host = req.get('host') || `localhost:${actualRunningPort}`;
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const referer = req.get('referer') || `${protocol}://${host}/`;

    const testBuffer = Buffer.alloc(16000); // 0.5s silent PCM
    const url = `https://speech.googleapis.com/v1/speech:recognize?key=${key}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': referer },
      body: JSON.stringify({
        config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'ja-JP' },
        audio: { content: testBuffer.toString('base64') }
      })
    });

    if (r.ok) {
      res.json({ success: true, connected: true, message: 'Google Cloud Speech-to-Text API 接続正常 (HTTP 200)' });
    } else {
      const txt = await r.text();
      res.status(r.status).json({ success: false, connected: false, message: `APIエラー (${r.status}): ${txt}` });
    }
  } catch (e) {
    res.status(500).json({ success: false, connected: false, message: '接続テスト失敗: ' + e.message });
  }
});

// 4. Get Knowledge Base Cases
app.get('/api/cases', (req, res) => {
  res.json({ cases: knowledgeBase });
});

// 5. Save Operator Knowledge (Human-in-the-loop)
app.post('/api/knowledge/save', (req, res) => {
  const { title, category, department, inquiry, response } = req.body;
  if (!title || !response) {
    return res.status(400).json({ error: '事例タイトルと対応内容は必須です。' });
  }

  const newCase = {
    id: `CASE-${Date.now().toString().slice(-4)}`,
    title,
    category: category || '一般問い合わせ',
    department: department || 'オペレーター対応窓口',
    summary: inquiry || title,
    response,
    created_at: new Date().toISOString(),
    operatorAdded: true
  };

  knowledgeBase.unshift(newCase);

  try {
    fs.writeFileSync(path.join(__dirname, 'knowledgeBase.json'), JSON.stringify(knowledgeBase, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Could not save to knowledgeBase.json:', e.message);
  }

  res.json({
    success: true,
    message: '新しい対応事例を組織のナレッジとして保存・蓄積しました。',
    case: newCase,
    totalCases: knowledgeBase.length
  });
});

// 6. Google OAuth2 Login URL
app.get('/api/auth/google/url', (req, res) => {
  if (!oauthClientConfig) {
    return res.status(400).json({ error: 'client_secret JSONファイルが見つかりません。' });
  }

  const host = req.get('host') || (`localhost:${actualRunningPort}`);
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  
  const customRedirect = req.query.redirectUri;
  const callbackUri = customRedirect || `${protocol}://${host}/auth/callback`;

  lastUsedRedirectUri = callbackUri;

  const client = new OAuth2Client(
    oauthClientConfig.clientId,
    oauthClientConfig.clientSecret,
    callbackUri
  );

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/generative-language',
      'https://www.googleapis.com/auth/cloud-platform'
    ],
    prompt: 'consent'
  });

  console.log(`[Auth] Generated Google OAuth URL with redirect_uri: ${callbackUri}`);
  res.json({ url: authUrl, callbackUri });
});

// 7. Google OAuth Callback (handles both /auth/callback and /)
app.get(['/auth/callback', '/'], async (req, res, next) => {
  const { code, error } = req.query;
  if (error) {
    console.error('[Auth] OAuth returned error:', error);
    return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return next();
  }

  if (!oauthClientConfig) {
    return res.status(400).send('OAuth Client Config not found.');
  }

  try {
    const host = req.get('host') || (`localhost:${actualRunningPort}`);
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const callbackUri = lastUsedRedirectUri 
      || `${protocol}://${host}${req.path === '/auth/callback' ? '/auth/callback' : '/'}`;

    console.log(`[Auth] Exchanging OAuth code using redirectUri: ${callbackUri}`);

    const client = new OAuth2Client(
      oauthClientConfig.clientId,
      oauthClientConfig.clientSecret,
      callbackUri
    );

    const { tokens } = await client.getToken(code);
    activeOAuthTokens = tokens;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
    console.log('[Auth] Google OAuth tokens acquired & saved successfully!');
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[Auth] OAuth exchange error:', err.message);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// 8. Logout / Disconnect OAuth
app.post('/api/auth/google/logout', (req, res) => {
  activeOAuthTokens = null;
  if (fs.existsSync(TOKEN_FILE)) {
    try { fs.unlinkSync(TOKEN_FILE); } catch (e) {}
  }
  res.json({ success: true, message: 'Google認証情報をクリアしました。' });
});

// Function to start server with graceful fallback if port is in use
function startServer(portToTry) {
  const server = app.listen(portToTry, '0.0.0.0', () => {
    actualRunningPort = portToTry;
    console.log('====================================================');
    console.log(' Call Assist AI Server is running!');
    console.log(` Local:      http://localhost:${portToTry}`);
    console.log(' Production: http://buri.qch.jp (via reverse proxy)');
    console.log(` OAuth Configured: ${!!oauthClientConfig} (Project: ${oauthClientConfig?.projectId || 'none'})`);
    console.log(` Active Auth: ${activeApiKey ? 'API Key (Configured)' : 'None'}`);
    console.log(` Default Model: ${activeModel}`);
    console.log('====================================================');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Port Warning] Port ${portToTry} is already in use by another service.`);
      if (portToTry === DEFAULT_PORT && DEFAULT_PORT === 8080) {
        console.log('[Port Info] Automatically falling back to port 8081...');
        startServer(8081);
      } else if (portToTry === 8081) {
        console.log('[Port Info] Automatically falling back to port 3000...');
        startServer(3000);
      } else {
        console.error(`[Port Error] Could not bind to port ${portToTry}:`, err.message);
      }
    } else {
      console.error('[Server Error]', err);
    }
  });
}

startServer(DEFAULT_PORT);
