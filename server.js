const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const { OAuth2Client } = require("google-auth-library");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Load .env
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// App configuration & state
let activeApiKey = process.env.GEMINI_API_KEY || "";
let activeModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
let activeOAuthTokens = null; // { access_token, refresh_token, expiry_date }

// Load Knowledge Base
let knowledgeBase = [];
const kbPath = path.join(__dirname, "knowledgeBase.json");
if (fs.existsSync(kbPath)) {
  try {
    knowledgeBase = JSON.parse(fs.readFileSync(kbPath, "utf-8"));
  } catch (e) {
    console.error("Failed to load knowledgeBase.json:", e.message);
  }
}

// Check for client_secret JSON file
let oauthClientConfig = null;
let oauth2Client = null;
try {
  const files = fs.readdirSync(__dirname);
  const secretFile = files.find((f) => f.startsWith("client_secret_") && f.endsWith(".json"));
  if (secretFile) {
    const raw = fs.readFileSync(path.join(__dirname, secretFile), "utf-8");
    const parsed = JSON.parse(raw);
    const web = parsed.web || parsed.installed;
    if (web) {
      oauthClientConfig = {
        fileName: secretFile,
        projectId: web.project_id,
        clientId: web.client_id,
        clientSecret: web.client_secret,
        redirectUris: web.redirect_uris || [],
        javascriptOrigins: web.javascript_origins || [],
      };
      console.log(`[Auth] Loaded Google OAuth credentials from ${secretFile} (Project: ${oauthClientConfig.projectId})`);
    }
  }
} catch (e) {
  console.warn("[Auth] No valid client_secret file parsed:", e.message);
}

// Function to get active auth header or param
function getAuthDetails() {
  if (activeOAuthTokens && activeOAuthTokens.access_token) {
    return { type: "oauth", token: activeOAuthTokens.access_token };
  }
  if (activeApiKey && activeApiKey.trim() !== "") {
    return { type: "api_key", key: activeApiKey.trim() };
  }
  return { type: "none" };
}

// JSON Schema definition for Gemini Structured Outputs
const analysisResponseSchema = {
  type: "OBJECT",
  properties: {
    category: {
      type: "STRING",
      description: "問い合わせの分類（例: 商品不良・返品, 料金・請求, 再問い合わせ, クレーム・説明相違, 契約・変更, 判断困難・要ヒアリング 等）"
    },
    summary: {
      type: "STRING",
      description: "顧客の問い合わせ内容の簡潔な要約（1行程度）"
    },
    urgency: {
      type: "STRING",
      enum: ["low", "medium", "high"],
      description: "問い合わせの緊急度（高: high, 中: medium, 低: low）"
    },
    recommendedDepartment: {
      type: "STRING",
      description: "推奨される対応担当部署（例: 返品・交換担当, 料金担当, クレーム対応担当 等）"
    },
    recommendedAction: {
      type: "STRING",
      description: "オペレーターへの推奨対応・案内手順（丁寧かつ具体的なアクション）"
    },
    cautions: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "オペレーターが対応時に確認すべき注意事項・確認項目のリスト（2〜4点）"
    },
    relatedCases: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "過去事例のタイトル" },
          response: { type: "STRING", description: "過去の対応内容要約" },
          relevance: { type: "STRING", description: "今回の問い合わせと関連する理由" }
        },
        required: ["title", "response", "relevance"]
      },
      description: "提供されたナレッジベースから選択した最も関連性の高い過去の類似事例（1〜2件）"
    },
    humanRequired: {
      type: "BOOLEAN",
      description: "人間による対応・エスカレーションが必要かどうか。問い合わせ内容が曖昧、感情的混乱、状況が特定できない（例: 'どうしたらいいのか自分でも分からなくて困っている'等）、またはAIだけでは判断不能な特殊・深刻案件の場合は必ず true にすること。明確な案件は false。"
    },
    humanReason: {
      type: "STRING",
      description: "humanRequiredがtrueの場合、人間による対応が必要な具体的な理由。falseの場合は空文字。"
    }
  },
  required: [
    "category",
    "summary",
    "urgency",
    "recommendedDepartment",
    "recommendedAction",
    "cautions",
    "relatedCases",
    "humanRequired",
    "humanReason"
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
   怒り・苦情・早急な対応が必要なものは "high"、通常の問い合わせ・要望は "medium"、簡単な確認や質問は "low"。
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

// Function to call Gemini via REST API or SDK
async function callGemini(promptText, requestedModel) {
  const auth = getAuthDetails();
  if (auth.type === "none") {
    throw new Error("Gemini APIキーまたはGoogle認証が設定されていません。.envファイルまたは画面右上の「API設定」からキーを設定してください。");
  }

  // List of models to try in order of preference
  const modelsToTry = [
    requestedModel || activeModel || "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`[Gemini] Attempting generation with model: ${modelName} (Auth: ${auth.type})`);
      
      let url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const headers = { "Content-Type": "application/json" };
      if (auth.type === "api_key") {
        url += `?key=${auth.key}`;
      } else if (auth.type === "oauth") {
        headers["Authorization"] = `Bearer ${auth.token}`;
      }

      const requestBody = {
        systemInstruction: {
          parts: [{ text: buildSystemInstruction() }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `【顧客からの問い合わせ内容】\n${promptText}` }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: analysisResponseSchema,
          temperature: 0.2
        }
      };

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[Gemini] Model ${modelName} returned status ${response.status}: ${errText}`);
        // If 404 (model not found), try next model in loop
        if (response.status === 404) {
          lastError = new Error(`モデル ${modelName} は利用できませんでした (${response.status})`);
          continue;
        }
        let parsedErr;
        try {
          parsedErr = JSON.parse(errText);
        } catch (e) {}
        const msg = parsedErr?.error?.message || errText;
        throw new Error(`Gemini API エラー (${response.status}): ${msg}`);
      }

      const data = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error("Gemini APIから回答テキストを取得できませんでした。");
      }

      const parsedJson = JSON.parse(rawText);
      return {
        result: parsedJson,
        modelUsed: modelName
      };
    } catch (err) {
      console.error(`[Gemini] Error with ${modelName}:`, err.message);
      lastError = err;
      if (!err.message.includes("404") && !err.message.includes("not found")) {
        // If it's an authentication error or permission error, don't keep cycling models
        break;
      }
    }
  }

  throw lastError || new Error("Gemini API呼び出しに失敗しました。");
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Health & Connection Check
app.get("/api/health", async (req, res) => {
  const auth = getAuthDetails();
  const configured = auth.type !== "none";

  const responseData = {
    status: configured ? "configured" : "unconfigured",
    authType: auth.type,
    model: activeModel,
    port: PORT,
    hasOAuthSecret: !!oauthClientConfig,
    oauthProject: oauthClientConfig?.projectId || null,
    oauthClientId: oauthClientConfig ? `${oauthClientConfig.clientId.substring(0, 15)}...` : null,
    connected: false,
    message: ""
  };

  if (!configured) {
    responseData.message = "Gemini APIキーまたは認証情報が未設定です。画面上部または.envで設定してください。";
    return res.json(responseData);
  }

  // Test lightweight connection
  try {
    const testUrl = auth.type === "api_key"
      ? `https://generativelanguage.googleapis.com/v1beta/models?key=${auth.key}&pageSize=1`
      : `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`;
    const headers = auth.type === "oauth" ? { Authorization: `Bearer ${auth.token}` } : {};
    
    const r = await fetch(testUrl, { headers });
    if (r.ok) {
      responseData.connected = true;
      responseData.message = `Gemini API 接続完了 (${activeModel})`;
    } else {
      const txt = await r.text();
      responseData.connected = false;
      responseData.message = `APIキー疎通エラー (${r.status}): ${txt}`;
    }
  } catch (err) {
    responseData.connected = false;
    responseData.message = `接続テスト失敗: ${err.message}`;
  }

  res.json(responseData);
});

// 2. Set API Key or Model dynamically
app.post("/api/config", (req, res) => {
  const { apiKey, model } = req.body;
  if (apiKey !== undefined) {
    activeApiKey = apiKey.trim();
  }
  if (model) {
    activeModel = model.trim();
  }
  res.json({
    success: true,
    authType: getAuthDetails().type,
    model: activeModel,
    message: "設定を更新しました。"
  });
});

// 3. AI Analysis Endpoint (Core Request)
app.post("/api/analyze", async (req, res) => {
  const { inquiryText, model } = req.body;

  if (!inquiryText || typeof inquiryText !== "string" || inquiryText.trim() === "") {
    return res.status(400).json({ error: "問い合わせ内容が入力されていません。" });
  }

  const auth = getAuthDetails();
  if (auth.type === "none") {
    return res.status(401).json({
      error: "Gemini APIが接続されていません。.env に GEMINI_API_KEY を設定するか、画面右上の「API設定」からキーを入力してください。"
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
    console.error("[API Analyze Error]", err);
    res.status(500).json({
      error: `AI分析に失敗しました: ${err.message}`,
      hint: "通信状況またはAPI設定（APIキー、モデル名）を確認してください。"
    });
  }
});

// 4. Get Knowledge Base Cases
app.get("/api/cases", (req, res) => {
  res.json({ cases: knowledgeBase });
});

// 5. Save Operator Knowledge (Human-in-the-loop)
app.post("/api/knowledge/save", (req, res) => {
  const { title, category, department, inquiry, response } = req.body;
  if (!title || !response) {
    return res.status(400).json({ error: "事例タイトルと対応内容は必須です。" });
  }

  const newCase = {
    id: `CASE-${Date.now().toString().slice(-4)}`,
    title,
    category: category || "一般問い合わせ",
    department: department || "オペレーター対応窓口",
    summary: inquiry || title,
    response,
    created_at: new Date().toISOString(),
    operatorAdded: true
  };

  knowledgeBase.unshift(newCase);

  // Persist to file
  try {
    fs.writeFileSync(kbPath, JSON.stringify(knowledgeBase, null, 2), "utf-8");
  } catch (e) {
    console.warn("Could not save to knowledgeBase.json:", e.message);
  }

  res.json({
    success: true,
    message: "新しい対応事例を組織のナレッジとして保存・蓄積しました。",
    case: newCase,
    totalCases: knowledgeBase.length
  });
});

// 6. Google OAuth2 Login URL
app.get("/api/auth/google/url", (req, res) => {
  if (!oauthClientConfig) {
    return res.status(400).json({ error: "client_secret JSONファイルが見つかりません。" });
  }

  // Determine redirect URI
  const host = req.get("host");
  const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  const callbackUri = oauthClientConfig.redirectUris.find((u) => u.includes(host)) 
    || `${protocol}://${host}/auth/callback`
    || oauthClientConfig.redirectUris[0];

  const client = new OAuth2Client(
    oauthClientConfig.clientId,
    oauthClientConfig.clientSecret,
    callbackUri
  );

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/generative-language",
      "https://www.googleapis.com/auth/cloud-platform"
    ],
    prompt: "consent"
  });

  res.json({ url: authUrl, callbackUri });
});

// 7. Google OAuth Callback
app.get(["/auth/callback", "/"], async (req, res, next) => {
  const { code } = req.query;
  if (!code) {
    return next(); // continue to static files
  }

  if (!oauthClientConfig) {
    return res.status(400).send("OAuth Client Config not found.");
  }

  try {
    const host = req.get("host");
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const callbackUri = oauthClientConfig.redirectUris.find((u) => u.includes(host)) 
      || `${protocol}://${host}/auth/callback`
      || oauthClientConfig.redirectUris[0];

    const client = new OAuth2Client(
      oauthClientConfig.clientId,
      oauthClientConfig.clientSecret,
      callbackUri
    );

    const { tokens } = await client.getToken(code);
    activeOAuthTokens = tokens;
    console.log("[Auth] Google OAuth tokens acquired successfully!");
    res.redirect("/?auth=success");
  } catch (err) {
    console.error("[Auth] OAuth exchange error:", err.message);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`====================================================`);
  console.log(` Call Assist AI Server is running!`);
  console.log(` Local:      http://localhost:${PORT}`);
  console.log(` Production: http://buri.qch.jp (via reverse proxy)`);
  console.log(` Active Auth: ${getAuthDetails().type}`);
  console.log(` Default Model: ${activeModel}`);
  console.log(`====================================================`);
});
