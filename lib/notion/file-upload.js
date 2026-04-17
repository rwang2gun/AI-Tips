// Notion File Upload API (single_part 모드).
// Notion SDK 2.3.0은 file_upload 엔드포인트를 아직 감싸지 않아 fetch로 직접 호출.
// 실패 시 throw — 호출자가 catch해서 첨부 없이 진행할지 결정.

const NOTION_VERSION = '2022-06-28';

// 전사 원문 파일명 생성. api/scripts 공통 로직.
// 형식: 전사원문_{YYYY-MM-DD}_{safeTitle}.txt
export function buildTranscriptFilename(title, date) {
  const safe = (title || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return `전사원문_${date}_${safe}.txt`;
}

// Notion 파일 업로드 (create + send). 반환값: file_upload id (block에서 참조).
// body 는 string | Buffer | ArrayBuffer. contentType 지정 가능.
// blobContentType 은 multipart 전송 시 Blob 의 type 으로 사용 (생략하면 contentType 재사용).
// api 경로는 과거에 `text/plain;charset=utf-8` 을, 로컬 경로는 `text/plain` 을 사용해 왔으므로
// 호출자가 명시해 기존 동작을 보존할 수 있도록 분리된 옵션으로 노출.
export async function uploadFileToNotion({
  body,
  filename,
  contentType = 'text/plain',
  blobContentType,
  token = process.env.NOTION_TOKEN,
} = {}) {
  if (!token) throw new Error('NOTION_TOKEN is not set');
  if (!filename) throw new Error('filename required');
  if (body == null) throw new Error('body required');

  // Step 1: create
  const createResp = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mode: 'single_part',
      filename,
      content_type: contentType,
    }),
  });
  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`Notion file_upload create failed (HTTP ${createResp.status}): ${errText.slice(0, 300)}`);
  }
  const createData = await createResp.json();

  // Step 2: send (multipart)
  const form = new FormData();
  const blobType = blobContentType || contentType;
  form.append('file', new Blob([body], { type: blobType }), filename);

  const sendUrl = createData.upload_url || `https://api.notion.com/v1/file_uploads/${createData.id}/send`;
  const sendResp = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      // Content-Type은 FormData가 boundary 포함해서 자동 설정
    },
    body: form,
  });
  if (!sendResp.ok) {
    const errText = await sendResp.text();
    throw new Error(`Notion file_upload send failed (HTTP ${sendResp.status}): ${errText.slice(0, 300)}`);
  }

  return createData.id;
}
