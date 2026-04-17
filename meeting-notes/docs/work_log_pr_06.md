### PR #6 — undici headers timeout 제거

**문제**: 63분 오디오 전사 시 Gemini 응답이 5분 넘게 걸려 Node 20의 fetch가 쓰는 undici의 기본 `headersTimeout`(300초)에 걸림.

**해결**:
```js
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
```
CLI 스크립트라 무제한 안전 (사용자가 Ctrl+C 가능).
