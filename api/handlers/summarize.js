import { createUserContent } from '@google/genai';
import { meetingSchema } from '../../lib/schemas/meeting.js';
import { buildSummarizePrompt, buildRefineTopicPrompt } from '../../lib/prompts/summarize.js';
import { fetchGlossary } from '../../lib/glossary.js';
import { fetchGuide } from '../../lib/guide.js';
import { createGeminiClient } from '../../lib/clients/gemini.js';
import { putPublic, fetchBlobText } from '../../lib/clients/blob.js';
import { readJsonBody, jsonResponse } from '../../lib/http/body-parser.js';
import { withRetry } from '../../lib/http/retry.js';

// 전사문 → 구조화 JSON 요약
export default async function handleSummarize(req, res) {
  const body = await readJsonBody(req);
  const { sessionId, title, meetingType, durationSec } = body;

  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonResponse(res, 400, { error: 'Invalid session id' });
  }

  // Blob에서 전사문 가져오기
  const transcript = await fetchBlobText(`meetings/${sessionId}/transcript.txt`);
  if (transcript == null) {
    return jsonResponse(res, 400, { error: 'No transcript found — run transcribe first' });
  }
  if (!transcript.trim()) {
    return jsonResponse(res, 400, { error: 'Empty transcript' });
  }

  // Notion 용어집 + 작성 가이드 조회 (가이드 없으면 빈 문자열로 프롬프트에서 생략됨)
  // header는 기존 api 프롬프트에 사용되던 문구 그대로 유지.
  const glossaryText = await fetchGlossary({
    header: '[용어집 — 아래 용어가 음성에서 들리면 정확한 표기를 사용하세요]',
  });
  const guideText = await fetchGuide();

  const genAI = createGeminiClient();
  const today = new Date().toISOString().slice(0, 10);
  const meetingMeta = {
    requestedTitle: title,
    requestedMeetingType: meetingType,
    durationSec,
    date: today,
  };

  const promptText = buildSummarizePrompt({
    meetingMeta,
    transcript,
    glossaryText,
    guideText,
  });

  // Pro: 긴 transcript + responseSchema 조합에서 Flash는 503 지속 반환 (WORK-LOG 교훈 #3).
  // PR #10은 로컬만 Pro로 전환했고 서버엔 미적용이었음 — 2026-04-18 실전 503으로 재확인.
  const result = await withRetry(() =>
    genAI.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [createUserContent([promptText])],
      config: {
        responseMimeType: 'application/json',
        responseSchema: meetingSchema(),
      },
    })
  );

  const meetingData = JSON.parse(result.text);

  // topic이 50자 초과면 한 번 더 짧게 압축. 입력이 작아 빠르고 503 위험 적음.
  // 실패 시 1차 topic 유지 (요약 자체는 이미 성공).
  if (meetingData.topic && meetingData.topic.length > 50) {
    try {
      const refined = await withRetry(() => refineTopic(genAI, meetingData));
      if (refined && refined.length > 0 && refined.length < meetingData.topic.length) {
        console.log(`[refine-topic] ${meetingData.topic.length} → ${refined.length} chars`);
        meetingData.topic = refined;
      }
    } catch (e) {
      console.warn('[refine-topic] failed (1차 topic 유지):', e?.message);
    }
  }

  // 결과 JSON을 Blob에 저장 (다음 단계 finalize-notion에서 읽음)
  const payload = { meetingData, date: today };
  await putPublic(`meetings/${sessionId}/result.json`, JSON.stringify(payload), {
    contentType: 'application/json',
  });

  return jsonResponse(res, 200, {
    ok: true,
    title: meetingData.title,
  });
}

// 1차 요약 topic이 50자 초과일 때 한 번 더 짧게 압축.
// 입력은 title + 1차 topic + agenda 제목들로 매우 작아서 빠르게 끝남.
async function refineTopic(genAI, meetingData) {
  const prompt = buildRefineTopicPrompt({ meetingData });

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: [createUserContent([prompt])],
    config: { maxOutputTokens: 256 },
  });

  let text = (result.text || '').trim();
  text = text.split('\n')[0].trim();
  text = text.replace(/^["'`「『\[(](.*)["'`」』\])]$/s, '$1').trim();
  text = text.replace(/^[Tt]opic\s*[:：]\s*/, '').trim();
  return text;
}
