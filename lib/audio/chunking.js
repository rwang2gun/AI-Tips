// 오디오/전사문 결합 유틸. 순수 함수 위주.
// blob 모듈을 직접 import하지 않음 — 호출자가 list/fetch 결과를 넘겨줌.

const SEGMENT_MINUTES = 5;

// 정렬된 blob 리스트에서 binary 본문을 받아 단일 Buffer로 결합.
// blobs: [{ url, pathname, ... }] (Vercel Blob list() 결과)
// fetcher: (url) => Promise<Buffer> (테스트에서 mock 가능)
export async function concatBlobChunks(
  blobs,
  fetcher = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
) {
  const sorted = [...blobs].sort((a, b) => a.pathname.localeCompare(b.pathname));
  const buffers = await Promise.all(sorted.map((b) => fetcher(b.url)));
  return Buffer.concat(buffers);
}

// segment transcript blob 들을 시간 마커와 함께 결합.
// 입력: [{ url, pathname }] (transcript-NN.txt blobs, 정렬되어 있어야 함)
// fetcher: (url) => Promise<string>
// 반환: 합쳐진 텍스트
export async function mergeSegmentTranscripts(
  segmentBlobs,
  fetcher = async (url) => (await (await fetch(url)).text()),
) {
  const parts = await Promise.all(
    segmentBlobs.map(async (b, i) => {
      const text = (await fetcher(b.url)).trim();
      const startMin = i * SEGMENT_MINUTES;
      const endMin = startMin + SEGMENT_MINUTES;
      return `--- [${startMin}:00 ~ ${endMin}:00] ---\n${text}`;
    }),
  );
  return parts.join('\n\n');
}

// transcript-NN.txt 패턴(N=2자리 숫자)만 골라 정렬.
// 입력: [{ pathname, ... }]
// 반환: 같은 형태, 필터+정렬된 배열
export function selectSegmentTranscriptBlobs(blobs) {
  return blobs
    .filter((b) => /\/transcript-\d{2}\.txt$/.test(b.pathname))
    .sort((a, b) => a.pathname.localeCompare(b.pathname));
}
