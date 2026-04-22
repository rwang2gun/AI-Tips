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

// transcript-NN.txt 본 파일만 골라 인덱스 기준으로 정렬.
// raw.txt / meta.json sidecar는 제외 (파일명 끝이 ".txt"이지만 ".raw.txt"는 거름).
// 인덱스는 100+ 세그먼트도 지원해야 해 `\d+` 허용 후 숫자 비교로 정렬 —
// localeCompare는 "transcript-10.txt" < "transcript-2.txt"를 반환하므로 못 씀.
// 입력: [{ pathname, ... }]
export function selectSegmentTranscriptBlobs(blobs) {
  const pattern = /\/transcript-(\d+)\.txt$/;
  return blobs
    .map((b) => {
      const m = b.pathname.match(pattern);
      if (!m) return null;
      // .raw.txt 는 /\/transcript-\d+\.raw\.txt$/ 이므로 위 pattern에 매칭 안 됨 (".raw.txt"의 ".raw" 덕분). 안전.
      return { ...b, _segIndex: Number(m[1]) };
    })
    .filter(Boolean)
    .sort((a, b) => a._segIndex - b._segIndex)
    .map(({ _segIndex, ...rest }) => rest);
}
