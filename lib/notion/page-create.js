// 회의록 DB에 단일 페이지를 만드는 엔드투엔드 헬퍼 (api/scripts 공통).
//
// properties (이름/회의 날짜/회의 유형/레이블) 구성과 children 블록 생성은
// api/handlers/finalize-notion.js 와 scripts/upload-to-notion.js 양쪽에서
// 100% 동일했다. 단일 진입점으로 통합해 DB 스키마 변경 시 수정 포인트를
// 한 곳으로 좁힌다.
//
// notion 인스턴스와 databaseId 는 호출부가 주입 — 클라이언트 생성을 lib/notion/*
// 안에서 하지 않는다는 경계 규칙 유지.
import { buildMeetingPageBlocks } from './page-builder.js';

export async function createMeetingNotionPage({
  notion,
  databaseId,
  meetingData,
  date,
  transcriptUpload = null,
}) {
  const properties = {
    '이름': { title: [{ text: { content: meetingData.title } }] },
    '회의 날짜': { date: { start: date } },
    '회의 유형': { select: { name: meetingData.meetingType } },
  };
  if (meetingData.labels?.length) {
    properties['레이블'] = { multi_select: meetingData.labels.map((name) => ({ name })) };
  }

  const children = buildMeetingPageBlocks(meetingData, transcriptUpload);

  return notion.pages.create({
    parent: { database_id: databaseId },
    properties,
    children,
  });
}
