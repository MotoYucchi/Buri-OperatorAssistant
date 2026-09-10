import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * 通話バッファから問い合わせ種別をリアルタイム抽出
 * @param {string} conversationBuffer 直近の通話テキスト履歴
 */
export async function classifyInquiry(conversationBuffer) {
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
            description: '製品仕様・操作, 料金・請求, 契約変更・手続き, 故障・不具合, 解約・キャンセル, その他のいずれか'
          },
          subCategory: {
            type: Type.STRING,
            description: 'より具体的に要約した問い合わせの小分類（例：パスワード忘れ、解約方法の確認）'
          },
          status: {
            type: Type.STRING,
            description: '確定, 推測, 未特定のいずれか'
          }
        },
        required: ['primaryCategory', 'subCategory', 'status']
      }
    }
  });

  return JSON.parse(response.text);
}
