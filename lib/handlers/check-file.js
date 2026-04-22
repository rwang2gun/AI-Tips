import { createGeminiClient } from '../clients/gemini.js';
import { readJsonBody, jsonResponse } from '../http/body-parser.js';

// Gemini 파일 처리 상태 확인 (클라이언트가 폴링)
export default async function handleCheckFile(req, res) {
  const body = await readJsonBody(req);
  const { fileName } = body;

  if (!fileName || typeof fileName !== 'string' || !fileName.startsWith('files/')) {
    return jsonResponse(res, 400, { error: 'Invalid fileName' });
  }

  const genAI = createGeminiClient();
  const fileInfo = await genAI.files.get({ name: fileName });

  return jsonResponse(res, 200, {
    ok: true,
    state: fileInfo.state,
    fileUri: fileInfo.uri,
    fileMimeType: fileInfo.mimeType,
  });
}
