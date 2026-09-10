import { WebSocketServer } from 'ws';
import { GoogleGenAI, Type } from '@google/genai';
import speech from '@google-cloud/speech'; // Google Cloud STT
import dotenv from 'dotenv';

dotenv.config();

// ==========================================
// 1. 初期設定・API確認
// ==========================================
if (!process.env.GEMINI_API_KEY) {
  console.error("エラー: GEMINI_API_KEY が設定されていません。");
  process.exit(1);
}

// Geminiクライアント初期化
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Google Cloud STTクライアント初期化
// ※環境変数 GOOGLE_APPLICATION_CREDENTIALS に認証JSONへのパスが設定されている前提で動きます
const sttClient = new speech.SpeechClient();

// ==========================================
// 2. 問い合わせ分類AI（LLM）の関数
// ==========================================
async function classifyInquiry(conversationBuffer) {
  if (!conversationBuffer || conversationBuffer.trim() === '') {
    return { primaryCategory: "その他", subCategory: "未特定", status: "未特定" };
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `以下の通話テキストから、現在の顧客の主要な問い合わせ種別を抽出してください。\n\n【会話内容】\n${conversationBuffer}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            primaryCategory: {
              type: Type.STRING,
              enum: ["製品仕様・操作", "料金・請求", "契約変更・手続き", "故障・不具合", "解約・キャンセル", "その他"],
              description: '顧客の主な問い合わせ分類'
            },
            subCategory: {
              type: Type.STRING,
              description: 'より具体的に要約した小分類（例：パスワード忘れ）'
            },
            status: {
              type: Type.STRING,
              enum: ["確定", "推測", "未特定"],
            }
          },
          required: ['primaryCategory', 'subCategory', 'status']
        }
      }
    });
    return JSON.parse(response.text);
  } catch (error) {
    console.error('分類処理でエラーが発生:', error.message);
    return { primaryCategory: "エラー", subCategory: "分類失敗", status: "未特定" };
  }
}

// ==========================================
// 3. 通話サーバー（WebSocket + STTストリーミング）
// ==========================================
const wss = new WebSocketServer({ port: 8080 });
console.log('通話受信サーバーを起動しました (ws://localhost:8080)');

wss.on('connection', (ws) => {
  console.log('📱 新しい通話が接続されました');
  
  let conversationBuffer = "";
  let isClassifying = false;

  // --------------------------------------------------
  // [A] Google Cloud STT ストリームの設定
  // --------------------------------------------------
  const request = {
    config: {
      encoding: 'MULAW',   // 音声フォーマット。電話(Twilio等)の場合は 'MULAW' に変更
      sampleRateHertz: 8000, // 電話の場合は 8000 に変更
      languageCode: 'ja-JP',
    },
    interimResults: true, // 途中経過のテキストも取得するかどうか
  };

  // リアルタイム認識用のストリームを作成
  const recognizeStream = sttClient
    .streamingRecognize(request)
    .on('error', (error) => {
      console.error('Google Cloud STT エラー:', error.message);
    })
    .on('data', async (data) => {
      // 認識結果が空でないかチェック
      if (data.results[0] && data.results[0].alternatives[0]) {
        const result = data.results[0];
        const transcript = result.alternatives[0].transcript;

        // isFinal が true の場合、文章の区切り（発言の確定）を意味する
        if (result.isFinal) {
          console.log(`🗣️ 確定テキスト: ${transcript}`);
          conversationBuffer += transcript + "\n";

          // AI分類の連続発火を防ぐ（処理中ならスキップ）
          if (!isClassifying) {
            isClassifying = true;
            const classResult = await classifyInquiry(conversationBuffer);
            console.log('📊 【リアルタイム分類結果】', classResult);
            isClassifying = false;
          }
        }
      }
    });

  // --------------------------------------------------
  // [B] 電話システムからの音声データ受信
  // --------------------------------------------------
  ws.on('message', (message) => {
    // 電話システムからWebSocket経由で届くJSONデータ（Twilioなどを想定）
    const data = JSON.parse(message.toString());

    if (data.event === 'media') {
      // 音声ペイロード(Base64)をバイナリBufferに変換し、Google STTに流し込む
      const audioPayload = Buffer.from(data.media.payload, 'base64');
      recognizeStream.write(audioPayload);
    }
  });

  ws.on('close', () => {
    console.log('📞 通話が終了しました');
    recognizeStream.end(); // STTの接続も閉じる
  });
});
