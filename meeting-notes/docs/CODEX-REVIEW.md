# Codex 리뷰 프로토콜

> 회의록 앱 리팩터링 단계마다 Codex에 **read-only 코드 리뷰**를 의뢰할 때 따르는 규칙.
> `/codex:rescue`(수정 가능)는 사용하지 않는다 — 진단/수정이 아니라 **보고서만** 받는다.

## 기본 규칙

1. **호출 경로**: `companion script` 를 Bash로 직접 실행한다 (옵션 B).
   - `/codex:review` 슬래시 커맨드는 `disable-model-invocation: true` 이므로 어시스턴트가 `Skill` 도구로 호출하지 못한다. 사용자가 직접 입력하거나, 어시스턴트가 아래 Bash 명령을 실행한다.
   - `/codex:rescue` 는 코드 수정까지 수행할 수 있어 **이 프로토콜에서는 금지**한다.

2. **Read-only**: Codex가 보고한 이슈를 어시스턴트가 **이 턴에서 고치지 않는다**. 출력을 사용자에게 verbatim으로 전달하고, 수정은 사용자가 명시적으로 지시한 뒤 별도 턴에서 진행한다.

3. **출력 원본 보존**: companion script의 stdout을 패러프레이즈/요약하지 않고 그대로 표시한다. 앞뒤 해설은 최소화.

## 호출 명령

```bash
node "C:/Users/code1412/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" review [옵션]
```

주요 옵션:

| 옵션 | 의미 |
|---|---|
| `--wait` | 포그라운드 실행, 결과를 기다림 (작은 변경 1–2 파일) |
| `--background` | 백그라운드 실행, 완료 시 알림 (대부분의 경우) |
| `--base <ref>` | 비교 기준 브랜치/커밋 (예: `--base main`) |
| `--scope auto\|working-tree\|branch` | 리뷰 범위 (기본 auto) |

### 실행 모드 결정

- 변경 규모가 **1–2 파일로 확실히 작은 경우에만** `--wait`
- 그 외 전부 `--background` (모호할 때도 백그라운드)
- 실행 후 사용자에게 "Codex 리뷰 백그라운드 시작. `/codex:status` 로 진행 확인" 안내

### 진행/취소 확인

- 진행 상황: `/codex:status`
- 결과 수신: `/codex:result`
- 취소: `/codex:cancel`

## Phase 리뷰 전 체크리스트

각 Phase 종료 시 아래 순서로 실행:

1. `git status` 로 working tree 정리 (uncommitted 변경 없음 확인)
2. `npm test` 로 단위 테스트 통과 확인
3. 아래 명령으로 Codex 리뷰 호출 (대부분 background):

```bash
node "C:/Users/code1412/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" review --background --base main
```

4. Codex 리뷰 수신 후 이슈를 별도 커밋으로 반영 (Codex 출력 자체를 커밋 메시지 본문에 인용 가능)
5. 다음 Phase 진입

## 왜 이 규칙인가

- **rescue vs review**: rescue는 편리하지만 자동 수정이 가능해 의도치 않은 변경 위험이 있음. 리팩터링 같은 구조적 변경 검증 단계에서는 **사람이 수정을 게이트**하는 편이 안전.
- **백그라운드 우선**: 포그라운드 대기는 컨텍스트를 점유하고 캐시 TTL을 낭비함. 백그라운드는 `/codex:status` 로 언제든 확인 가능.
- **verbatim 전달**: Codex의 톤·용어가 코드 리뷰 품질의 일부. 패러프레이즈는 근거 위치 링크가 끊길 수 있어 피함.

## 참고

- Codex CLI 준비 상태 점검: `/codex:setup`
- 명령 정의 원본: `C:/Users/code1412/.claude/plugins/cache/openai-codex/codex/1.0.3/commands/review.md`
- 커스텀 지시 / 적대적 리뷰가 필요하면 `/codex:adversarial-review` (이 프로토콜 범위 밖)
