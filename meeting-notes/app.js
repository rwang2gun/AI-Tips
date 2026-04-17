// 회의록 자동 생성기 — 클라이언트 로직
// MediaRecorder로 5분 단위 세그먼트 녹음 → 세그먼트별 처리 → /api/process-meeting

const MAX_CHUNK_SIZE = 3.5 * 1024 * 1024; // 3.5MB (Vercel 4.5MB 한도 여유)
const SEGMENT_SECONDS = 300; // 5분. 단일 Gemini 전사 호출이 60초 안에 끝나는 안전 기준치

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
//   paused: 일시정지 — controls(재개/종료) 노출. 타이머/세그먼트 타임아웃 정지,
//           다음 세그먼트는 segmentIndex++ 된 상태로 시작되어 번호가 이어짐.
let state = 'idle';
let mediaRecorder = null;
let stream = null;
let audioChunks = []; // 현재 세그먼트의 ondataavailable 청크
let startedAt = 0; // 녹음된 총 시간 = Date.now() - startedAt. pause 재개 시 shift 보정.
let accumulatedMs = 0; // pause 시점까지 누적된 녹음 시간 (재개 시 startedAt 보정용)
let timerInterval = null;
let audioCtx = null;
let analyser = null;
let vizFrame = null;
let segments = []; // { index, blob } 누적 — 세그먼트 종료 시점마다 하나씩 추가
let segmentIndex = 0;
let segmentTimeout = null;
let stopRequested = false; // 사용자 종료 요청 플래그
let pauseRequested = false; // 사용자 일시정지 요청 플래그
let recorderMimeType = '';
let recorderOpts = null;

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

  // 시각화 준비
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  drawVisualizer();

  // MediaRecorder 옵션 (모든 세그먼트 공통)
  const mimeOptions = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  recorderMimeType = mimeOptions.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  recorderOpts = recorderMimeType
    ? { mimeType: recorderMimeType, audioBitsPerSecond: 32000 }
    : { audioBitsPerSecond: 32000 };

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

// 세그먼트 하나를 녹음. 자동 stop 후 다음 세그먼트 시작 또는 finalize 진입.
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
      segments.push({ index: segmentIndex, blob });
      segmentIndex++;
    }
    if (stopRequested) {
      finalizeRecording();
    } else if (pauseRequested) {
      pauseRequested = false;
      enterPausedState();
    } else {
      // 다음 세그먼트 즉시 시작 (stop/start 사이 수십~수백ms 음성 누락 가능 — 5분 세그먼트에선 허용 범위)
      startSegmentRecorder();
    }
  };

  mediaRecorder.start(1000); // 1초마다 데이터 fire

  // SEGMENT_SECONDS 후 자동 stop → onstop이 다음 세그먼트 트리거
  segmentTimeout = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }, SEGMENT_SECONDS * 1000);
}

function stopRecording() {
  stopRequested = true;
  pauseRequested = false; // stop이 pause보다 우선
  if (segmentTimeout) {
    clearTimeout(segmentTimeout);
    segmentTimeout = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // onstop → finalizeRecording()
  } else {
    // paused 상태에서 녹음 종료: mediaRecorder는 이미 inactive, segments에 저장된 내용으로 finalize.
    finalizeRecording();
  }
}

// 일시정지: 현재 세그먼트 stop 후 paused 상태 진입. 재개 시 segmentIndex++ 덕에 새 세그먼트 번호로 이어짐.
function pauseRecording() {
  if (state !== 'recording') return;
  pauseRequested = true;
  if (segmentTimeout) {
    clearTimeout(segmentTimeout);
    segmentTimeout = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // onstop → enterPausedState()
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
  // startedAt을 pause 구간만큼 미래로 시프트 → elapsed 계산이 누적 녹음 시간을 유지.
  startedAt = Date.now() - accumulatedMs;
  state = 'recording';
  startTimer();
  setStatus('녹음 중', true);
  els.pauseLabel.textContent = '일시정지';
  els.hint.textContent = `일시정지 시 다음 세그먼트로 이어집니다 (${SEGMENT_SECONDS / 60}분 단위로 분할 저장)`;
  startSegmentRecorder();
}

function finalizeRecording() {
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
    return;
  }

  processMeeting(segments);
}

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

async function processMeeting(segs) {
  showSection('processing');

  const sessionId = crypto.randomUUID();
  const totalSegments = segs.length;

  try {
    // 세그먼트별 파이프라인: upload → prepare-segment → poll → transcribe-segment
    for (const seg of segs) {
      const segLabel = `${seg.index + 1}/${totalSegments}`;

      // 1) 청크 분할 업로드 (segment 단위 폴더)
      const totalChunks = Math.ceil(seg.blob.size / MAX_CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = seg.blob.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
        els.processingText.textContent = `세그먼트 ${segLabel} 업로드 (${i + 1}/${totalChunks})...`;

        const res = await fetch('/api/process-meeting', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Action': 'upload-chunk',
            'X-Session-Id': sessionId,
            'X-Segment-Index': String(seg.index),
            'X-Chunk-Index': String(i),
            'X-Total-Chunks': String(totalChunks),
            'X-Mime-Type': seg.blob.type,
          },
          body: chunk,
        });

        if (!res.ok) {
          throw new Error(`업로드 실패 (세그먼트 ${segLabel}, chunk ${i + 1}): ${await res.text()}`);
        }
      }

      // 2) prepare-segment — 청크 결합 + Gemini Files API 업로드
      els.processingText.textContent = `세그먼트 ${segLabel} 준비 중...`;
      const prepRes = await fetch('/api/process-meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Action': 'prepare-segment' },
        body: JSON.stringify({ sessionId, segmentIndex: seg.index, mimeType: seg.blob.type }),
      });
      if (!prepRes.ok) throw new Error(`세그먼트 ${segLabel} 준비 실패: ${await prepRes.text()}`);
      const prepData = await prepRes.json();

      // 3) check-file 폴링 — Gemini 파일 ACTIVE 대기
      let fileState = prepData.state;
      let fileUri = prepData.fileUri;
      let fileMimeType = prepData.fileMimeType;
      const maxPolls = 60; // 최대 2분
      for (let i = 0; i < maxPolls && fileState === 'PROCESSING'; i++) {
        els.processingText.textContent = `세그먼트 ${segLabel} AI 처리 중... (${i + 1}/${maxPolls})`;
        await new Promise((r) => setTimeout(r, 2000));
        const chkRes = await fetch('/api/process-meeting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Action': 'check-file' },
          body: JSON.stringify({ fileName: prepData.fileName }),
        });
        if (!chkRes.ok) throw new Error(`세그먼트 ${segLabel} 상태 확인 실패: ${await chkRes.text()}`);
        const chkData = await chkRes.json();
        fileState = chkData.state;
        fileUri = chkData.fileUri || fileUri;
        fileMimeType = chkData.fileMimeType || fileMimeType;
      }
      if (fileState !== 'ACTIVE') {
        throw new Error(`세그먼트 ${segLabel} Gemini 상태: ${fileState}`);
      }

      // 4) transcribe-segment — 5분 오디오 → transcript-NN.txt
      els.processingText.textContent = `세그먼트 ${segLabel} 전사 중...`;
      const trRes = await fetch('/api/process-meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Action': 'transcribe-segment' },
        body: JSON.stringify({
          sessionId,
          segmentIndex: seg.index,
          fileUri,
          fileMimeType,
          totalSegments,
        }),
      });
      if (!trRes.ok) throw new Error(`세그먼트 ${segLabel} 전사 실패: ${await trRes.text()}`);
    }

    // 5) merge-transcripts — transcript-NN.txt 전체 결합 → transcript.txt
    els.processingText.textContent = '전사문 병합 중...';
    const mrgRes = await fetch('/api/process-meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Action': 'merge-transcripts' },
      body: JSON.stringify({ sessionId, totalSegments }),
    });
    if (!mrgRes.ok) throw new Error(`전사문 병합 실패: ${await mrgRes.text()}`);

    // 6) summarize — 전사문 → 구조화 JSON 요약
    els.processingText.textContent = '회의록 요약 중...';
    const sumRes = await fetch('/api/process-meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Action': 'summarize' },
      body: JSON.stringify({
        sessionId,
        title: els.meetingTitle.value || null,
        meetingType: els.meetingType.value || null,
        durationSec: Math.floor((Date.now() - startedAt) / 1000),
      }),
    });
    if (!sumRes.ok) throw new Error(`요약 실패: ${await sumRes.text()}`);

    // 7) finalize-notion — Notion 페이지 생성 + 세션 폴더 정리
    els.processingText.textContent = 'Notion에 저장 중...';
    const res = await fetch('/api/process-meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Action': 'finalize-notion' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) throw new Error(`Notion 저장 실패: ${await res.text()}`);

    const data = await res.json();
    showResult(data);
  } catch (err) {
    showError(err.message || '알 수 없는 오류가 발생했습니다.');
  }
}

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
  els.meetingTitle.value = '';
  els.meetingType.value = '';
  els.timer.textContent = '00:00';
  state = 'idle';
  els.recBtn.classList.remove('hidden', 'recording');
  els.recLabel.textContent = '녹음 시작';
  els.recControls.classList.add('hidden');
  els.pauseLabel.textContent = '일시정지';
  setStatus('대기 중', false);
  els.hint.textContent = '시작 버튼을 누르면 마이크 권한을 요청합니다';
  showSection('recorder');
}

// 이벤트 바인딩
// recBtn은 idle 상태에서만 노출되므로 "녹음 시작" 전용.
els.recBtn.addEventListener('click', () => {
  if (state === 'idle') startRecording();
});

// pauseBtn은 상태에 따라 pause / resume 역할 토글.
els.pauseBtn.addEventListener('click', () => {
  if (state === 'recording') pauseRecording();
  else if (state === 'paused') resumeRecording();
});

// stopBtn: recording/paused 어느 상태에서도 즉시 종료 → processMeeting.
els.stopBtn.addEventListener('click', () => {
  if (state === 'recording' || state === 'paused') stopRecording();
});

els.newBtn.addEventListener('click', reset);
els.retryBtn.addEventListener('click', reset);

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
