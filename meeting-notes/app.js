// 회의록 자동 생성기 — 클라이언트 로직
// MediaRecorder로 5분 단위 세그먼트 녹음 → 세그먼트 완료 즉시 파이프라이닝 시작 (fire-and-forget)
// → stopBtn 시점에 세션 코디네이터가 모든 파이프라인 대기 후 merge→summarize→finalize 진입

const MAX_CHUNK_SIZE = 3.5 * 1024 * 1024; // 3.5MB (Vercel 4.5MB 한도 여유)
const SEGMENT_SECONDS = 300; // 5분. 단일 Gemini 전사 호출이 60초 안에 끝나는 안전 기준치

// 파이프라인 재시도 파라미터. check-file 폴링은 본래 반복이라 별도(아래 POLL_*).
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 10000;
const POLL_MAX_ATTEMPTS = 60; // 최대 약 2분
const POLL_INTERVAL_MS = 2000;

// summarize만 별도 관용치. Gemini Pro가 "긴 입력 + structured output"에
// 503 UNAVAILABLE을 뱉는 빈도가 높음(WORK-LOG PR #9/#10 교훈). 서버 withRetry가
// 이미 3회 재시도하므로, 클라 1회 재시도 = 서버 3회 사이클. 충분한 간격으로
// 5번까지 재시도(최대 누적 대기 ~60s, Gemini demand spike 완화 기회).
// merge는 Gemini 비사용, finalize-notion은 Notion API라 503 무관 + 중복 페이지
// 생성 리스크 있으므로 기존 3회 유지.
const SUMMARIZE_RETRY_ATTEMPTS = 5;
const SUMMARIZE_RETRY_CAP_MS = 30000;

// 동시성 세마포어. 재시도/일시정지 버스트 시 Gemini/Vercel rate-limit 폭주 방지용.
// 정상 진행은 5분 간격이라 N=1이지만 버스트 상황에서 의미 있음.
const PREPARE_CONCURRENCY = 2;
const TRANSCRIBE_CONCURRENCY = 2;

const els = {
  recBtn: document.getElementById('recBtn'),
  recLabel: document.getElementById('recLabel'),
  recControls: document.getElementById('recControls'),
  pauseBtn: document.getElementById('pauseBtn'),
  pauseLabel: document.getElementById('pauseLabel'),
  stopBtn: document.getElementById('stopBtn'),
  status: document.getElementById('status'),
  timer: document.getElementById('timer'),
  hint: document.getElementById('hint'),
  recorder: document.getElementById('recorder'),
  processing: document.getElementById('processing'),
  processingText: document.getElementById('processingText'),
  segmentList: document.getElementById('segmentList'),
  result: document.getElementById('result'),
  resultLink: document.getElementById('resultLink'),
  resultTitle: document.getElementById('resultTitle'),
  newBtn: document.getElementById('newBtn'),
  error: document.getElementById('error'),
  errorText: document.getElementById('errorText'),
  retryBtn: document.getElementById('retryBtn'),
  meetingTitle: document.getElementById('meetingTitle'),
  meetingType: document.getElementById('meetingType'),
  viz: document.getElementById('viz'),
};

// 녹음 상태 머신.
//   idle: 대기 — recBtn("녹음 시작")만 노출
//   recording: 녹음 중 — controls(일시정지/종료) 노출
//   paused: 일시정지 — controls(재개/종료) 노출
let state = 'idle';
let mediaRecorder = null;
let stream = null;
let audioChunks = []; // 현재 세그먼트의 ondataavailable 청크
let startedAt = 0;
let accumulatedMs = 0;
let timerInterval = null;
let audioCtx = null;
let analyser = null;
let vizFrame = null;
let segments = []; // { index, blob } — onstop에서 push
let segmentIndex = 0;
let segmentTimeout = null;
let stopRequested = false;
let pauseRequested = false;
let recorderMimeType = '';
let recorderOpts = null;

// 세션 — 녹음 시작 시 생성, reset/finalize-done 시 파기.
// stale 완료가 새 세션 DOM을 오염시키지 않도록 모든 async가 session 참조를
// 비교해 펜싱. abortController로 진행 중 fetch/대기 즉시 중단.
let currentSession = null;

// ===== 유틸 =====

function fmtTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function showSection(name) {
  ['recorder', 'processing', 'result', 'error'].forEach((id) => {
    els[id].classList.toggle('hidden', id !== name);
  });
}

function setStatus(text, recording = false) {
  els.status.textContent = text;
  els.status.classList.toggle('recording', recording);
}

// 단순 카운트 세마포어. release가 없으면 acquire가 영원히 대기 가능 —
// 세션 내에서만 쓰이므로 세션 파기 시 함께 GC.
class Semaphore {
  constructor(n) {
    this.remaining = n;
    this.queue = [];
  }
  async acquire() {
    if (this.remaining > 0) {
      this.remaining--;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    if (this.queue.length) {
      this.queue.shift()();
    } else {
      this.remaining++;
    }
  }
}

// 세션 객체. 전역 currentSession과 동일한 참조라야 유효 — 비교로 stale 감지.
function createSession() {
  return {
    id: crypto.randomUUID(),
    abortController: new AbortController(),
    pipelines: new Map(), // segmentIndex → { status, error, uploadProgress, prepareResult }
    prepareSem: new Semaphore(PREPARE_CONCURRENCY),
    transcribeSem: new Semaphore(TRANSCRIBE_CONCURRENCY),
    // 'recording': 녹음 중 / 'awaiting': stopBtn 이후 세그먼트 완료 대기 /
    // 'merging' → 'summarizing' → 'finalizing' → 'done' / 'failed'
    phase: 'recording',
    durationSec: 0,
    totalSegments: 0,
    finalizationStarted: false,
    finalizeAttempt: null, // { next, max, backoffMs } — 재시도 대기 중일 때만
  };
}

// abort/online 모두에서 깨는 sleep. 백오프가 끝나지 않아도 'online' 이벤트로 즉시 재시도.
function waitWithSignals(ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      window.removeEventListener('online', onOnline);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      window.removeEventListener('online', onOnline);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const onOnline = () => done();
    const t = setTimeout(done, ms);
    window.addEventListener('online', onOnline, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

// 4xx는 즉시 throw, 5xx/network는 지수 백오프 재시도. AbortError는 그대로 전파.
// onAttempt(nextAttemptNumber, maxAttempts, backoffMs) — 다음 시도 직전(백오프 진입 시)
// 1회 호출. UI에서 "재시도 n/5" 표시 용도.
async function fetchWithRetry(url, opts, {
  session,
  label,
  maxAttempts = RETRY_MAX_ATTEMPTS,
  capMs = RETRY_CAP_MS,
  onAttempt,
}) {
  const signal = session.abortController.signal;
  let attempt = 0;
  let lastErr = null;
  while (attempt < maxAttempts) {
    if (session !== currentSession) {
      throw new DOMException('session stale', 'AbortError');
    }
    try {
      const res = await fetch(url, { ...opts, signal });
      if (res.ok) return res;
      if (res.status >= 500 && res.status < 600) {
        lastErr = new Error(`${label}: ${res.status} ${await res.text().catch(() => '')}`);
      } else {
        // 4xx는 재시도해도 같은 결과. 즉시 실패.
        throw new Error(`${label}: ${res.status} ${await res.text().catch(() => '')}`);
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
    attempt++;
    if (attempt < maxAttempts) {
      const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), capMs);
      onAttempt?.(attempt + 1, maxAttempts, backoff);
      await waitWithSignals(backoff, signal);
    }
  }
  throw lastErr || new Error(`${label}: retries exhausted`);
}

// ===== 녹음 플로우 =====

async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (e) {
    showError('마이크 권한이 필요합니다. 브라우저 권한 설정을 확인해주세요.');
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  drawVisualizer();

  const mimeOptions = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  recorderMimeType = mimeOptions.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  recorderOpts = recorderMimeType
    ? { mimeType: recorderMimeType, audioBitsPerSecond: 32000 }
    : { audioBitsPerSecond: 32000 };

  currentSession = createSession();
  segments = [];
  segmentIndex = 0;
  stopRequested = false;
  pauseRequested = false;
  accumulatedMs = 0;
  startedAt = Date.now();

  els.timer.textContent = '00:00';
  startTimer();

  state = 'recording';
  els.recBtn.classList.add('hidden');
  els.recControls.classList.remove('hidden');
  els.pauseLabel.textContent = '일시정지';
  setStatus('녹음 중', true);
  els.hint.textContent = `일시정지 시 다음 세그먼트로 이어집니다 (${SEGMENT_SECONDS / 60}분 단위로 분할 저장)`;

  startSegmentRecorder();
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    els.timer.textContent = fmtTime(elapsed);
  }, 500);
}

function startSegmentRecorder() {
  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream, recorderOpts);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    if (segmentTimeout) {
      clearTimeout(segmentTimeout);
      segmentTimeout = null;
    }
    if (audioChunks.length) {
      const blob = new Blob(audioChunks, { type: recorderMimeType || 'audio/webm' });
      const seg = { index: segmentIndex, blob };
      segments.push(seg);
      segmentIndex++;
      // fire-and-forget — 녹음/일시정지와 병행. 이 호출은 세션 .pipelines Map에
      // 엔트리를 동기적으로 등록하므로, 뒤따르는 finalizeRecording의 coordinatorCheck가
      // 마지막 세그먼트 누락 없이 totalSegments를 만족함.
      if (currentSession) startSegmentPipeline(seg, currentSession);
    }
    if (stopRequested) {
      finalizeRecording();
    } else if (pauseRequested) {
      pauseRequested = false;
      enterPausedState();
    } else {
      startSegmentRecorder();
    }
  };

  mediaRecorder.start(1000);

  segmentTimeout = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }, SEGMENT_SECONDS * 1000);
}

function stopRecording() {
  stopRequested = true;
  pauseRequested = false;
  if (segmentTimeout) {
    clearTimeout(segmentTimeout);
    segmentTimeout = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    finalizeRecording();
  }
}

function pauseRecording() {
  if (state !== 'recording') return;
  pauseRequested = true;
  if (segmentTimeout) {
    clearTimeout(segmentTimeout);
    segmentTimeout = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    enterPausedState();
  }
}

function enterPausedState() {
  state = 'paused';
  accumulatedMs = Date.now() - startedAt;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  setStatus('일시정지', false);
  els.pauseLabel.textContent = '재개';
  els.hint.textContent = '재개 버튼을 누르면 새 세그먼트로 이어집니다';
}

function resumeRecording() {
  if (state !== 'paused') return;
  startedAt = Date.now() - accumulatedMs;
  state = 'recording';
  startTimer();
  setStatus('녹음 중', true);
  els.pauseLabel.textContent = '일시정지';
  els.hint.textContent = `일시정지 시 다음 세그먼트로 이어집니다 (${SEGMENT_SECONDS / 60}분 단위로 분할 저장)`;
  startSegmentRecorder();
}

function finalizeRecording() {
  // paused 상태에서 종료 시 pause 구간은 실제 녹음 시간에서 제외.
  const durationMs = state === 'paused' ? accumulatedMs : (Date.now() - startedAt);

  stopVisualizer();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  state = 'idle';
  els.recBtn.classList.remove('hidden');
  els.recControls.classList.add('hidden');
  els.recLabel.textContent = '녹음 시작';
  els.pauseLabel.textContent = '일시정지';

  if (!segments.length) {
    showError('녹음된 오디오가 없습니다. 다시 시도해주세요.');
    if (currentSession) {
      currentSession.abortController.abort();
      currentSession = null;
    }
    return;
  }

  const session = currentSession;
  if (!session) return;
  session.phase = 'awaiting';
  session.durationSec = Math.floor(durationMs / 1000);
  session.totalSegments = segments.length;

  showSection('processing');
  renderPipelineStatus(session);
  coordinatorCheck(session);
}

// ===== 파이프라인 =====

function startSegmentPipeline(seg, session) {
  // 기존 엔트리가 있으면 덮어씀(재시도 경로).
  const pState = {
    status: 'uploading',
    error: null,
    uploadProgress: { done: 0, total: 0 },
    prepareResult: null,
  };
  session.pipelines.set(seg.index, pState);
  renderPipelineStatus(session);

  // fire-and-forget async 실행.
  (async () => {
    try {
      await uploadChunks(seg, pState, session);
      if (session !== currentSession) return;

      pState.status = 'preparing';
      renderPipelineStatus(session);
      await session.prepareSem.acquire();
      try {
        pState.prepareResult = await prepareSegment(seg, session);
      } finally {
        session.prepareSem.release();
      }
      if (session !== currentSession) return;

      pState.status = 'polling';
      renderPipelineStatus(session);
      const file = await pollFileActive(pState.prepareResult, session);
      if (session !== currentSession) return;

      pState.status = 'transcribing';
      renderPipelineStatus(session);
      await session.transcribeSem.acquire();
      try {
        await transcribeSegment(seg, file, session);
      } finally {
        session.transcribeSem.release();
      }
      if (session !== currentSession) return;

      pState.status = 'done';
      renderPipelineStatus(session);
      coordinatorCheck(session);
    } catch (err) {
      if (err.name === 'AbortError' || session !== currentSession) return;
      pState.status = 'failed';
      pState.error = err;
      renderPipelineStatus(session);
      coordinatorCheck(session);
    }
  })();
}

async function uploadChunks(seg, pState, session) {
  const total = Math.ceil(seg.blob.size / MAX_CHUNK_SIZE);
  pState.uploadProgress = { done: 0, total };
  renderPipelineStatus(session);

  for (let i = 0; i < total; i++) {
    const chunk = seg.blob.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
    await fetchWithRetry('/api/process-meeting', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Action': 'upload-chunk',
        'X-Session-Id': session.id,
        'X-Segment-Index': String(seg.index),
        'X-Chunk-Index': String(i),
        'X-Total-Chunks': String(total),
        'X-Mime-Type': seg.blob.type,
      },
      body: chunk,
    }, { session, label: `세그먼트 ${seg.index + 1} 업로드 #${i + 1}` });
    pState.uploadProgress.done = i + 1;
    renderPipelineStatus(session);
  }
}

async function prepareSegment(seg, session) {
  const res = await fetchWithRetry('/api/process-meeting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Action': 'prepare-segment' },
    body: JSON.stringify({
      sessionId: session.id,
      segmentIndex: seg.index,
      mimeType: seg.blob.type,
    }),
  }, { session, label: `세그먼트 ${seg.index + 1} 준비` });
  return res.json();
}

// 기존 60회 × 2초 폴링 유지. 각 check-file 호출에 지수 백오프 재시도.
async function pollFileActive(prepResult, session) {
  const signal = session.abortController.signal;
  let state = prepResult.state;
  let fileUri = prepResult.fileUri;
  let fileMimeType = prepResult.fileMimeType;
  for (let i = 0; i < POLL_MAX_ATTEMPTS && state === 'PROCESSING'; i++) {
    await waitWithSignals(POLL_INTERVAL_MS, signal);
    if (session !== currentSession) throw new DOMException('session stale', 'AbortError');
    const res = await fetchWithRetry('/api/process-meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Action': 'check-file' },
      body: JSON.stringify({ fileName: prepResult.fileName }),
    }, { session, label: 'check-file' });
    const data = await res.json();
    state = data.state;
    fileUri = data.fileUri || fileUri;
    fileMimeType = data.fileMimeType || fileMimeType;
  }
  if (state !== 'ACTIVE') throw new Error(`Gemini 상태: ${state}`);
  return { fileUri, fileMimeType };
}

async function transcribeSegment(seg, file, session) {
  await fetchWithRetry('/api/process-meeting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Action': 'transcribe-segment' },
    body: JSON.stringify({
      sessionId: session.id,
      segmentIndex: seg.index,
      fileUri: file.fileUri,
      fileMimeType: file.fileMimeType,
      totalSegments: session.totalSegments || segments.length, // stop 전에 호출되면 현재까지 기준
    }),
  }, { session, label: `세그먼트 ${seg.index + 1} 전사` });
}

// ===== 코디네이터 =====

// 파이프라인 상태 변경 / 재시도 시 호출. 모든 세그먼트 done이면 finalize 진입.
function coordinatorCheck(session) {
  if (session !== currentSession) return;
  if (session.phase !== 'awaiting') return;
  if (session.pipelines.size < session.totalSegments) return;
  if (session.finalizationStarted) return;

  const pipelines = [...session.pipelines.values()];
  const anyFailed = pipelines.some((p) => p.status === 'failed');
  if (anyFailed) return; // 사용자가 재시도 눌러야 진행
  const allDone = pipelines.every((p) => p.status === 'done');
  if (!allDone) return;

  session.finalizationStarted = true;
  runFinalization(session).catch((err) => {
    if (err.name === 'AbortError' || session !== currentSession) return;
    // processing 섹션에 머무르면서 '요약/저장 다시 시도' 버튼만 띄운다.
    // showError(=error 섹션)로 가면 사용자가 retryBtn→reset()을 눌러 이미 완료된
    // 세그먼트 전사 4개를 모두 버리게 되므로 여기서 finalize만 재진입.
    session.phase = 'failed';
    session.finalizationStarted = false;
    session.finalizationError = err;
    renderPipelineStatus(session);
  });
}

function retryFinalization() {
  const session = currentSession;
  if (!session || session.phase !== 'failed') return;
  session.phase = 'awaiting';
  session.finalizationError = null;
  session.finalizeAttempt = null;
  renderPipelineStatus(session);
  coordinatorCheck(session);
}

// summarize 단계 onAttempt — 재시도 상태를 session에 기록해 UI가 "재시도 n/5" 표시.
// 성공하거나 다른 단계로 넘어가면 호출자가 finalizeAttempt를 null로 리셋.
function onSummarizeAttempt(session) {
  return (next, max, backoffMs) => {
    if (session !== currentSession) return;
    session.finalizeAttempt = { next, max, backoffMs };
    renderPipelineStatus(session);
  };
}

async function runFinalization(session) {
  session.phase = 'merging';
  session.finalizeAttempt = null;
  renderPipelineStatus(session);
  await fetchWithRetry('/api/process-meeting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Action': 'merge-transcripts' },
    body: JSON.stringify({ sessionId: session.id, totalSegments: session.totalSegments }),
  }, { session, label: '전사문 병합' });
  if (session !== currentSession) return;

  session.phase = 'summarizing';
  session.finalizeAttempt = null;
  renderPipelineStatus(session);
  await fetchWithRetry('/api/process-meeting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Action': 'summarize' },
    body: JSON.stringify({
      sessionId: session.id,
      title: els.meetingTitle.value || null,
      meetingType: els.meetingType.value || null,
      durationSec: session.durationSec,
    }),
  }, {
    session,
    label: '요약',
    maxAttempts: SUMMARIZE_RETRY_ATTEMPTS,
    capMs: SUMMARIZE_RETRY_CAP_MS,
    onAttempt: onSummarizeAttempt(session),
  });
  if (session !== currentSession) return;

  session.phase = 'finalizing';
  session.finalizeAttempt = null;
  renderPipelineStatus(session);
  const res = await fetchWithRetry('/api/process-meeting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Action': 'finalize-notion' },
    body: JSON.stringify({ sessionId: session.id }),
  }, { session, label: 'Notion 저장' });
  if (session !== currentSession) return;

  const data = await res.json();
  session.phase = 'done';
  session.finalizeAttempt = null;
  showResult(data);
}

function retrySegment(index) {
  const session = currentSession;
  if (!session) return;
  const seg = segments.find((s) => s.index === index);
  if (!seg) return;
  const pState = session.pipelines.get(index);
  if (!pState || pState.status !== 'failed') return;
  startSegmentPipeline(seg, session);
}

// ===== UI 렌더 =====

function renderPipelineStatus(session) {
  if (session !== currentSession) return;
  if (!els.segmentList) return;

  // 세그먼트 인덱스 기준 정렬 (Map 삽입 순서가 아니라).
  const items = [];
  for (const [idx, p] of session.pipelines.entries()) items.push({ idx, ...p });
  items.sort((a, b) => a.idx - b.idx);

  els.segmentList.innerHTML = '';
  for (const p of items) {
    const li = document.createElement('li');
    li.dataset.seg = String(p.idx);
    li.className = 'seg-item';
    if (p.status === 'failed') li.classList.add('failed');
    if (p.status === 'done') li.classList.add('done');

    const label = document.createElement('span');
    label.className = 'seg-label';
    label.textContent = `세그먼트 ${p.idx + 1}/${session.totalSegments || '?'}`;
    li.appendChild(label);

    const status = document.createElement('span');
    status.className = 'seg-status';
    status.textContent = segmentStatusText(p);
    li.appendChild(status);

    if (p.status === 'failed') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg-retry';
      btn.textContent = '재시도';
      btn.addEventListener('click', () => retrySegment(p.idx));
      li.appendChild(btn);
    }
    els.segmentList.appendChild(li);
  }

  // 상단 단일 상태 라인
  els.processingText.textContent = phaseText(session, items);
  renderFinalizeRetry(session);
}

function renderFinalizeRetry(session) {
  let btn = document.getElementById('finalizeRetryBtn');
  if (session.phase === 'failed') {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'finalizeRetryBtn';
      btn.type = 'button';
      btn.className = 'finalize-retry';
      btn.textContent = '요약/저장 다시 시도';
      btn.addEventListener('click', retryFinalization);
      els.processing.appendChild(btn);
    }
  } else if (btn) {
    btn.remove();
  }
}

function segmentStatusText(p) {
  switch (p.status) {
    case 'uploading': return `업로드 ${p.uploadProgress.done}/${p.uploadProgress.total || '?'}`;
    case 'preparing': return '준비 중';
    case 'polling': return 'AI 대기 중';
    case 'transcribing': return '전사 중';
    case 'done': return '완료';
    case 'failed': return p.error?.message || '실패';
    default: return p.status;
  }
}

function phaseText(session, items) {
  const a = session.finalizeAttempt;
  const retrySuffix = a ? ` (AI 과부하로 재시도 ${a.next}/${a.max})` : '';
  if (session.phase === 'merging') return '전사문 병합 중...';
  if (session.phase === 'summarizing') return `회의록 요약 중...${retrySuffix}`;
  if (session.phase === 'finalizing') return 'Notion에 저장 중...';
  if (session.phase === 'failed') {
    const msg = session.finalizationError?.message || '오류';
    return `요약/저장 실패 — 아래 버튼으로 다시 시도 (${summarizeFinalizeError(msg)})`;
  }
  if (session.phase === 'awaiting') {
    const failed = items.filter((p) => p.status === 'failed').length;
    if (failed) return `세그먼트 ${failed}개 실패 — 재시도 버튼을 눌러주세요`;
    const done = items.filter((p) => p.status === 'done').length;
    return `세그먼트 처리 중 (${done}/${session.totalSegments})`;
  }
  return '처리 중...';
}

// 서버 오류 메시지에서 사용자에게 보일 만한 핵심만 추출. JSON 덩어리는 숨김.
function summarizeFinalizeError(raw) {
  if (!raw) return '오류';
  const geminiMatch = raw.match(/"message":"([^"]+)"/);
  if (geminiMatch) return geminiMatch[1].slice(0, 120);
  const firstLine = raw.split('\n')[0];
  return firstLine.slice(0, 120);
}

// ===== 시각화 =====

function drawVisualizer() {
  const canvas = els.viz;
  const ctx = canvas.getContext('2d');
  const buffer = new Uint8Array(analyser.frequencyBinCount);

  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);

  function draw() {
    vizFrame = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(buffer);
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    ctx.clearRect(0, 0, w, h);

    const barCount = 32;
    const step = Math.floor(buffer.length / barCount);
    const barWidth = w / barCount - 2;
    for (let i = 0; i < barCount; i++) {
      const value = buffer[i * step] / 255;
      const barHeight = Math.max(2, value * h * 0.9);
      ctx.fillStyle = `rgba(124,106,239,${0.3 + value * 0.5})`;
      ctx.fillRect(i * (barWidth + 2), (h - barHeight) / 2, barWidth, barHeight);
    }
  }
  draw();
}

function stopVisualizer() {
  if (vizFrame) cancelAnimationFrame(vizFrame);
}

// ===== 결과/에러/리셋 =====

function showResult(data) {
  showSection('result');
  els.resultTitle.textContent = data.title || '회의록이 생성되었습니다';
  els.resultLink.href = data.notionUrl;
}

function showError(msg) {
  showSection('error');
  els.errorText.textContent = msg;
}

function reset() {
  // 진행 중 파이프라인/재시도 모두 중단. stale 완료가 새 DOM을 건드리지 않도록
  // currentSession 참조를 null로 바꿔 펜싱.
  if (currentSession) {
    currentSession.abortController.abort();
    currentSession = null;
  }
  segments = [];
  segmentIndex = 0;

  els.meetingTitle.value = '';
  els.meetingType.value = '';
  els.timer.textContent = '00:00';
  if (els.segmentList) els.segmentList.innerHTML = '';
  const finalizeBtn = document.getElementById('finalizeRetryBtn');
  if (finalizeBtn) finalizeBtn.remove();
  els.processingText.textContent = '처리 중...';
  state = 'idle';
  els.recBtn.classList.remove('hidden', 'recording');
  els.recLabel.textContent = '녹음 시작';
  els.recControls.classList.add('hidden');
  els.pauseLabel.textContent = '일시정지';
  setStatus('대기 중', false);
  els.hint.textContent = '시작 버튼을 누르면 마이크 권한을 요청합니다';
  showSection('recorder');
}

// ===== 이벤트 바인딩 =====

els.recBtn.addEventListener('click', () => {
  if (state === 'idle') startRecording();
});

els.pauseBtn.addEventListener('click', () => {
  if (state === 'recording') pauseRecording();
  else if (state === 'paused') resumeRecording();
});

els.stopBtn.addEventListener('click', () => {
  if (state === 'recording' || state === 'paused') stopRecording();
});

els.newBtn.addEventListener('click', reset);
els.retryBtn.addEventListener('click', reset);

// 미완료 파이프라인 있을 때 탭 닫기/새로고침 경고.
window.addEventListener('beforeunload', (e) => {
  if (!currentSession) return;
  if (currentSession.phase === 'done' || currentSession.phase === 'failed') return;
  e.preventDefault();
  e.returnValue = '';
});

// 화면 잠금 방지 (가능한 경우)
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      await navigator.wakeLock.request('screen');
    } catch (e) {
      // 무시
    }
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});
requestWakeLock();
