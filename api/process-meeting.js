// ============================================================
// 회의록 자동 생성 — 서버리스 함수
// ============================================================
//
// [흐름 — segment 기반 파이프라인]
//   클라이언트(meeting-notes/app.js)가 5분 단위로 녹음을 분할하여
//   segment 하나당 독립 webm 파일을 만들고 다음 액션들을 호출:
//
//   세그먼트별 (S = 세그먼트 인덱스):
//     1. upload-chunk         (X-Segment-Index: S)
//        → 세그먼트 S의 오디오 청크(3.5MB 이하)를
//          meetings/<sid>/seg-NN/chunk-NNNN.bin 로 저장
//     2. prepare-segment      ({ sessionId, segmentIndex: S, mimeType })
//        → 세그먼트 S의 청크 결합 → Gemini Files API 업로드
//        → 파일 URI 반환 (ACTIVE 대기는 클라이언트에서 폴링)
//     3. check-file           (Gemini 파일 ACTIVE 상태 폴링)
//     4. transcribe-segment   ({ sessionId, segmentIndex: S, fileUri, ... })
//        → 세그먼트 S 한국어 전사 → meetings/<sid>/transcript-NN.txt
//
//   모든 세그먼트 처리 후:
//     5. merge-transcripts    ({ sessionId, totalSegments })
//        → transcript-NN.txt 전체를 시간순 정렬·결합 → transcript.txt
//     6. summarize            (전사문 → 구조화 JSON → result.json)
//     7. finalize-notion      (Notion 페이지 생성 + 세션 폴더 정리)
//
// [세그먼트 분할 이유]
//   Vercel Hobby 함수 60초 한도 내에서 긴 회의를 처리하려면 단일 Gemini
//   호출의 입력 오디오 길이를 짧게 유지해야 함. 30분 이상 단일 오디오는
//   transcribe 호출이 60초 초과 + Flash가 긴 단일 오디오에서 generation
//   loop(같은 문장 반복) 일으킴. 5분이 실전 안정 기준치.
//   ※ Gemini Files API의 videoMetadata.startOffset/endOffset은 audio에
//     silently ignored — 서버단 가상 분할 불가, 클라이언트단 실제 분할 필요.
//
// [legacy 액션]
//   prepare / transcribe (단일 파일 처리)는 meeting-notes/recover.html의
//   기존 실패 세션(seg-NN 폴더 없는 경우) 복구용으로 보존. 신규 녹음은
//   항상 segment 경로를 사용함.
//
// [핵심 설계 결정]
//   - 청크 3.5MB 분할: Vercel Hobby 4.5MB 본문 한도 때문
//   - Gemini Files API: 큰 오디오를 업로드 후 URI로 참조
//   - responseSchema: JSON 구조를 강제해서 안정적 파싱
//   - 용어집(fetchGlossary): Notion DB에서 활성 용어 조회 → 프롬프트에 삽입
//     → Notion에서 용어 추가/편집하면 코드 수정 없이 즉시 반영
//
// [Notion DB 정보]
//   - 자동 회의록 DB (NOTION_DATABASE_ID)
//     속성: 이름(title), 회의 날짜(date), 회의 유형(select),
//           레이블(multi_select: 전투/시스템/밸런스/UI),
//           참석자(person, 수동), 회의록 작성자(person, 수동)
//     페이지 서식: 기본 정보 / 후속 진행 업무 / 아젠다 / 논의 사항 / 결정 사항 / To-do
//   - 용어집 DB (NOTION_GLOSSARY_DB_ID)
//     속성: 용어(title), 설명(text), 카테고리(select), 활성(checkbox)
//
// [Enterprise 전환 시 변경 포인트]
//   - Gemini → Claude API (오디오 직접 입력 지원)
//   - Notion API 직접 호출 → MCP 커넥터로 대체
//   - Vercel Blob → 불필요 (서버리스 자체가 불필요할 수 있음)
//   - fetchGlossary() → Claude가 MCP로 용어집 DB 직접 조회
//   - buildBlocks() → MCP가 Notion 마크다운으로 직접 생성
//
// [환경변수]
//   GEMINI_API_KEY          — Google AI Studio에서 발급
//   NOTION_TOKEN            — Notion Integration 토큰
//   NOTION_DATABASE_ID      — 자동 회의록 DB ID
//   NOTION_GLOSSARY_DB_ID   — 용어집 DB ID
//   BLOB_READ_WRITE_TOKEN   — Vercel Blob 활성화 시 자동 등록
// ============================================================

import { createUserContent, createPartFromUri } from '@google/genai';
import { meetingSchema } from '../lib/schemas/meeting.js';
import {
  buildLegacyTranscribePrompt,
  buildSegmentTranscribePrompt,
} from '../lib/prompts/transcribe.js';
import { buildSummarizePrompt, buildRefineTopicPrompt } from '../lib/prompts/summarize.js';
import { fetchGlossary } from '../lib/glossary.js';
import { fetchGuide } from '../lib/guide.js';
import { createGeminiClient } from '../lib/clients/gemini.js';
import { createNotionClient } from '../lib/clients/notion.js';
import {
  putPublic,
  list,
  fetchBlobText,
  fetchBlobJson,
  findBlob,
  deleteByPrefix,
} from '../lib/clients/blob.js';
import {
  concatBlobChunks,
  mergeSegmentTranscripts,
  selectSegmentTranscriptBlobs,
} from '../lib/audio/chunking.js';
import {
  uploadFileToNotion,
  buildTranscriptFilename,
} from '../lib/notion/file-upload.js';
import { buildMeetingPageBlocks } from '../lib/notion/page-builder.js';
import { readJsonBody, jsonResponse } from '../lib/http/body-parser.js';
import { withRetry } from '../lib/http/retry.js';
import handleUploadChunk from './handlers/upload-chunk.js';
import handleCheckFile from './handlers/check-file.js';
import handlePrepareSegment from './handlers/prepare-segment.js';
import handleTranscribeSegment from './handlers/transcribe-segment.js';
import handleMergeTranscripts from './handlers/merge-transcripts.js';
import handleSummarize from './handlers/summarize.js';
import handleFinalizeNotion from './handlers/finalize-notion.js';
import handlePrepare from './handlers/legacy/prepare.js';
import handleTranscribe from './handlers/legacy/transcribe.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

// ------- 메인 핸들러 -------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return jsonResponse(res, 405, { error: 'Method not allowed' });
  }

  const action = req.headers['x-action'];

  try {
    if (action === 'upload-chunk') {
      return await handleUploadChunk(req, res);
    }
    if (action === 'prepare-segment') {
      return await handlePrepareSegment(req, res);
    }
    if (action === 'transcribe-segment') {
      return await handleTranscribeSegment(req, res);
    }
    if (action === 'merge-transcripts') {
      return await handleMergeTranscripts(req, res);
    }
    if (action === 'check-file') {
      return await handleCheckFile(req, res);
    }
    if (action === 'summarize') {
      return await handleSummarize(req, res);
    }
    if (action === 'finalize-notion') {
      return await handleFinalizeNotion(req, res);
    }
    // legacy — recover.html에서 단일 파일 세션 복구 시 사용
    if (action === 'prepare') {
      return await handlePrepare(req, res);
    }
    if (action === 'transcribe') {
      return await handleTranscribe(req, res);
    }
    return jsonResponse(res, 400, { error: 'Unknown X-Action' });
  } catch (err) {
    console.error('[process-meeting] error:', err);
    return jsonResponse(res, 500, {
      error: err?.message || 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined,
    });
  }
}

