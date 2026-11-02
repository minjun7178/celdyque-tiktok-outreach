# CELDYQUE TikTok Outreach

Lv4 이상 크리에이터를 50명 단위 태그로 관리하고, 보루피린·카퍼펩 두 상품의 Target Collaboration 초대장과 초대 후 개인 메시지를 공식 Chrome 화면으로 처리하는 독립 프로젝트입니다.

## 다른 Windows PC에서 시작

1. 이 비공개 저장소에 접근 가능한 GitHub 계정으로 clone합니다.
2. Codex에서 clone한 폴더를 프로젝트로 열고 **“시작해줘”**라고 입력합니다.
3. 프로젝트 지침에 따라 설치 상태를 확인하고, 필요하면 의존성을 설치합니다.
4. 전용 Chrome에서 TikTok 로그인·OTP·CAPTCHA를 직접 완료합니다.
5. 현재 설정 전체가 표시되면 수정할 항목을 알려주세요. 새 발송은 별도로 요청합니다.

직접 실행할 때:

```powershell
git clone https://github.com/minjun7178/celdyque-tiktok-outreach.git
cd celdyque-tiktok-outreach
powershell -ExecutionPolicy Bypass -File .\setup.ps1
npm.cmd start
npm.cmd run login
npm.cmd run config
```

`setup.ps1`은 Node.js 22.14 이상과 Google Chrome을 확인합니다. 없으면 winget에서 정확한 패키지를 확인해 설치하고 `npm ci`를 실행합니다. winget이 없는 PC는 Node.js와 Chrome을 먼저 설치한 뒤 다시 실행합니다. Codex 자체는 이 프로그램이 설치하지 않습니다.

## 현재 저장된 설정

| 항목 | 값 |
|---|---|
| 계정 | CELDYQUE US |
| 초대 이름 | `11.02` |
| 기간 | 2026-11-02 → **2026-12-07**, 35일 |
| 대상 | **Lv4 이상**, `lv4up1~41`, 태그당 최대 50명 |
| 보루피린 | `1731757173019480536`, 10ml × 2 번들 |
| 카퍼펩 | `1732507686646485464`, 30ml |
| 커미션 | 두 상품 모두 **Standard 50% / Shop Ads ON 15%** |
| 개인 메시지 | 포함 |
| 샘플 | 기존 상품별 설정 유지 |

본문과 메시지 원문은 `config.example.json`에 포함되어 있고 `npm run config`가 전체를 표시합니다. 설치 후 설정은 Git에서 제외된 **`.local/config.json`**에서 수정합니다. 프로그램이 날짜를 자동으로 바꾸지 않습니다. 시작일·기간·만료일이 서로 맞아야 합니다. Shop Ads 15%는 Open collaboration의 일반 커미션을 뜻하지 않습니다.

**현재 기본 캠페인은 이미 발송 완료했습니다.** 오늘 결과는 초대 41배치·2,019명, 개인 메시지 Share 1,689명(전송 확인 275명·제한 20명·미확인 1,394명)입니다. 이 설정으로 새 컴퓨터에서 다시 발송하지 않도록 완료 기록을 포함했습니다. 새 발송에는 새 campaign_id·실제 시작일·만료일·범위를 정합니다.

## 명령

| 명령 | 동작 |
|---|---|
| `npm run doctor` | Node·의존성 버전·Chrome 설치 확인 |
| `npm start` | 로컬 설정 초기 준비, 설치 상태와 현재 설정 표시; 발송 없음 |
| `npm run login` | 전용 Chrome 로그인 및 계정·Target Collaboration 접근 확인 |
| `npm run config` | 모든 현재 설정·문구 표시 |
| `npm run status` | 로컬 실행 상태 또는 완료 기록 조회; 발송 없음 |
| `npm run plan` | 승인된 새 캠페인 계획 생성; 발송 없음 |
| `npm run preflight` | 실제 계정·상품·문구·기간·커미션 확인; Send/Share/Save draft 차단 |
| `npm run send` | 당일 preflight와 설정 일치 확인 후, 정확한 CLI 확인 문구를 입력해야 발송 |
| `npm run tags:lv4:plan` | Manage creators의 읽기 전용 태깅 계획 |
| `npm run tags:lv4:run -- --apply --max-tags 2` | 별도 승인한 새 태깅의 두 태그 파일럿 |
| `npm test` | 로컬 fixture 회귀 테스트; TikTok 접속·발송 없음 |

대상 태그명·인원 스냅샷은 `data/lv4up-tags.json`에 있습니다. 실제 구성원과 현재 선택 가능 인원은 TikTok 화면에서 확인합니다. 스냅샷에는 creator 명단이 없으며, 기존 태깅 작업을 재개하는 체크포인트로 사용할 수 없습니다. 완료 태그가 이미 있는 계정에서 로컬 상태 없이 태깅을 다시 시작하면 중단될 수 있으므로 새 태깅을 임의로 실행하지 않습니다.

## 상태와 이식 범위

- `.local/campaigns/<campaign_id>/`: 계획·진행 상태·검증 결과·실행 증거.
- `.local/playwright-profile/`: 이 PC에서 새로 로그인한 Chrome 프로필. 다른 PC로 복사하거나 Git에 올리지 않습니다.
- `data/completed-campaigns.json`: 재발송 방지를 위한 완료 요약. 개인 명단은 없습니다.
- `UPSTREAM.json`: 원본에서 분리한 파일 목록과 최초 SHA-256. 이후 독립 프로젝트 수정은 Git 이력으로 관리합니다.

미완료 실행을 다른 PC로 옮길 때는 설정과 해당 캠페인의 로컬 체크포인트를 별도로 옮깁니다. Git clone은 원래 PC의 비공개 실행 증거를 복원하지 않습니다. `Send`나 `Share`를 이미 누른 배치는 미확인만을 이유로 재전송하지 않습니다. 부분 선택과 메시지 제한은 기록하고 계속하며, Share 인원과 실제 전달 확인 인원은 구분합니다.

아침 보고서·GMV 수집·EUKA·VIP Excel/CSV·SQLite·운영 웹 서버는 포함하지 않습니다. 다른 PC에서의 실제 TikTok 로그인과 전송 화면 검증은 그 PC에서 로그인한 뒤 수행해야 합니다.
