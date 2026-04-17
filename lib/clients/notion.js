// NotionClient 팩토리. fetchGlossary / fetchSynonyms / fetchGuide / createNotionPage 등이 공유.
//
// 동적 import 사용 — 순수 유틸 모듈(예: 힌트 빌더)을 테스트할 때
// @notionhq/client 미설치 환경에서도 import 그래프가 깨지지 않도록 분리.

export async function createNotionClient({ token = process.env.NOTION_TOKEN } = {}) {
  if (!token) {
    throw new Error('NOTION_TOKEN is not set');
  }
  const { Client } = await import('@notionhq/client');
  return new Client({ auth: token });
}
