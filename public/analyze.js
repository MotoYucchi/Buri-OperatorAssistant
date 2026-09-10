import { WebSocketServer } from 'ws';
import speech from '@google-cloud/speech';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const sttClient = new speech.SpeechClient();

// 問い合わせ分類AI関数
async function classifyInquiry(conversationBuffer) {
  if (!conversationBuffer || conversationBuffer.trim() === '') return;

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
            },
            subCategory: { type: Type.STRING, description: '具体的な要約小分類' },
            status: { type: Type.STRING, enum: ["確定", "推測", "未特定"] }
          },
          required: ['primaryCategory', 'subCategory', 'status']
        }
      }
    });
    return JSON.parse(response.text);
  } catch (error) {
    console.error('分類エラー:', error.message);
  }
}

const wss = new WebSocketServer({ port: 8080 });
console.log('サーバー起動: ws://localhost:8080');

wss.on('connection', (ws) => {
  console.log('📱 ブラウザが接続されました');
  let conversationBuffer = "";
  let isClassifying = false;

  // ブラウザ（WebM/Opusフォーマット）用STT設定
  const request = {
    config: {
      encoding: 'WEBM_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'ja-JP',
    },
    interimResults: true,
  };

  const recognizeStream = sttClient
    .streamingRecognize(request)
    .on('error', (err) => console.error('STTエラー:', err))
    .on('data', async (data) => {
      if (data.results[0] && data.results[0].alternatives[0]) {
        const result = data.results[0];
        const transcript = result.alternatives[0].transcript;

        if (result.isFinal) {
          console.log(`\n🗣️ [確定]: ${transcript}`);
          conversationBuffer += transcript + "\n";

          if (!isClassifying) {
            isClassifying = true;
            console.log('🤖 AI判定中...');
            const classResult = await classifyInquiry(conversationBuffer);
            console.log('📊 [リアルタイム分類結果]:', classResult);
            isClassifying = false;
          }
        } else {
          process.stdout.write(`🎤 認識中: ${transcript}\r`);
        }
      }
    });

  // ブラウザからの音声バイナリパケットを受信してSTTへ転送
  ws.on('message', (chunk) => {
    recognizeStream.write(chunk);
  });

  ws.on('close', () => {
    console.log('📞 接続が切断されました');
    recognizeStream.end();
  });
});
