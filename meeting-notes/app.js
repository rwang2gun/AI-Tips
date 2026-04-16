// 회의록 자동 생성기 — 클라이언트 로직
// MediaRecorder로 녹음 → 청크 분할 업로드 → /api/process-meeting 처리

const MAX_CHUNK_SIZE = 3.5 * 1024 * 1024; // 3.5MB (Vercel 4.5MB 한도 여유)

const els = {
  recBtn: document.getElementById('recBtn'),
  recLabel: document.getElementById('recLabel'),
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

let mediaRecorder = null;
let stream = null;
let audioChunks = [];
let startedAt = 0;
let timerInterval = null;
let audioCtx = null;
let analyser = null;
let vizFrame = null;

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

  // MediaRecorder 시작 (브라우저별 호환 코덱 시도)
  const mimeOptions = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  const mimeType = mimeOptions.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const opts = mimeType ? { mimeType, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 };

  mediaRecorder = new MediaRecorder(stream, opts);
  audioChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    stopVisualizer();
    const blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
    await processMeeting(blob);
  };

  mediaRecorder.start(1000); // 1초마다 데이터 fire
  startedAt = Date.now();
  els.timer.textContent = '00:00';
  timerInterval = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    els.timer.textContent = fmtTime(elapsed);
  }, 500);

  els.recBtn.classList.add('recording');
  els.recLabel.textContent = '녹음 종료';
  setStatus('녹음 중', true);
  els.hint.textContent = '한 번 더 누르면 종료되고 자동으로 회의록이 생성됩니다';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  if (timerInterval) clearInterval(timerInterval);

  els.recBtn.classList.remove('recording');
  els.recLabel.textContent = '녹음 시작';
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

async function processMeeting(blob) {
  showSection('processing');
  els.processingText.textContent = '오디오 업로드 중...';

  try {
    const sessionId = crypto.randomUUID();
    const totalChunks = Math.ceil(blob.size / MAX_CHUNK_SIZE);

    // 청크 분할 업로드
    for (let i = 0; i < totalChunks; i++) {
      const chunk = blob.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
      els.processingText.textContent = `업로드 중 (${i + 1}/${totalChunks})...`;

      const res = await fetch('/api/process-meeting', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Action': 'upload-chunk',
          'X-Session-Id': sessionId,
          'X-Chunk-Index': String(i),
          'X-Total-Chunks': String(totalChunks),
          'X-Mime-Type': blob.type,
        },
        body: chunk,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`업로드 실패 (chunk ${i + 1}): ${err}`);
      }
    }

    // 1) prepare — 청크 결합 + Gemini Files API 업로드
    els.processingText.textContent = '오디오 준비 중...';
    const prepRes = await fetch('/api/process-meeting', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Action': 'prepare',
      },
      body: JSON.stringify({
        sessionId,
        mimeType: blob.type,
      }),
    });

    if (!prepRes.ok) {
      const err = await prepRes.text();
      throw new Error(`준비 실패: ${err}`);
    }

    const prepData = await prepRes.json();

    // 2) check-file — Gemini 파일이 ACTIVE 될 때까지 폴링
    let fileState = prepData.state;
    let fileUri = prepData.fileUri;
    let fileMimeType = prepData.fileMimeType;
    const maxPolls = 60; // 최대 2분 (2초 간격)
    for (let i = 0; i < maxPolls && fileState === 'PROCESSING'; i++) {
      els.processingText.textContent = `AI 파일 처리 중... (${i + 1}/${maxPolls})`;
      await new Promise((r) => setTimeout(r, 2000));
      const chkRes = await fetch('/api/process-meeting', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Action': 'check-file',
        },
        body: JSON.stringify({ fileName: prepData.fileName }),
      });
      if (!chkRes.ok) {
        const err = await chkRes.text();
        throw new Error(`파일 상태 확인 실패: ${err}`);
      }
      const chkData = await chkRes.json();
      fileState = chkData.state;
      fileUri = chkData.fileUri || fileUri;
      fileMimeType = chkData.fileMimeType || fileMimeType;
    }

    if (fileState !== 'ACTIVE') {
      throw new Error(`Gemini 파일 상태: ${fileState}`);
    }

    // 3) transcribe — 오디오 → 한국어 전사문 (Blob에 저장)
    els.processingText.textContent = 'AI가 회의 내용을 받아적는 중...';
    const trRes = await fetch('/api/process-meeting', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Action': 'transcribe',
      },
      body: JSON.stringify({ sessionId, fileUri, fileMimeType }),
    });
    if (!trRes.ok) throw new Error(`전사 실패: ${await trRes.text()}`);

    // 4) summarize — 전사문 → 구조화 JSON 요약 (Blob에 저장)
    els.processingText.textContent = '회의록 요약 중...';
    const sumRes = await fetch('/api/process-meeting', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Action': 'summarize',
      },
      body: JSON.stringify({
        sessionId,
        title: els.meetingTitle.value || null,
        meetingType: els.meetingType.value || null,
        durationSec: Math.floor((Date.now() - startedAt) / 1000),
      }),
    });
    if (!sumRes.ok) throw new Error(`요약 실패: ${await sumRes.text()}`);

    // 5) finalize-notion — Notion 페이지 생성 + 세션 폴더 정리
    els.processingText.textContent = 'Notion에 저장 중...';
    const res = await fetch('/api/process-meeting', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Action': 'finalize-notion',
      },
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
  setStatus('대기 중', false);
  els.hint.textContent = '시작 버튼을 누르면 마이크 권한을 요청합니다';
  showSection('recorder');
}

// 이벤트 바인딩
els.recBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    startRecording();
  }
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
